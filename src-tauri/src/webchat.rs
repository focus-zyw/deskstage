// 网页版生成通道 · Plan B:CDP 驱动系统 Edge(全链路在 Rust 侧)。
//
// 为什么不用应用内嵌第二 WebView2:本机实测四连败——独立 profile 白屏、共享环境
// 白屏、诊断离线页(回环纯本地 HTML)也一帧画不出、历史截屏窗 0x8007139F。
// 渲染层在本应用的第二 WebView 上是坏的,无法修复,故改为遥控系统已装 Edge:
//   Edge(独立 --user-data-dir,不影响日常浏览)+ --remote-debugging-port=0
//   → Rust 经 CDP(纯 WebSocket)开标签页/注入 prompt/抓回复(站点脚本见 webchat/sites.rs)。
// 登录 cookie 持久化在 webchat-edge-profile 目录,一次登录长期使用。
//
// 安全模型(相对旧"前端直连 9223"方案的变化):
//   · 调试端口由内核自选(port=0),实际端口与浏览器级 WS 路径从专用 profile 的
//     DevToolsActivePort 文件读取——不再固定 9223,也没有"预占端口后释放"的抢占窗口
//   · 连接方是本进程 Rust(WS 握手不带 Origin 头),Chromium 111+ 的
//     --remote-allow-origins 防线不再需要放开,已彻底移除该参数:
//     本机浏览器里的恶意网页(带 Origin)连调试端口依旧会被 403
//   · CDP 报文与站点选择器不进前端代码,前端只剩 invoke 薄封装
//
// 生命周期语义:
//   · 同一时刻只允许一个 ask(占用槽;第二个请求立即报"已有生成在进行中")
//   · 前端为每次 ask 生成 requestId;取消经 webchat_cancel 置标记,轮询间隙生效
//   · 页面导航销毁上下文 → 自动重连同一标签页;标签页被关则重找/重建后重连,
//     轮询状态(见过生成中/稳定计时)保留
//   · ask 结束(成功/失败/取消/超时)统一清理:释放占用槽、恢复主覆盖层显示
//   · App 退出时(lib.rs RunEvent::Exit)杀掉专用 profile 的 Edge,不碰日常浏览
//
// 取消延迟上限:轮询间隙与单次 evaluate 超时(8s)之间,最长约 8~9 秒生效;
// 发送阶段(最长 60s)内取消同样在阶段边界生效——评估为可接受,不为它上 select。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::net::TcpStream as TokioTcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub mod sites;
use sites::adapter;

const MAIN_LABEL: &str = "main";
/// 单次 ask 总超时默认值(与旧前端默认一致;前端可传 timeoutMs 覆盖)
const ASK_TIMEOUT_SECS: u64 = 180;
/// Edge 冷启/重启后调试通道就绪窗口
const EDGE_READY_SECS: u64 = 20;
/// 回复文本稳定判定窗(移植 web-tool)
const STABLE_MS: u64 = 2500;
/// 取消错误的固定文案(前端据此还原为 AbortError,保持旧取消语义)
const CANCELLED: &str = "已取消";

type WsStream = WebSocketStream<MaybeTlsStream<TokioTcpStream>>;

/// ask 并发与取消标记(进程内;并发 = 1,与 UI 单生成槽一致)
#[derive(Default)]
pub struct AskState {
    inflight: Mutex<Option<String>>,
    cancelled: Mutex<HashSet<String>>,
}

fn find_edge() -> Result<&'static str, String> {
    const CANDIDATES: [&str; 2] = [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    for c in CANDIDATES {
        if Path::new(c).exists() {
            return Ok(c);
        }
    }
    Err("找不到 Edge(msedge.exe):本方案依赖系统自带的 Edge 浏览器".into())
}

fn profile_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("webchat-edge-profile"))
}

/// 只杀我们 profile 的 Edge 实例(按命令行里的目录名过滤),绝不碰用户日常浏览的 Edge。
/// pub:lib.rs 在 RunEvent::Exit 时也调用,保证退出不留后台调试实例
pub fn kill_profile_edge() {
    let ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*webchat-edge-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", ps])
        .output();
}

fn launch_edge(profile: &Path, url: &str) -> Result<(), String> {
    use std::process::Stdio;
    let exe = find_edge()?;
    std::fs::create_dir_all(profile).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.display()))
        .args([
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=960,760",
        ]);
    // stdio 接 null:Edge 生命周期远长于调用方,若继承 stdout/stderr 管道,
    // 读管道的一侧(cargo test / tauri dev 终端)会因等不到 EOF 卡死
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.arg(url);
    cmd.spawn()
        .map_err(|e| format!("启动 Edge 失败({exe}): {e}"))?;
    Ok(())
}

