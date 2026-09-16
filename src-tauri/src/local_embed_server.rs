// 本地嵌入服务托管:应用自动拉起/探活/停止 llama-server(llama.cpp),专用于冷记忆
// 本地嵌入(方案:docs/经历记忆本地嵌入设计方案.md「自动启动」章节)。
//
// 职责边界:
//   · 只管「应用托管的」那个 llama-server;用户手动另起的服务不走这里(managed=off
//     时 cold_local_gate 放行到配置地址)。托管实例就绪时代理解析优先它(current_base)。
//   · 启动参数固定带 --embeddings(新版拼写,把服务限制为只做嵌入);早退即换旧版
//     --embedding 重试一次。模型必须是专用 embedding 模型(带 pooling 头)——对话
//     模型出不了有效向量,设置页与设计文档都明确建议。
//   · 端口用临时空闲端口,避免与手动服务冲突。托管模式三态:off=手动不碰;boot=
//     随应用启动拉起;lazy=按需拉起——嵌入请求发现没跑就后台拉起,本次请求返回
//     可读错误(fail-open 照旧),就绪自愈,用户无感知。
//   · 冷却窗:启动失败后 60s 内不再因请求反复拉起(防坏配置拉起循环);设置页手动
//     启动不受限。生命周期:应用退出杀子进程(lib.rs RunEvent::Exit);崩溃不立即
//     自动重启(避免崩溃循环),但 boot/lazy 模式下一次请求会再触发。

use std::io::Read;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

/// 探活间隔与总预算:embedding 模型体积小(几十 MB 级),加载通常秒级;120s 覆盖
/// 慢盘/杀毒扫描的尾部
const HEALTH_INTERVAL: Duration = Duration::from_millis(400);
const HEALTH_BUDGET: Duration = Duration::from_secs(120);
/// 旗标回退判定窗:llama-server 参数拼错会在启动瞬间退出;3s 内退出视为「不接受该
/// 拼写」,换另一个拼写重试一次(模型路径错也会早退,多花一次失败,最终报第二次 stderr)
const EARLY_EXIT_WINDOW: Duration = Duration::from_secs(3);
/// stderr 截尾:失败时设置页直接看到 llama-server 的报错(如缺 pooling 头提示)
const STDERR_TAIL: usize = 4000;
/// Windows 下不弹控制台窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 托管状态字:stopped / starting / ready / failed(与前端 EmbedServerState 对齐)
const ST_STOPPED: &str = "stopped";
const ST_STARTING: &str = "starting";
const ST_READY: &str = "ready";
const ST_FAILED: &str = "failed";

struct Managed {
  child: Child,
  port: u16,
  stderr_tail: Arc<Mutex<String>>,
}

// 模块级全局态:current_base 要被 endpoint_proxy 无句柄调用,不走 Tauri manage
static SERVER: Mutex<Option<Managed>> = Mutex::new(None);
static STATUS: Mutex<(String, Option<String>)> = Mutex::new((String::new(), None));
/// 就绪后的服务端口;0 = 无就绪实例(探活通过才置位,进程退出/停止即清零)
static READY_PORT: AtomicU16 = AtomicU16::new(0);
/// start 进行中去重(设置页命令、启动自拉起与请求路径拉起并发)
static SPAWNING: AtomicBool = AtomicBool::new(false);
/// 最近一次启动失败时刻(请求路径拉起的冷却窗基准)
static LAST_START_FAIL: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// 托管模式:'off' 手动 / 'boot' 随应用启动 / 'lazy' 按需拉起
fn managed_mode_of(cold: &Value) -> &'static str {
  // 老配置布尔 autoStart:true 迁移为 boot(managed 缺失或非法时)
  let legacy_boot = cold.get("autoStart").and_then(Value::as_bool) == Some(true);
  match cold.get("managed").and_then(Value::as_str) {
    Some("boot") => "boot",
    Some("lazy") => "lazy",
    _ => {
      if legacy_boot {
        "boot"
      } else {
        "off"
      }
    }
  }
}