/// DevToolsActivePort(Chromium 官方机制):首行 = 实际调试端口,次行 = 浏览器级 WS 路径
fn read_devtools(profile: &Path) -> Option<(u16, String)> {
    let text = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    let mut lines = text.lines();
    let port = lines.next()?.trim().parse().ok()?;
    let path = lines.next()?.trim().to_string();
    Some((port, path))
}

async fn connect_ws(url: String) -> Result<WsStream, String> {
    let (ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|e| format!("连接 Edge 调试通道失败: {e}"))?;
    Ok(ws)
}

/// 主覆盖层开关:登录/生成期间角色隐藏让路(全屏置顶层会挡住 Edge 与点击)
fn show_main<R: tauri::Runtime>(app: &AppHandle<R>, show: bool) {
    if let Some(m) = app.get_webview_window(MAIN_LABEL) {
        if show {
            let _ = m.show();
        } else {
            let _ = m.hide();
        }
    }
}

#[tauri::command]
pub fn webchat_main_visible(app: AppHandle, show: bool) {
    show_main(&app, show);
}

/// 拉起可见的 Edge 窗口给用户登录(隐藏主覆盖层让路)。
/// 先杀旧实例再启动,保证端口/参数全部按当前代码生效。
#[tauri::command]
pub async fn webchat_login(app: AppHandle, site: String) -> Result<(), String> {
    let url = adapter(&site)
        .ok_or_else(|| format!("未知站点: {site}"))?
        .url;
    let profile = profile_dir(&app)?;
    kill_profile_edge();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    launch_edge(&profile, url)?;
    show_main(&app, false);
    Ok(())
}

/// 取消一次 ask:置标记,轮询间隙生效;ask 侧退出时统一清理标记
#[tauri::command]
pub fn webchat_cancel(state: State<'_, AskState>, request_id: String) -> Result<(), String> {
    state
        .cancelled
        .lock()
        .map_err(|e| e.to_string())?
        .insert(request_id);
    Ok(())
}

// ---------- CDP 客户端(单连接单飞:调用串行,id 递增防迟到响应错配) ----------

struct Cdp {
    ws: WsStream,
    seq: u64,
}

impl Cdp {
    fn new(ws: WsStream) -> Self {
        Self { ws, seq: 0 }
    }

    async fn call(
        &mut self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        self.seq += 1;
        let id = self.seq;
        let msg =
            Message::text(json!({ "id": id, "method": method, "params": params }).to_string());
        self.ws.send(msg).await.map_err(ws_err)?;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(format!("CDP {method} 超时"));
            }
            match tokio::time::timeout(remaining, self.ws.next()).await {
                Err(_elapsed) => return Err(format!("CDP {method} 超时")),
                Ok(None) => return Err("CDP 连接已关闭".into()),
                Ok(Some(Err(e))) => return Err(ws_err(e)),
                Ok(Some(Ok(Message::Text(t)))) => {
                    let v: Value = match serde_json::from_str(&t) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if v.get("id").and_then(Value::as_u64) != Some(id) {
                        continue; // 事件与其它 id 的响应不归本次调用
                    }
                    if let Some(err) = v.get("error") {
                        return Err(format!("CDP {method}: {err}"));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
                Ok(Some(Ok(Message::Ping(p)))) => {
                    // 显式回 pong,长轮询连接不被对端掐断
                    let _ = self.ws.send(Message::Pong(p)).await;
                }
                Ok(Some(Ok(_))) => continue, // pong/binary/帧碎片
            }
        }
    }
}

fn ws_err(e: tokio_tungstenite::tungstenite::Error) -> String {
    format!("CDP 连接异常: {e}")
}

/// Runtime.evaluate 的公共后置:异常详情转错误、取 result.value
fn evaluate_result(res: Result<Value, String>) -> Result<Value, String> {
    let res = res?;
    if let Some(exc) = res.get("exceptionDetails") {
        let msg = exc
            .pointer("/exception/description")
            .and_then(Value::as_str)
            .or_else(|| exc.get("text").and_then(Value::as_str))
            .unwrap_or("页面执行失败");
        return Err(format!("页面执行失败: {msg}"));
    }
    Ok(res.pointer("/result/value").cloned().unwrap_or(Value::Null))
}

async fn evaluate(cdp: &mut Cdp, expression: &str, timeout_ms: u64) -> Result<Value, String> {
    let res = cdp
        .call(
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true }),
            timeout_ms,
        )
        .await;
    evaluate_result(res)
}

/// Runtime.evaluate + awaitPromise(发送阶段用;userGesture 模拟真实输入授权)
async fn evaluate_await(cdp: &mut Cdp, expression: &str, timeout_ms: u64) -> Result<Value, String> {
    let res = cdp
        .call(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
                "userGesture": true,
            }),
            timeout_ms,
        )
        .await;
    evaluate_result(res)
}

/// 上下文销毁类错误(页面导航/标签页关闭):调用方按"已发出/需重连"处理
fn is_context_lost(err: &str) -> bool {
    let l = err.to_lowercase();
    [
        "context",
        "destroyed",
        "cannot find",
        "target closed",
        "session",
        "navigated",
        "closed",
    ]
    .iter()
    .any(|k| l.contains(k))
}

fn json_arg(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

// ---------- Edge 与标签页生命周期 ----------

/// 确保专用 Edge 在跑并返回 (实际端口, 浏览器级 CDP 连接)。
/// 已有实例(端口文件 + WS 可连)直接复用;否则按 profile 干净重启。
async fn ensure_edge(profile: &Path, site: &str) -> Result<(u16, Cdp), String> {
    let url = adapter(site)
        .ok_or_else(|| format!("未知站点: {site}"))?
        .url;
    if let Some((port, path)) = read_devtools(profile) {
        if let Ok(Ok(ws)) = tokio::time::timeout(
            Duration::from_millis(2000),
            connect_ws(format!("ws://127.0.0.1:{port}{path}")),
        )
        .await
        {
            return Ok((port, Cdp::new(ws)));
        }
    }
    kill_profile_edge();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    launch_edge(profile, url)?;
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(EDGE_READY_SECS) {
        if let Some((port, path)) = read_devtools(profile) {
            let attempt = tokio::time::timeout(
                Duration::from_millis(1200),
                connect_ws(format!("ws://127.0.0.1:{port}{path}")),
            )
            .await;
            if let Ok(Ok(ws)) = attempt {
                return Ok((port, Cdp::new(ws)));
            }
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
    Err(format!("Edge 调试通道 {EDGE_READY_SECS} 秒未就绪"))
}

/// 复用常驻站点标签页(web-tool 同款:不新增标签页,会话内发送纯 SPA);没有才创建
async fn ensure_page_target(browser: &mut Cdp, site: &str) -> Result<String, String> {
    let a = adapter(site).ok_or_else(|| format!("未知站点: {site}"))?;
    let find = |res: &Value| -> Option<String> {
        res.get("targetInfos")?.as_array()?.iter().find_map(|t| {
            let is_page = t.get("type").and_then(Value::as_str) == Some("page");
            let hits = t
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|u| u.contains(a.host));
            if is_page && hits {
                t.get("targetId").and_then(Value::as_str).map(String::from)
            } else {
                None
            }
        })
    };
    let res = browser.call("Target.getTargets", json!({}), 8000).await?;
    if let Some(id) = find(&res) {
        return Ok(id);
    }
    let res = browser
        .call("Target.createTarget", json!({ "url": a.url }), 15_000)
        .await?;
    res.get("targetId")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| "打开站点标签页失败".into())
}

async fn connect_page(port: u16, target_id: &str) -> Result<Cdp, String> {
    Ok(Cdp::new(
        connect_ws(format!("ws://127.0.0.1:{port}/devtools/page/{target_id}")).await?,
    ))
}

// ---------- ask 主流程 ----------

#[tauri::command]
pub async fn webchat_ask(
    app: AppHandle,
    state: State<'_, AskState>,
    request_id: String,
    prompt: String,
    site: String,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    {
        let mut slot = state.inflight.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("已有网页生成在进行中".into());
        }
        *slot = Some(request_id.clone());
    }
    let ask_secs = timeout_ms.unwrap_or(ASK_TIMEOUT_SECS * 1000) / 1000;
    let profile = profile_dir(&app)?;
    let result = run_ask(&profile, &state, &request_id, &prompt, &site, ask_secs).await;
    // 统一清理:任何退出路径都释放占用槽、清取消标记、恢复主覆盖层(角色回屏)
    if let Ok(mut slot) = state.inflight.lock() {
        *slot = None;
    }
    if let Ok(mut set) = state.cancelled.lock() {
        set.remove(&request_id);
    }
    show_main(&app, true);
    result
}