/// 托管路径三要素(serverPath/modelPath/extraArgs);缺任一必填项返回 None
fn managed_paths_of(cold: &Value) -> Option<(String, String, String)> {
  let trim = |key: &str| -> Option<String> {
    cold
      .get(key)
      .and_then(Value::as_str)
      .map(str::trim)
      .filter(|s| !s.is_empty())
      .map(str::to_string)
  };
  let server = trim("serverPath")?;
  let model = trim("modelPath")?;
  let extra = trim("extraArgs").unwrap_or_default();
  Some((server, model, extra))
}

fn is_local_provider(cold: &Value) -> bool {
  cold.get("provider").and_then(Value::as_str) == Some("local")
}

/// 启动旗标拼写:新版 llama.cpp 用复数形式(限定服务只做嵌入),旧版单数;
/// 参数不认识会启动即退,按早退窗判定后换拼写重试
#[derive(Clone, Copy, PartialEq, Eq)]
enum EmbedFlag {
  Plural,
  Singular,
}

impl EmbedFlag {
  const BOTH: [EmbedFlag; 2] = [EmbedFlag::Plural, EmbedFlag::Singular];
  const fn as_arg(self) -> &'static str {
    match self {
      EmbedFlag::Plural => "--embeddings",
      EmbedFlag::Singular => "--embedding",
    }
  }
}

/// 启动参数:模型 + 限定只做嵌入 + 回环地址 + 临时端口 + 用户额外参数。
/// 额外参数放最后,用户可补行为(如缺 pooling 头的模型加 --pooling mean)
fn server_args(model_path: &str, port: u16, flag: EmbedFlag, extra: &str) -> Vec<String> {
  let mut args = vec![
    "-m".to_string(),
    model_path.to_string(),
    flag.as_arg().to_string(),
    "--host".to_string(),
    "127.0.0.1".to_string(),
    "--port".to_string(),
    port.to_string(),
  ];
  args.extend(split_extra(extra));
  args
}

/// 额外参数分词:按空白切;双引号段保留内部空白(Windows 路径常带空格)
fn split_extra(extra: &str) -> Vec<String> {
  let mut out: Vec<String> = Vec::new();
  let mut cur = String::new();
  let mut in_quote = false;
  for c in extra.chars() {
    match c {
      '"' => in_quote = !in_quote,
      c if c.is_whitespace() && !in_quote => {
        if !cur.is_empty() {
          out.push(std::mem::take(&mut cur));
        }
      }
      c => cur.push(c),
    }
  }
  if !cur.is_empty() {
    out.push(cur);
  }
  out
}

fn free_port() -> Result<u16, String> {
  TcpListener::bind(("127.0.0.1", 0))
    .map_err(|e| format!("分配临时端口失败: {e}"))?
    .local_addr()
    .map(|a| a.port())
    .map_err(|e| format!("读取临时端口失败: {e}"))
}

fn set_status(status: &str, last_error: Option<String>) {
  *STATUS.lock().expect("状态锁") = (status.to_string(), last_error);
}

fn stderr_text(tail: &Arc<Mutex<String>>) -> String {
  tail.lock().expect("stderr 锁").trim().to_string()
}

/// 单次拉起尝试:接管 stderr 并起收集线程(留环形截尾,失败时给设置页看)
struct Attempt {
  child: Child,
  stderr_tail: Arc<Mutex<String>>,
  collector: std::thread::JoinHandle<()>,
}