async fn run_ask(
    profile: &Path,
    state: &AskState,
    request_id: &str,
    prompt: &str,
    site: &str,
    ask_secs: u64,
) -> Result<String, String> {
    let a = adapter(site).ok_or_else(|| format!("未知站点: {site}"))?;
    let is_cancelled = || {
        state
            .cancelled
            .lock()
            .map(|set| set.contains(request_id))
            .unwrap_or(false)
    };

    let (mut port, mut browser) = ensure_edge(profile, site).await?;
    let mut target_id = ensure_page_target(&mut browser, site).await?;
    drop(browser);
    let mut cdp = connect_page(port, &target_id).await?;

    // 等目标页上下文稳定(首次创建的标签页要从 about:blank 导航过来)
    for _ in 0..30 {
        if is_cancelled() {
            return Err(CANCELLED.into());
        }
        match evaluate(&mut cdp, "location.href", 5000).await {
            Ok(v) if v.as_str().is_some_and(|s| s.starts_with("https://")) => break,
            _ => tokio::time::sleep(Duration::from_millis(800)).await,
        }
    }

    // 发送阶段:随导航殉职 = 已发出的强信号,放行
    let send_expr = format!("({})({})", a.send_js(), json_arg(prompt));
    let mut before_count: Option<u64> = None;
    let mut before_text: Option<String> = None;
    match evaluate_await(&mut cdp, &send_expr, 60_000).await {
        Ok(v) => {
            if v.get("sent") == Some(&json!(false)) {
                let why = v.get("why").and_then(Value::as_str).unwrap_or("未能发送");
                return Err(why.to_string());
            }
            before_count = v.get("beforeCount").and_then(Value::as_u64);
            before_text = v
                .get("beforeText")
                .and_then(Value::as_str)
                .map(String::from);
        }
        Err(e) => {
            if !is_context_lost(&e) {
                return Err(e);
            }
        }
    }

    // 抓取阶段:应用侧轮询无状态快照,完成判定移植 web-tool:
    // 见过生成中 → 不忙 → 有答案(非思考/非截断)→ 稳定 2.5 秒
    let head: String = prompt.chars().take(20).collect();
    let watch_expr = format!("({})({})", a.snap_js(), json_arg(&head));
    let t0 = Instant::now();
    let mut saw_generating = false;
    let mut last = String::new();
    let mut stable_since: Option<Instant> = None;
    loop {
        if is_cancelled() {
            return Err(CANCELLED.into());
        }
        if t0.elapsed() >= Duration::from_secs(ask_secs) {
            return Err("网页生成超时".into());
        }
        match evaluate(&mut cdp, &watch_expr, 8000).await {
            Ok(raw) => {
                let snap: Value = serde_json::from_str(raw.as_str().unwrap_or("{}"))
                    .unwrap_or_else(|_| json!({}));
                let busy = snap.get("busy").and_then(Value::as_bool).unwrap_or(false);
                if busy {
                    saw_generating = true;
                }
                if snap.get("turnError").and_then(Value::as_bool) == Some(true) {
                    return Err("站点返回了错误提示(发送失败)".into());
                }
                let text = snap
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let count = snap.get("count").and_then(Value::as_u64);
                let truncated = snap
                    .get("truncated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let grew = before_count.is_some_and(|b| count.is_some_and(|c| c > b));
                let changed = before_text
                    .as_ref()
                    .is_some_and(|b| !text.is_empty() && &text != b);
                let has_answer = !text.is_empty() && !truncated;
                if (saw_generating || grew || changed) && !busy && has_answer {
                    if text == last {
                        let since = stable_since.get_or_insert_with(Instant::now);
                        if since.elapsed() >= Duration::from_millis(STABLE_MS) {
                            return Ok(text);
                        }
                    } else {
                        last = text;
                        stable_since = Some(Instant::now());
                    }
                } else {
                    stable_since = None;
                    last = text;
                }
            }
            Err(e) => {
                // 上下文随导航销毁:重连同标签页的新上下文;标签页被关则重找/重建,
                // 轮询状态保留。重连失败本身不再区分原因,下一轮按超时收敛
                drop(cdp);
                tokio::time::sleep(Duration::from_millis(1000)).await;
                cdp = match connect_page(port, &target_id).await {
                    Ok(c) => c,
                    Err(_) => {
                        let (p2, mut b2) = ensure_edge(profile, site).await?;
                        port = p2;
                        target_id = ensure_page_target(&mut b2, site).await?;
                        drop(b2);
                        connect_page(port, &target_id).await?
                    }
                };
                let _ = e; // 已按"需重连"处理
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

// ---------- 就绪探测(设置页测试按钮) ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ready: bool,
    pub detail: String,
}

/// 逐级探测目标站点可否发消息,detail 说明断点位置(未就绪时展示给用户/排查用)
#[tauri::command]
pub async fn webchat_probe(app: AppHandle, site: String) -> Result<ProbeResult, String> {
    let a = adapter(&site).ok_or_else(|| format!("未知站点: {site}"))?;
    let not_ready = |detail: &str| ProbeResult {
        ready: false,
        detail: detail.to_string(),
    };
    let profile = profile_dir(&app)?;
    let Some((port, path)) = read_devtools(&profile) else {
        return Ok(not_ready("连不上 Edge 调试端口:Edge 未启动或端口不对"));
    };
    let ws = match connect_ws(format!("ws://127.0.0.1:{port}{path}")).await {
        Ok(ws) => ws,
        Err(_) => {
            return Ok(not_ready(
                "连不上 Edge 调试端口:Edge 未启动,或上次实例未带调试参数",
            ))
        }
    };
    let mut browser = Cdp::new(ws);
    let res = match browser.call("Target.getTargets", json!({}), 8000).await {
        Ok(res) => res,
        Err(e) => return Ok(not_ready(&format!("拉取标签页列表失败: {e}"))),
    };
    // 取最近打开的本站标签页(与旧实现的 reverse().find 语义一致)
    let target_id = res
        .get("targetInfos")
        .and_then(Value::as_array)
        .and_then(|list| {
            list.iter()
                .rev()
                .find(|t| {
                    t.get("type").and_then(Value::as_str) == Some("page")
                        && t.get("url")
                            .and_then(Value::as_str)
                            .is_some_and(|u| u.contains(a.host))
                })
                .and_then(|t| t.get("targetId").and_then(Value::as_str))
                .map(String::from)
        });
    let Some(target_id) = target_id else {
        return Ok(not_ready("Edge 里没有目标站点标签页"));
    };
    let mut page = match connect_page(port, &target_id).await {
        Ok(c) => c,
        Err(e) => return Ok(not_ready(&format!("附加到页面失败: {e}"))),
    };
    match evaluate(&mut page, &a.ready_js(), 8000).await {
        Ok(v) if v.as_bool() == Some(true) => {
            show_main(&app, true);
            Ok(ProbeResult {
                ready: true,
                detail: "已就绪".into(),
            })
        }
        Ok(_) => Ok(not_ready("输入框未出现(未登录,或站点改版需更新选择器)")),
        Err(e) => Ok(not_ready(&format!("附加到页面失败: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机 CDP 冒烟:拉起专用 Edge(临时 profile)→ 浏览器级 Target 域 → 页面 evaluate。
    /// 会短暂弹出 Edge 窗口;CI 跳过,本机 `cargo test -- --ignored` 验证。
    /// profile 目录名含 "webchat-edge-profile",kill_profile_edge 按命令行过滤能清掉它
    #[test]
    #[ignore = "真机冒烟:拉起 Edge 并走完整 CDP 链路;CI 跳过"]
    fn webchat_cdp_smoke() {
        let profile =
            std::env::temp_dir().join(format!("webchat-edge-profile-smoke-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (port, mut browser) = ensure_edge(&profile, "deepseek")
                .await
                .expect("ensure_edge(端口文件 + 浏览器级 WS)");
            let target = ensure_page_target(&mut browser, "deepseek")
                .await
                .expect("Target.getTargets/createTarget");
            drop(browser);
            let mut page = connect_page(port, &target).await.expect("页面级 WS 连接");
            // createTarget 返回时页面还在 about:blank,导航到站点是异步的——
            // 与 run_ask 的上下文稳定等待同款,有界重试
            let mut href = Value::Null;
            for _ in 0..30 {
                href = evaluate(&mut page, "location.href", 5000)
                    .await
                    .expect("页面 evaluate");
                if href.as_str().unwrap_or("").contains("deepseek") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1000)).await;
            }
            assert!(
                href.as_str().unwrap_or("").contains("deepseek"),
                "标签页应在 deepseek 站点,实际: {href:?}"
            );
        });
        kill_profile_edge();
        let _ = std::fs::remove_dir_all(&profile);
    }
}