fn attempt_spawn(server_path: &str, args: &[String]) -> Result<Attempt, String> {
  let mut cmd = Command::new(server_path);
  cmd
    .args(args)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  let mut child = cmd
    .spawn()
    .map_err(|e| format!("无法启动 llama-server({e})"))?;
  let mut pipe = child
    .stderr
    .take()
    .ok_or("无法接管 llama-server 的 stderr")?;
  let tail = Arc::new(Mutex::new(String::new()));
  let sink = tail.clone();
  let collector = std::thread::spawn(move || {
    let mut buf = [0u8; 1024];
    let mut all: Vec<u8> = Vec::new();
    loop {
      match pipe.read(&mut buf) {
        Ok(0) | Err(_) => break,
        Ok(n) => {
          all.extend_from_slice(&buf[..n]);
          if all.len() > STDERR_TAIL {
            let cut = all.len() - STDERR_TAIL;
            all.drain(..cut);
          }
        }
      }
    }
    if let Ok(s) = String::from_utf8(all) {
      *sink.lock().expect("stderr 锁") = s;
    }
  });
  Ok(Attempt {
    child,
    stderr_tail: tail,
    collector,
  })
}

/// 早退判定:窗口内退出(参数不认识/模型路径错都算)返回 true
async fn exited_early(child: &mut Child) -> bool {
  let deadline = Instant::now() + EARLY_EXIT_WINDOW;
  loop {
    if matches!(child.try_wait(), Ok(Some(_))) {
      return true;
    }
    if Instant::now() >= deadline {
      return false;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
  }
}

/// 读应用配置(endpoint_proxy 同款:内存态优先,回退 config.json 文件)
fn read_config(app: &AppHandle) -> Result<Value, String> {
  crate::endpoint_proxy::committed_or_file_config(app)
}

/// 托管实例就绪后的代理解析地址;无就绪实例返回 None(走配置地址)
pub fn current_base() -> Option<String> {
  let port = READY_PORT.load(Ordering::Acquire);
  (port != 0).then(|| format!("http://127.0.0.1:{port}/v1"))
}

/// 杀掉并清走当前实例(不动状态字;状态由调用方定)
fn kill_slot() {
  if let Some(mut managed) = SERVER.lock().expect("服务锁").take() {
    let _ = managed.child.kill();
    let _ = managed.child.wait();
  }
  READY_PORT.store(0, Ordering::Release);
}

/// 停止:杀实例并把状态归 stopped
pub fn stop_running() {
  kill_slot();
  set_status(ST_STOPPED, None);
}

/// 守护轮询里的一跳:Alive=继续;Gone=进程自己退了;Cleared=被 stop 清走
enum WatchTick {
  Alive,
  Gone,
  Cleared,
}

fn watch_tick() -> WatchTick {
  let mut guard = SERVER.lock().expect("服务锁");
  match guard.as_mut() {
    None => WatchTick::Cleared,
    Some(managed) => {
      if matches!(managed.child.try_wait(), Ok(Some(_))) {
        WatchTick::Gone
      } else {
        WatchTick::Alive
      }
    }
  }
}

fn lifecycle_stderr() -> String {
  let guard = SERVER.lock().expect("服务锁");
  match guard.as_ref() {
    Some(managed) => stderr_text(&managed.stderr_tail),
    None => String::new(),
  }
}

/// 生命周期任务:探活(等模型加载)→ 置就绪 → 守护(进程退出即置 failed)。
/// 崩溃不自动重启:避免坏模型/坏参数陷入崩溃循环,交给设置页一键重启
fn spawn_lifecycle(port: u16) {
  tauri::async_runtime::spawn(async move {
    let client = match reqwest::Client::builder()
      .timeout(Duration::from_secs(2))
      .build()
    {
      Ok(c) => c,
      Err(_) => {
        set_status(ST_FAILED, Some("健康检查客户端构建失败".into()));
        return;
      }
    };
    let health_url = format!("http://127.0.0.1:{port}/health");
    let deadline = Instant::now() + HEALTH_BUDGET;
    let mut ready = false;
    while Instant::now() < deadline {
      match watch_tick() {
        WatchTick::Cleared => return, // stop() 已置 stopped
        WatchTick::Gone => {
          let tail = lifecycle_stderr();
          READY_PORT.store(0, Ordering::Release);
          set_status(ST_FAILED, Some(format!("llama-server 就绪前退出:{tail}")));
          return;
        }
        WatchTick::Alive => {}
      }
      if let Ok(resp) = client.get(&health_url).send().await {
        if resp.status().as_u16() == 200 {
          ready = true;
          break;
        }
      }
      tokio::time::sleep(HEALTH_INTERVAL).await;
    }
    if !ready {
      set_status(
        ST_FAILED,
        Some("健康检查超时:模型迟迟没加载完,请核对模型是否为专用 embedding 模型".into()),
      );
      kill_slot();
      return;
    }
    READY_PORT.store(port, Ordering::Release);
    set_status(ST_READY, None);
    log::info!("本地嵌入服务就绪: port={port}");
    loop {
      tokio::time::sleep(Duration::from_millis(500)).await;
      match watch_tick() {
        WatchTick::Alive => {}
        WatchTick::Cleared => return,
        WatchTick::Gone => {
          let tail = lifecycle_stderr();
          READY_PORT.store(0, Ordering::Release);
          set_status(ST_FAILED, Some(format!("llama-server 进程退出:{tail}")));
          return;
        }
      }
    }
  });
}

/// 启动(重启语义:先清旧实例)。成功后状态 starting→ready 由生命周期任务推进;
/// 失败置 failed 并带 stderr 截尾,同时记录失败时刻(请求路径拉起的冷却窗基准)
pub async fn start_managed(app: AppHandle) -> Result<(), String> {
  if SPAWNING.swap(true, Ordering::AcqRel) {
    return Err("本地嵌入服务已在启动中".into());
  }
  let result = start_inner(&app).await;
  if result.is_err() {
    *LAST_START_FAIL.lock().expect("冷却锁") = Some(Instant::now());
  }
  SPAWNING.store(false, Ordering::Release);
  result
}

async fn start_inner(app: &AppHandle) -> Result<(), String> {
  let cfg = read_config(app)?;
  let cold = cfg.get("coldMemory").cloned().unwrap_or(Value::Null);
  let Some((server_path, model_path, extra)) = managed_paths_of(&cold) else {
    return Err("请先填写 llama-server 程序路径与 embedding 模型路径".into());
  };

  stop_running();
  set_status(ST_STARTING, None);
  let port = free_port()?;

  let mut last_stderr = String::new();
  for flag in EmbedFlag::BOTH {
    let args = server_args(&model_path, port, flag, &extra);
    let attempt = attempt_spawn(&server_path, &args)?;
    let Attempt {
      mut child,
      stderr_tail,
      collector,
    } = attempt;
    if !exited_early(&mut child).await {
      // 进程存活 = 接受该拼写;交棒生命周期任务(探活 + 守护)。
      // pid 的 Debug 打印同时兼容新旧 std 的 id() 返回类型
      log::info!(
        "本地嵌入服务已拉起: port={port} flag={} pid={:?}",
        flag.as_arg(),
        child.id()
      );
      *SERVER.lock().expect("服务锁") = Some(Managed {
        child,
        port,
        stderr_tail,
      });
      spawn_lifecycle(port);
      return Ok(());
    }
    // 早退:等收集线程到 EOF 拿全报错(进程已死,管道随即关闭,join 有界)
    last_stderr = tauri::async_runtime::spawn_blocking(move || {
      let _ = collector.join();
      stderr_text(&stderr_tail)
    })
    .await
    .unwrap_or_default();
  }
  let shown = if last_stderr.is_empty() {
    "llama-server 启动即退出(无 stderr;请核对程序路径与模型路径)".to_string()
  } else {
    last_stderr
  };
  set_status(ST_FAILED, Some(shown.clone()));
  Err(format!("llama-server 启动失败:{shown}"))
}

/// 请求路径拉起的冷却窗:失败后 60s 内不因请求反复拉起(防坏配置拉起循环);
/// 设置页手动启动不走此闸
const LAZY_RETRY_COOLDOWN: Duration = Duration::from_secs(60);

/// 冷却判定(纯函数,elapsed = 距上次启动失败的时长;None = 从未失败)
fn lazy_cooldown_ok(elapsed: Option<Duration>) -> bool {
  elapsed.map_or(true, |d| d >= LAZY_RETRY_COOLDOWN)
}

/// coldLocal 请求闸门(代理在 current_base 未命中时调用):
///   Ready(base)   托管实例就绪(极端竞态下重新拿到),代理直接用它
///   Manual        手动模式(off):代理回退配置地址
///   Refuse(msg)   拒绝本次请求并给出可读错误(启动中/冷却/配置不全);
///                 lazy/boot 且配置齐全时顺带后台拉起——本次失败 fail-open,就绪自愈
pub enum ColdLocalGate {
  Ready(String),
  Manual,
  Refuse(String),
}

pub fn cold_local_gate(app: &AppHandle) -> ColdLocalGate {
  if let Some(base) = current_base() {
    return ColdLocalGate::Ready(base);
  }
  let cold = read_config(app)
    .ok()
    .and_then(|cfg| cfg.get("coldMemory").cloned())
    .unwrap_or(Value::Null);
  // 手动模式:没托管的份,配置地址说话
  if !is_local_provider(&cold) || managed_mode_of(&cold) == "off" {
    return ColdLocalGate::Manual;
  }
  let (status, _) = STATUS.lock().expect("状态锁").clone();
  if status == ST_STARTING {
    return ColdLocalGate::Refuse("本地嵌入服务正在后台启动,本次先略过,稍后自动恢复".into());
  }
  // stopped/failed:冷却窗内不反复拉起(坏配置防循环);窗外且路径齐全就再试一次
  let elapsed = LAST_START_FAIL
    .lock()
    .expect("冷却锁")
    .map(|t| t.elapsed());
  if !lazy_cooldown_ok(elapsed) {
    return ColdLocalGate::Refuse(
      "本地嵌入服务最近一次启动失败,冷却中(约 1 分钟后自动重试,或到设置页手动启动看报错)".into(),
    );
  }
  if managed_paths_of(&cold).is_none() {
    return ColdLocalGate::Refuse("请先在设置里填写 llama-server 程序路径与 embedding 模型路径".into());
  }
  tauri::async_runtime::spawn(start_managed(app.clone()));
  ColdLocalGate::Refuse("本地嵌入服务正在后台启动,本次先略过,稍后自动恢复".into())
}

/// 应用启动自拉起:managed=boot 且路径齐全才动手;失败只记日志(fail-open,
/// 绝不影响应用启动——lazy 模式会在首条嵌入请求时再拉)
pub async fn auto_start_if_configured(app: AppHandle) {
  let cfg = match read_config(&app) {
    Ok(v) => v,
    Err(_) => return,
  };
  let cold = cfg.get("coldMemory").cloned().unwrap_or(Value::Null);
  if !is_local_provider(&cold) || managed_mode_of(&cold) != "boot" {
    return;
  }
  if managed_paths_of(&cold).is_none() {
    return; // 路径没配齐:静默跳过,设置页状态可见
  }
  log::info!("本地嵌入服务随应用启动拉起");
  if let Err(e) = start_managed(app).await {
    log::warn!("本地嵌入服务自动启动失败(经历记忆停用): {e}");
  }
}

/// 应用退出清理(lib.rs RunEvent::Exit)
pub fn shutdown() {
  kill_slot();
}

// ---------- Tauri 命令 ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmbedServerStatus {
  pub status: String,
  pub port: Option<u16>,
  pub last_error: Option<String>,
}

fn current_status() -> EmbedServerStatus {
  let guard = SERVER.lock().expect("服务锁");
  let (status, last_error) = STATUS.lock().expect("状态锁").clone();
  EmbedServerStatus {
    status,
    port: guard.as_ref().map(|m| m.port),
    last_error: last_error.filter(|s| !s.is_empty()),
  }
}

#[tauri::command]
pub fn local_embed_status() -> EmbedServerStatus {
  current_status()
}

#[tauri::command]
pub async fn local_embed_start(app: AppHandle) -> Result<EmbedServerStatus, String> {
  start_managed(app).await?;
  Ok(current_status())
}

#[tauri::command]
pub fn local_embed_stop() -> Result<EmbedServerStatus, String> {
  stop_running();
  Ok(current_status())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn server_args_limits_to_embedding_only() {
    let args = server_args("D:\\m\\bge.gguf", 54321, EmbedFlag::Plural, "");
    assert_eq!(
      args,
      [
        "-m",
        "D:\\m\\bge.gguf",
        "--embeddings",
        "--host",
        "127.0.0.1",
        "--port",
        "54321"
      ]
      .map(String::from)
    );
    // 旧版拼写回退
    let legacy = server_args("/x/bge.gguf", 8080, EmbedFlag::Singular, "");
    assert_eq!(legacy[2], "--embedding");
  }

  #[test]
  fn server_args_appends_extra_after_defaults() {
    let args = server_args("m.gguf", 1, EmbedFlag::Plural, "--pooling mean -v");
    assert_eq!(&args[7..], ["--pooling", "mean", "-v"].map(String::from).as_slice());
  }

  #[test]
  fn split_extra_handles_quotes_and_whitespace() {
    assert!(split_extra("").is_empty());
    assert!(split_extra("   ").is_empty());
    assert_eq!(
      split_extra("--pooling mean"),
      ["--pooling", "mean"].map(String::from)
    );
    // 双引号段保留内部空白(带空格的路径)
    assert_eq!(
      split_extra(r#"-m "D:\My Models\b.gguf""#),
      ["-m", "D:\\My Models\\b.gguf"].map(String::from)
    );
    assert_eq!(split_extra(r#""a b"c d"#), ["a bc", "d"].map(String::from));
  }

  #[test]
  fn managed_mode_reads_new_field_and_migrates_legacy_boolean() {
    // 新枚举直读
    let m: Value = serde_json::from_str(r#"{"provider":"local","managed":"lazy"}"#).unwrap();
    assert_eq!(managed_mode_of(&m), "lazy");
    let b: Value = serde_json::from_str(r#"{"provider":"local","managed":"boot"}"#).unwrap();
    assert_eq!(managed_mode_of(&b), "boot");
    // 老布尔 autoStart:true → boot;缺省 → off
    let legacy: Value = serde_json::from_str(r#"{"provider":"local","autoStart":true}"#).unwrap();
    assert_eq!(managed_mode_of(&legacy), "boot");
    let off: Value = serde_json::from_str(r#"{"provider":"local"}"#).unwrap();
    assert_eq!(managed_mode_of(&off), "off");
  }

  #[test]
  fn managed_paths_requires_both_paths_and_trims_extra() {
    let full: Value = serde_json::from_str(
      r#"{"provider":"local","managed":"lazy",
        "serverPath":"D:/tools/llama-server.exe","modelPath":"D:/m/bge.gguf","extraArgs":" --pooling mean "}"#,
    )
    .unwrap();
    let (server, model, extra) = managed_paths_of(&full).unwrap();
    assert_eq!(server, "D:/tools/llama-server.exe");
    assert_eq!(model, "D:/m/bge.gguf");
    assert_eq!(extra, "--pooling mean");

    // 缺模型路径不托管
    let no_model: Value = serde_json::from_str(
      r#"{"provider":"local","serverPath":"x"}"#,
    )
    .unwrap();
    assert!(managed_paths_of(&no_model).is_none());
    assert!(is_local_provider(&full));
    assert!(is_local_provider(&no_model)); // local 但缺路径
    let endpoint: Value = serde_json::from_str(r#"{"provider":"endpoint"}"#).unwrap();
    assert!(!is_local_provider(&endpoint));
  }

  #[test]
  fn lazy_cooldown_blocks_within_window_only() {
    assert!(lazy_cooldown_ok(None)); // 从未失败
    assert!(!lazy_cooldown_ok(Some(Duration::from_secs(1))));
    assert!(lazy_cooldown_ok(Some(LAZY_RETRY_COOLDOWN)));
    assert!(lazy_cooldown_ok(Some(
      LAZY_RETRY_COOLDOWN + Duration::from_secs(1)
    )));
  }
}
