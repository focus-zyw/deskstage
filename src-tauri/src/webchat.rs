// 网页版生成通道 · WebchatHub:CDP 驱动系统 Edge 的唯一入口。
//
// 为什么不用应用内嵌第二 WebView2:本机实测四连败——独立 profile 白屏、共享环境
// 白屏、诊断离线页(回环纯本地 HTML)也一帧画不出、历史截屏窗 0x8007139F。
// 渲染层在本应用的第二 WebView 上是坏的,无法修复,故改为遥控系统已装 Edge:
//   Edge(独立 --user-data-dir,不影响日常浏览)+ --remote-debugging-port=0
//   → Rust 经 CDP(纯 WebSocket)开标签页/注入 prompt/抓回复(站点脚本见 webchat/sites.rs)。
// 登录 cookie 持久化在 webchat-edge-profile 目录,一次登录长期使用。
//
// Hub 统一两条路由(同一套生命周期,不并存两套 CDP 实现):
//   · Shared(webchat_ask,外部签名兼容旧通道):全站共享一个站点标签页,
//     单飞并发(同时只允许一个 ask)——主演出的网页通道
//   · Conversation(webchat_ask_conversation):conversationKey → 专属标签页,
//     同 key 串行、不同 key 并行、全局 2 生成槽——多 AI 剧场的会话底座
//
// 生命周期语义:
//   · Edge 读写租约:ask 整段持有读租约(不止启动那一下);login/restart 先取消
//     全部活动请求再取写租约——重启不可能杀掉在飞 ask 的 Edge;重启 epoch +1,
//     旧会话句柄按 epoch 失效
//   · 取消 = 活动请求注册表(requestId → handle,RAII 离场删除):迟到 cancel
//     找不到活动请求即 no-op,不再留永久脏标记
//   · 绝对 deadline:会话锁、生成槽、Edge 就绪、发送、抓取全部消费同一 Instant
//     起点的剩余时间,不每阶段重置
//   · 发送阶段状态:发送前标签页确认丢失 = 安全重建续发;发送后 target 确认消失
//     = typed error「发送后页面丢失」(导航销毁≠标签页丢失,同 target 重连照旧)——
//     不再"新空白页继续轮询"
//   · App 退出时(lib.rs RunEvent::Exit)杀掉专用 profile 的 Edge,不碰日常浏览
//
// 可测性:CDP/Edge 物理操作全部经 CdpOps trait,Hub 逻辑写在泛型之上,
// 单测注入内存假件即可覆盖并发/取消/失效语义(不起 Edge)。

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::net::TcpStream as TokioTcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub mod sites;
use sites::adapter;

const MAIN_LABEL: &str = "main";
/// 单次 ask 总超时默认值(命令入口钳位;前端可传 timeoutMs 覆盖)
const ASK_TIMEOUT_SECS: u64 = 180;
/// Edge 冷启/重启后调试通道就绪窗口
const EDGE_READY_SECS: u64 = 20;
/// 回复文本稳定判定窗(移植 web-tool)
const STABLE_MS: u64 = 2500;
/// 取消错误的固定文案(前端据此还原为 AbortError,保持旧取消语义)
const CANCELLED: &str = "已取消";
/// 发送后标签页丢失的固定文案(前端按 typed error 处理:reset + transcript 重发)
pub const LOST_AFTER_SEND: &str = "发送后页面丢失";
/// Conversation 路由的全局生成槽数量(Shared 路由走独立单飞槽,互不占位)
const HUB_PERMITS: usize = 2;
/// 会话闲置清理阈值:超过该时长的标签页由 sweeper 关闭(崩溃兜底)
pub const HUB_IDLE_SECS: u64 = 30 * 60;
/// 闲置清扫周期
pub const HUB_SWEEP_SECS: u64 = 10 * 60;

type WsStream = WebSocketStream<MaybeTlsStream<TokioTcpStream>>;

// ---------- 阶段轨迹(诊断面板用) ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AskTrace {
    pub request_id: String,
    pub stages: Vec<TraceStage>,
    pub total_ms: u64,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TraceStage {
    pub stage: String,
    pub ms: u64,
}

/// 只留最近一次(前端在 ask 结束后立即拉取;不放 Tauri state,避免动调用方装配)
static LAST_TRACE: Mutex<Option<AskTrace>> = Mutex::new(None);

/// 阶段记录器:阶段名 + 相对 ask 起点的毫秒数
pub struct TraceBuilder {
    request_id: String,
    t0: Instant,
    stages: Vec<TraceStage>,
}

impl TraceBuilder {
    pub fn new(request_id: &str) -> Self {
        Self {
            request_id: request_id.to_string(),
            t0: Instant::now(),
            stages: Vec::new(),
        }
    }

    pub fn mark(&mut self, stage: &str) {
        self.stages.push(TraceStage {
            stage: stage.to_string(),
            ms: self.t0.elapsed().as_millis() as u64,
        });
    }

    pub fn finish(self, error: Option<String>) {
        let total_ms = self.t0.elapsed().as_millis() as u64;
        let trace = AskTrace {
            request_id: self.request_id,
            stages: self.stages,
            total_ms,
            error,
        };
        if let Ok(mut slot) = LAST_TRACE.lock() {
            *slot = Some(trace);
        }
    }
}

/// 最近一次 ask 的阶段轨迹(只读;前端在 ask 完成后拉取并挂到诊断会话上)
#[tauri::command]
pub fn webchat_last_trace() -> Option<AskTrace> {
    LAST_TRACE.lock().ok().and_then(|slot| slot.clone())
}

// ---------- 取消注册表 ----------

/// 单个活动请求的取消句柄:flag 先行保证「先取消后等待」也立即生效
pub struct CancellationHandle {
    flag: std::sync::atomic::AtomicBool,
    notify: tokio::sync::Notify,
}

impl CancellationHandle {
    fn new() -> Self {
        Self {
            flag: std::sync::atomic::AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        }
    }

    fn cancel(&self) {
        self.flag.store(true, std::sync::atomic::Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 等待取消;已取消则立即返回(双检消除注册/等待竞态窗口)
    pub async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// 活动请求注册表的 RAII 守卫:离场自动删除注册项(含 panic 路径)
struct RequestGuard {
    request_id: String,
    registry: Arc<Mutex<HashMap<String, Arc<CancellationHandle>>>>,
}

impl RequestGuard {
    fn register(
        registry: &Arc<Mutex<HashMap<String, Arc<CancellationHandle>>>>,
        request_id: &str,
    ) -> Self {
        if let Ok(mut map) = registry.lock() {
            map.insert(request_id.to_string(), Arc::new(CancellationHandle::new()));
        }
        Self {
            request_id: request_id.to_string(),
            registry: registry.clone(),
        }
    }

    fn handle(&self) -> Arc<CancellationHandle> {
        self.registry
            .lock()
            .ok()
            .and_then(|m| m.get(&self.request_id).cloned())
            .unwrap_or_else(|| Arc::new(CancellationHandle::new()))
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.registry.lock() {
            map.remove(&self.request_id);
        }
    }
}

// ---------- 绝对 deadline ----------

#[derive(Clone, Copy)]
struct Deadline {
    at: Instant,
}

impl Deadline {
    fn after_ms(ms: u64) -> Self {
        Self {
            at: Instant::now() + Duration::from_millis(ms),
        }
    }

    fn remaining(&self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }

    fn expired(&self) -> bool {
        Instant::now() >= self.at
    }
}

/// 失败分类:命令层只对外暴露固定文案(前端据此识别取消/超时/发送后丢失)
enum AskFail {
    Cancelled,
    Timeout,
    LostAfterSend,
    Failed(String),
}

impl AskFail {
    fn msg(&self) -> String {
        match self {
            AskFail::Cancelled => CANCELLED.into(),
            AskFail::Timeout => "网页生成超时".into(),
            AskFail::LostAfterSend => LOST_AFTER_SEND.into(),
            AskFail::Failed(e) => e.clone(),
        }
    }
}

/// 等一个 future,期间取消或到点即失败(绝对 deadline 全程消费同一 Instant)
async fn within<T, F>(
    fut: F,
    cancel: &CancellationHandle,
    deadline: Deadline,
    _what: &str,
) -> Result<T, AskFail>
where
    F: Future<Output = T>,
{
    tokio::select! {
        r = fut => Ok(r),
        _ = cancel.cancelled() => Err(AskFail::Cancelled),
        _ = tokio::time::sleep(deadline.remaining()) => Err(AskFail::Timeout),
    }
}

// ---------- CDP 传输层(可测 seam) ----------

/// Edge 与页面的全部物理操作。Hub 逻辑只依赖此 trait,
/// 单测注入内存假件即可覆盖并发/取消/失效语义(不起 Edge)。
pub trait CdpOps: Send + Sync + 'static {
    /// 写租约内:杀旧实例并按 url 拉起新 Edge(调用方保证已持有写租约)
    async fn kill_and_launch(&self, profile: &Path, url: &str) -> Result<(), String>;
    /// Edge 是否在跑且调试通道可连;返回实际端口(读租约内调用)
    async fn probe_port(&self, profile: &Path) -> Option<u16>;
    /// (targetId, url) 列表(仅 page 型)
    async fn list_pages(&self, port: u16) -> Result<Vec<(String, String)>, String>;
    async fn create_page(&self, port: u16, url: &str) -> Result<String, String>;
    async fn close_page(&self, port: u16, target_id: &str) -> Result<(), String>;
    /// 页面求值(普通)
    async fn eval(
        &self,
        port: u16,
        target_id: &str,
        expr: &str,
        timeout_ms: u64,
    ) -> Result<Value, String>;
    /// 页面求值(awaitPromise + userGesture,发送阶段)
    async fn eval_await(
        &self,
        port: u16,
        target_id: &str,
        expr: &str,
        timeout_ms: u64,
    ) -> Result<Value, String>;
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

/// 浏览器级短连接(端口文件 → WS);每次操作即建即弃
async fn browser_connect(profile: &Path) -> Result<(u16, Cdp), String> {
    let Some((port, path)) = read_devtools(profile) else {
        return Err("Edge 调试端口文件不存在(Edge 未启动)".into());
    };
    let ws = tokio::time::timeout(
        Duration::from_millis(2000),
        connect_ws(format!("ws://127.0.0.1:{port}{path}")),
    )
    .await
    .map_err(|_| "Edge 调试通道连接超时".to_string())??;
    Ok((port, Cdp::new(ws)))
}

// ---------- CDP 客户端(单连接单飞:id 递增防迟到响应错配) ----------

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

/// 页面级求值:每次新建短连接(本机 WS 毫秒级,300ms 轮询间隔完全淹没)
async fn page_call(
    port: u16,
    target_id: &str,
    expression: &str,
    timeout_ms: u64,
    await_promise: bool,
    user_gesture: bool,
) -> Result<Value, String> {
    let mut cdp =
        Cdp::new(connect_ws(format!("ws://127.0.0.1:{port}/devtools/page/{target_id}")).await?);
    let params = json!({
        "expression": expression,
        "returnByValue": true,
        "awaitPromise": await_promise,
        "userGesture": user_gesture,
    });
    evaluate_result(cdp.call("Runtime.evaluate", params, timeout_ms).await)
}

/// 上下文销毁类错误(页面导航/标签页关闭):调用方按"需重连"分类处理
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
        "connection",
    ]
    .iter()
    .any(|k| l.contains(k))
}

fn json_arg(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// 桌面端真实传输:每次操作新建短连接(本机 WS 连接毫秒级,轮询间隔 300ms 完全淹没)
pub struct RealCdpOps;

impl CdpOps for RealCdpOps {
    async fn kill_and_launch(&self, profile: &Path, url: &str) -> Result<(), String> {
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
                if let Ok(Ok(_)) = attempt {
                    return Ok(());
                }
            }
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
        Err(format!("Edge 调试通道 {EDGE_READY_SECS} 秒未就绪"))
    }

    async fn probe_port(&self, profile: &Path) -> Option<u16> {
        browser_connect(profile).await.ok().map(|(port, _)| port)
    }

    async fn list_pages(&self, port: u16) -> Result<Vec<(String, String)>, String> {
        let mut browser = Cdp::new(connect_ws(format!("ws://127.0.0.1:{port}/json")).await?);
        let res = browser.call("Target.getTargets", json!({}), 8000).await?;
        let pages = res
            .get("targetInfos")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter(|t| t.get("type").and_then(Value::as_str) == Some("page"))
                    .filter_map(|t| {
                        let id = t.get("targetId").and_then(Value::as_str)?.to_string();
                        let url = t.get("url").and_then(Value::as_str)?.to_string();
                        Some((id, url))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(pages)
    }

    async fn create_page(&self, port: u16, url: &str) -> Result<String, String> {
        let mut browser = Cdp::new(connect_ws(format!("ws://127.0.0.1:{port}/json")).await?);
        let res = browser
            .call("Target.createTarget", json!({ "url": url }), 15_000)
            .await?;
        res.get("targetId")
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| "打开标签页失败".into())
    }

    async fn close_page(&self, port: u16, target_id: &str) -> Result<(), String> {
        let mut browser = Cdp::new(connect_ws(format!("ws://127.0.0.1:{port}/json")).await?);
        browser
            .call("Target.closeTarget", json!({ "targetId": target_id }), 5000)
            .await?;
        Ok(())
    }

    async fn eval(
        &self,
        port: u16,
        target_id: &str,
        expr: &str,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        page_call(port, target_id, expr, timeout_ms, false, false).await
    }

    async fn eval_await(
        &self,
        port: u16,
        target_id: &str,
        expr: &str,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        page_call(port, target_id, expr, timeout_ms, true, true).await
    }
}

// ---------- 主覆盖层开关 ----------

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

// ---------- Hub 状态 ----------

/// Edge 运行时快照:port 供页面连接,epoch 供句柄失效判定(每次重启 +1)
#[derive(Clone, Copy)]
struct EdgeRuntime {
    port: u16,
    epoch: u64,
}

/// 会话可变态:全部包在 slot 锁内(release/sweeper/ask 竞争同一把锁,
/// 关标签页前必先拿锁,不关在用页)
pub struct ConversationState {
    site: String,
    target_id: Option<String>,
    edge_epoch: u64,
    turn_count: u32,
    last_used_at: Instant,
    released: bool,
}

/// 一个会话 = 一把串行锁(整个 ask 期间持有,release/sweeper 以它判定在飞)+
/// 一份可变态。总表只存 Arc,查找/移除不跨 CDP 调用
pub struct ConversationSlot {
    key_lock: tokio::sync::Mutex<()>,
    state: tokio::sync::Mutex<ConversationState>,
}

impl ConversationSlot {
    fn new(site: &str) -> Self {
        Self {
            key_lock: tokio::sync::Mutex::new(()),
            state: tokio::sync::Mutex::new(ConversationState {
                site: site.to_string(),
                target_id: None,
                edge_epoch: 0,
                turn_count: 0,
                last_used_at: Instant::now(),
                released: false,
            }),
        }
    }
}

/// 网页生成 Hub:两条路由共用的 Edge 生命周期、取消注册表与并发闸。
/// 泛型参数仅为测试注入假传输层;桌面装配用 `WebchatHub`
pub struct HubState<O: CdpOps> {
    ops: Arc<O>,
    /// 读租约 = ask 整段持有;写租约 = login/restart(先取消全部活动请求)
    edge: tokio::sync::RwLock<EdgeRuntime>,
    conversations: tokio::sync::Mutex<HashMap<String, Arc<ConversationSlot>>>,
    requests: Arc<Mutex<HashMap<String, Arc<CancellationHandle>>>>,
    /// Conversation 路由的全局生成槽;Shared 路由走自己的单飞槽,互不占位
    permits: Arc<Semaphore>,
    /// Shared 路由单飞(与旧通道外部行为一致:同时只允许一个 ask)
    inflight: Mutex<Option<String>>,
}

/// 生成路由差异:target 解析与"丢失恢复"策略
#[derive(Clone)]
enum Route {
    Shared { host: String },
    Conversation,
}

impl<O: CdpOps> HubState<O> {
    pub fn new(ops: Arc<O>) -> Self {
        Self {
            ops,
            edge: tokio::sync::RwLock::new(EdgeRuntime { port: 0, epoch: 1 }),
            conversations: tokio::sync::Mutex::new(HashMap::new()),
            requests: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(Semaphore::new(HUB_PERMITS)),
            inflight: Mutex::new(None),
        }
    }

    fn cancel_all(&self) {
        if let Ok(map) = self.requests.lock() {
            for h in map.values() {
                h.cancel();
            }
        }
    }

    /// ops 调用的统一包装:取消/超时按 AskFail 透传,内层 String 错误归入 Failed
    async fn op<T, F>(
        &self,
        fut: F,
        cancel: &CancellationHandle,
        deadline: Deadline,
    ) -> Result<T, AskFail>
    where
        F: Future<Output = Result<T, String>>,
    {
        match within(fut, cancel, deadline, "op").await {
            Ok(inner) => inner.map_err(AskFail::Failed),
            Err(e) => Err(e),
        }
    }

    /// 探活(带重试):单次 WS 握手超时(实例繁忙/负载高)不等于 Edge 挂了。
    /// 误判的代价是杀整个实例——多 AI 剧场两个站点的会话标签页会一起消失,故先重试再升级
    async fn probe_running(&self, profile: &Path, deadline: Deadline) -> Option<u16> {
        for _ in 0..3 {
            if let Some(port) = self.ops.probe_port(profile).await {
                return Some(port);
            }
            if deadline.expired() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        None
    }

    /// 读租约:确保 Edge 在跑(不在跑则短暂升写租约拉起),返回租约守卫。
    /// 写租约等待期间新读请求 FIFO 排队,不会插进 restart 中间
    async fn edge_read_lease(
        &self,
        profile: &Path,
        url: &str,
        cancel: &CancellationHandle,
        deadline: Deadline,
    ) -> Result<tokio::sync::RwLockReadGuard<'_, EdgeRuntime>, AskFail> {
        loop {
            let guard = within(self.edge.read(), cancel, deadline, "edge").await?;
            let port = within(
                self.probe_running(profile, deadline),
                cancel,
                deadline,
                "edge",
            )
            .await?;
            if port.is_some() {
                return Ok(guard);
            }
            drop(guard);
            // 升写:杀旧拉新(写者之间互斥;另一写者刚修好则直接回落读)
            let w = within(self.edge.write(), cancel, deadline, "edge").await?;
            let still_down = within(
                self.probe_running(profile, deadline),
                cancel,
                deadline,
                "edge",
            )
            .await?
            .is_none();
            if still_down {
                self.ops
                    .kill_and_launch(profile, url)
                    .await
                    .map_err(AskFail::Failed)?;
                let t0 = Instant::now();
                loop {
                    if self.ops.probe_port(profile).await.is_some() {
                        break;
                    }
                    if t0.elapsed() > Duration::from_secs(EDGE_READY_SECS) {
                        return Err(AskFail::Failed(format!(
                            "Edge 调试通道 {EDGE_READY_SECS} 秒未就绪"
                        )));
                    }
                    tokio::time::sleep(Duration::from_millis(600)).await;
                }
            }
            drop(w);
        }
    }

    async fn target_alive(
        &self,
        port: u16,
        target_id: &str,
        cancel: &CancellationHandle,
        deadline: Deadline,
    ) -> bool {
        match self.op(self.ops.list_pages(port), cancel, deadline).await {
            Ok(pages) => pages.iter().any(|(id, _)| id == target_id),
            Err(_) => false,
        }
    }

    /// Shared 路由的站点标签页:复用同宿主页,没有才建
    async fn find_or_create_shared(
        &self,
        port: u16,
        host: &str,
        url: &str,
        cancel: &CancellationHandle,
        deadline: Deadline,
    ) -> Result<String, AskFail> {
        let pages = self.op(self.ops.list_pages(port), cancel, deadline).await?;
        if let Some((id, _)) = pages.iter().rev().find(|p| p.1.contains(host)) {
            return Ok(id.clone());
        }
        self.op(self.ops.create_page(port, url), cancel, deadline)
            .await
    }

    /// 解析会话专属标签页:reset/epoch 变化/站点变化/句柄缺失/已消失 = 关旧建新
    #[allow(clippy::too_many_arguments)]
    async fn resolve_conversation_target(
        &self,
        port: u16,
        epoch: u64,
        slot: &ConversationSlot,
        site: &str,
        reset: bool,
        cancel: &CancellationHandle,
        deadline: Deadline,
        trace: &mut TraceBuilder,
    ) -> Result<String, AskFail> {
        let mut st = slot.state.lock().await;
        if st.released {
            return Err(AskFail::Failed("会话已释放".into()));
        }
        let stale = reset || st.edge_epoch != epoch || st.site != site || st.target_id.is_none();
        let mut old = st.target_id.clone();
        if !stale {
            let tid = old.clone().unwrap_or_default();
            if self.target_alive(port, &tid, cancel, deadline).await {
                return Ok(tid);
            }
            trace.mark("target_lost_reuse");
            old = None;
        }
        // 关旧建新(旧上下文作废;恢复靠 transcript prompt)
        if let Some(tid) = old {
            let _ = self
                .op(self.ops.close_page(port, &tid), cancel, deadline)
                .await;
        }
        let url = adapter(site)
            .ok_or_else(|| AskFail::Failed(format!("未知站点: {site}")))?
            .url;
        let tid = self
            .op(self.ops.create_page(port, url), cancel, deadline)
            .await?;
        trace.mark("target_created");
        st.site = site.to_string();
        st.target_id = Some(tid.clone());
        st.edge_epoch = epoch;
        st.turn_count = 0;
        st.last_used_at = Instant::now();
        Ok(tid)
    }

    /// 生成主流程:上下文稳定 → 发送 → 轮询抓取(稳定 2.5s 判定)。
    /// target_id 可变:发送前确认丢失时路由内安全重建;发送后丢失 = typed error
    #[allow(clippy::too_many_arguments)]
    async fn generation(
        &self,
        port: u16,
        target_id: &mut String,
        route: &Route,
        site: &str,
        prompt: &str,
        cancel: &CancellationHandle,
        deadline: Deadline,
        trace: &mut TraceBuilder,
    ) -> Result<String, AskFail> {
        let a = adapter(site).ok_or_else(|| AskFail::Failed(format!("未知站点: {site}")))?;

        // 等目标页上下文稳定(新建标签页要从 about:blank 导航过来);
        // 标签页消失 = 发送前丢失,路由内安全重建
        loop {
            if cancel.is_cancelled() {
                return Err(AskFail::Cancelled);
            }
            if deadline.expired() {
                return Err(AskFail::Timeout);
            }
            let v = match self
                .op(
                    self.ops.eval(port, target_id, "location.href", 5000),
                    cancel,
                    deadline,
                )
                .await
            {
                Ok(v) => v,
                Err(e) => {
                    let context_lost = match &e {
                        AskFail::Failed(m) => is_context_lost(m),
                        _ => false,
                    };
                    if context_lost && !self.target_alive(port, target_id, cancel, deadline).await {
                        *target_id = self
                            .recreate_target(port, route, site, cancel, deadline)
                            .await?;
                        trace.mark("target_recreated");
                    }
                    if !context_lost {
                        return Err(e);
                    }
                    continue;
                }
            };
            if v.as_str().is_some_and(|s| s.starts_with("https://")) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
        trace.mark("ctx_stable");

        // 发送阶段:随导航殉职 = 已发出的强信号,按 Sent 继续(同 target 轮询)
        let send_expr = format!("({})({})", a.send_js(), json_arg(prompt));
        let v = match self
            .op(
                self.ops.eval_await(port, target_id, &send_expr, 60_000),
                cancel,
                deadline,
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                if let AskFail::Failed(m) = &e {
                    if !is_context_lost(m) {
                        return Err(e);
                    }
                } else {
                    return Err(e);
                }
                // 导航殉职:视为已发送(旧行为,实战校验);target 之后确认消失才升级为丢失
                trace.mark("sent_context_lost");
                Value::Null
            }
        };
        if v.get("sent") == Some(&json!(false)) {
            let why = v.get("why").and_then(Value::as_str).unwrap_or("未能发送");
            return Err(AskFail::Failed(why.to_string()));
        }
        let before_count = v.get("beforeCount").and_then(Value::as_u64);
        let before_text = v
            .get("beforeText")
            .and_then(Value::as_str)
            .map(String::from);
        let sent = true;
        trace.mark("sent");

        // 抓取阶段:见过生成中 → 不忙 → 有答案(非思考/非截断)→ 稳定 2.5 秒
        let head: String = prompt.chars().take(20).collect();
        let watch_expr = format!("({})({})", a.snap_js(), json_arg(&head));
        let mut saw_generating = false;
        let mut saw_text = false;
        let mut last = String::new();
        let mut stable_since: Option<Instant> = None;
        loop {
            if cancel.is_cancelled() {
                return Err(AskFail::Cancelled);
            }
            if deadline.expired() {
                return Err(AskFail::Timeout);
            }
            let raw = match self
                .op(
                    self.ops.eval(port, target_id, &watch_expr, 8000),
                    cancel,
                    deadline,
                )
                .await
            {
                Ok(raw) => raw,
                Err(e) => {
                    // 上下文随导航销毁:先确认 target 是否还在——
                    // 在 = 同页重连续轮(导航销毁≠标签页丢失);不在 = 按阶段分派
                    let transient = match &e {
                        AskFail::Failed(m) => is_context_lost(m),
                        _ => false,
                    };
                    let _ = transient;
                    trace.mark("reconnect");
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                    if !self.target_alive(port, target_id, cancel, deadline).await {
                        if sent {
                            return Err(AskFail::LostAfterSend);
                        }
                        *target_id = self
                            .recreate_target(port, route, site, cancel, deadline)
                            .await?;
                        trace.mark("target_recreated");
                    }
                    continue;
                }
            };
            {
                let snap: Value = serde_json::from_str(raw.as_str().unwrap_or("{}"))
                    .unwrap_or_else(|_| json!({}));
                let busy = snap.get("busy").and_then(Value::as_bool).unwrap_or(false);
                if busy && !saw_generating {
                    saw_generating = true;
                    trace.mark("first_busy");
                }
                if snap.get("turnError").and_then(Value::as_bool) == Some(true) {
                    return Err(AskFail::Failed("站点返回了错误提示(发送失败)".into()));
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
                if !text.is_empty() && !saw_text {
                    saw_text = true;
                    trace.mark("first_text");
                }
                let has_answer = !text.is_empty() && !truncated;
                if (saw_generating || grew || changed) && !busy && has_answer {
                    if text == last {
                        let since = stable_since.get_or_insert_with(Instant::now);
                        if since.elapsed() >= Duration::from_millis(STABLE_MS) {
                            trace.mark("stable_done");
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
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    /// 发送前丢失的安全重建:Shared 按宿主重找/建,Conversation 开新页
    async fn recreate_target(
        &self,
        port: u16,
        route: &Route,
        site: &str,
        cancel: &CancellationHandle,
        deadline: Deadline,
    ) -> Result<String, AskFail> {
        let a = adapter(site).ok_or_else(|| AskFail::Failed(format!("未知站点: {site}")))?;
        match route {
            Route::Shared { host } => {
                self.find_or_create_shared(port, host, a.url, cancel, deadline)
                    .await
            }
            Route::Conversation => {
                within(self.ops.create_page(port, a.url), cancel, deadline, "pages")
                    .await?
                    .map_err(AskFail::Failed)
            }
        }
    }

    /// 打开登录窗口(设置页"打开登录窗口"/AI剧场甲乙各自登录)。
    /// 关键语义:实例已在跑 = **只开一个新标签页**——绝不杀实例,其他站点的
    /// 标签页与会话(多 AI 剧场两个站点并存)原样存活;只有真的没在跑才冷启动。
    /// 冷启动会重启进程:epoch +1、全部会话句柄失效(后续 ask 自动重建标签页)。
    pub async fn open_login(&self, profile: &Path, url: &str) -> Result<LoginOutcome, String> {
        if let Some(port) = self.ops.probe_port(profile).await {
            // 复用路径:新标签页落在已有窗口(createTarget 默认前台激活)
            self.ops.create_page(port, url).await?;
            return Ok(LoginOutcome::Reused);
        }
        // 冷启动:先取消全部活动请求(在飞 ask 快速收场释放读租约),再取写租约
        self.cancel_all();
        let mut w = tokio::time::timeout(Duration::from_secs(30), self.edge.write())
            .await
            .map_err(|_| "等待在飞网页生成结束超时,请稍后重试登录".to_string())?;
        // 双检:等锁期间在飞 ask 的自动拉起可能已把实例修好
        match self.ops.probe_port(profile).await {
            Some(port) => {
                drop(w);
                self.ops.create_page(port, url).await?;
                Ok(LoginOutcome::Reused)
            }
            None => {
                // kill 兜底:清理"端口文件缺失但进程还在"的僵尸实例(无调试参数)
                self.ops.kill_and_launch(profile, url).await?;
                w.epoch += 1;
                // 全部会话句柄失效(target 随进程消失):清表,后续 ask 自动重建
                self.conversations.lock().await.clear();
                Ok(LoginOutcome::ColdStarted)
            }
        }
    }

    /// 闲置会话清扫(sweeper 定时调用,崩溃兜底)。
    /// key_lock.try_lock 拿不到 = ask 在飞,跳过不关在用会话
    pub async fn sweep_idle(&self) {
        let candidates: Vec<(String, Arc<ConversationSlot>)> = {
            let map = self.conversations.lock().await;
            map.iter()
                .filter(|(_, slot)| {
                    slot.state
                        .try_lock()
                        .map(|st| {
                            !st.released
                                && st.last_used_at.elapsed() > Duration::from_secs(HUB_IDLE_SECS)
                        })
                        .unwrap_or(false)
                })
                .map(|(k, s)| (k.clone(), s.clone()))
                .collect()
        };
        if candidates.is_empty() {
            return;
        }
        let Ok(lease) = self.edge.try_read() else {
            return;
        };
        for (key, slot) in candidates {
            let Ok(_serial) = slot.key_lock.try_lock() else {
                continue; // ask 在飞:不关在用会话
            };
            let mut st = slot.state.lock().await;
            if st.released || st.last_used_at.elapsed() <= Duration::from_secs(HUB_IDLE_SECS) {
                continue;
            }
            if let Some(tid) = st.target_id.clone() {
                let _ = self.ops.close_page(lease.port, &tid).await;
            }
            st.released = true;
            drop(st);
            self.conversations.lock().await.remove(&key);
        }
    }
}

/// 桌面端装配:真实 CDP 传输
pub type WebchatHub = HubState<RealCdpOps>;

/// 登录窗口的两种结果:复用已有实例开新页 = 其他标签页原样存活
#[derive(Debug, PartialEq, Eq)]
pub enum LoginOutcome {
    Reused,
    ColdStarted,
}

// ---------- 命令:Shared 路由(旧通道,外部行为兼容) ----------

#[tauri::command]
pub async fn webchat_ask(
    app: AppHandle,
    hub: State<'_, Arc<WebchatHub>>,
    request_id: String,
    prompt: String,
    site: String,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    {
        let mut slot = hub.inflight.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("已有网页生成在进行中".into());
        }
        *slot = Some(request_id.clone());
    }
    let deadline = Deadline::after_ms(
        timeout_ms
            .unwrap_or(ASK_TIMEOUT_SECS * 1000)
            .clamp(5_000, 600_000),
    );
    let run = async {
        let profile = profile_dir(&app).map_err(AskFail::Failed)?;
        let mut trace = TraceBuilder::new(&request_id);
        let guard = RequestGuard::register(&hub.requests, &request_id);
        let cancel = guard.handle();
        let a = adapter(&site).ok_or_else(|| AskFail::Failed(format!("未知站点: {site}")))?;
        let lease = hub
            .edge_read_lease(&profile, a.url, &cancel, deadline)
            .await?;
        let port = lease.port;
        let mut target_id = hub
            .find_or_create_shared(port, a.host, a.url, &cancel, deadline)
            .await?;
        trace.mark("page_ready");
        let result = hub
            .generation(
                port,
                &mut target_id,
                &Route::Shared {
                    host: a.host.to_string(),
                },
                &site,
                &prompt,
                &cancel,
                deadline,
                &mut trace,
            )
            .await;
        trace.finish(result.as_ref().err().map(|f| f.msg()));
        result
    };
    let result = run.await;
    if let Ok(mut slot) = hub.inflight.lock() {
        *slot = None;
    }
    show_main(&app, true);
    result.map_err(|f| f.msg())
}

// ---------- 命令:Conversation 路由(多 AI 剧场会话底座) ----------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn webchat_ask_conversation(
    app: AppHandle,
    hub: State<'_, Arc<WebchatHub>>,
    request_id: String,
    conversation_key: String,
    prompt: String,
    site: String,
    timeout_ms: Option<u64>,
    reset: Option<bool>,
) -> Result<String, String> {
    if adapter(&site).is_none() {
        return Err(format!("未知站点: {site}"));
    }
    let deadline = Deadline::after_ms(timeout_ms.unwrap_or(120_000).clamp(5_000, 300_000));
    let profile = profile_dir(&app)?;
    let mut trace = TraceBuilder::new(&request_id);
    let guard = RequestGuard::register(&hub.requests, &request_id);
    let cancel = guard.handle();
    let result = run_conversation(
        &hub,
        &profile,
        &conversation_key,
        &prompt,
        &site,
        reset.unwrap_or(false),
        &cancel,
        deadline,
        &mut trace,
    )
    .await;
    trace.finish(result.as_ref().err().map(|f| f.msg()));
    result.map_err(|f| f.msg())
}

#[allow(clippy::too_many_arguments)]
async fn run_conversation<O: CdpOps>(
    hub: &Arc<HubState<O>>,
    profile: &Path,
    key: &str,
    prompt: &str,
    site: &str,
    reset: bool,
    cancel: &Arc<CancellationHandle>,
    deadline: Deadline,
    trace: &mut TraceBuilder,
) -> Result<String, AskFail> {
    // 会话槽:总表锁只做查找/插入 Arc,立刻释放;串行靠 slot 自己的 key_lock
    let slot: Arc<ConversationSlot> = {
        let mut map = hub.conversations.lock().await;
        map.entry(key.to_string())
            .or_insert_with(|| Arc::new(ConversationSlot::new(site)))
            .clone()
    };
    // 同 key 串行(取消/超时可打断排队等待)
    let _serial = within(slot.key_lock.lock(), cancel, deadline, "slot").await?;
    // 全局生成槽(仅 Conversation 路由;Shared 走独立单飞槽互不占位)
    let permit: OwnedSemaphorePermit = within(
        hub.permits.clone().acquire_owned(),
        cancel,
        deadline,
        "permit",
    )
    .await?
    .map_err(|e| AskFail::Failed(format!("生成槽不可用: {e}")))?;
    let a = adapter(site).ok_or_else(|| AskFail::Failed(format!("未知站点: {site}")))?;
    // 读租约整段持有:ask 期间不可能发生 kill/restart
    let lease = hub
        .edge_read_lease(profile, a.url, cancel, deadline)
        .await?;
    let mut target_id = hub
        .resolve_conversation_target(
            lease.port,
            lease.epoch,
            &slot,
            site,
            reset,
            cancel,
            deadline,
            trace,
        )
        .await?;
    trace.mark("page_ready");
    let result = hub
        .generation(
            lease.port,
            &mut target_id,
            &Route::Conversation,
            site,
            prompt,
            cancel,
            deadline,
            trace,
        )
        .await;
    // 结账:成败都记使用时刻;成功累计轮次
    if let Ok(mut st) = slot.state.try_lock() {
        st.last_used_at = Instant::now();
        if result.is_ok() {
            st.turn_count += 1;
        }
    }
    drop(permit);
    result
}

/// 释放会话:先出总表(后续 ask 拿到的是全新槽),再等在飞 ask 收场
/// (key_lock 整段被 ask 持有),最后关标签页——绝不关在用 target
#[tauri::command]
pub async fn webchat_release_conversation(
    app: AppHandle,
    hub: State<'_, Arc<WebchatHub>>,
    conversation_key: String,
) -> Result<(), String> {
    let slot = hub.conversations.lock().await.remove(&conversation_key);
    let Some(slot) = slot else {
        return Ok(()); // 不存在 = 已释放,no-op
    };
    let _serial = slot.key_lock.lock().await;
    let mut st = slot.state.lock().await;
    if st.released {
        return Ok(());
    }
    if let Some(tid) = st.target_id.clone() {
        if let Some(port) = hub.ops.probe_port(&profile_dir(&app)?).await {
            let _ = hub.ops.close_page(port, &tid).await;
        }
    }
    st.released = true;
    Ok(())
}

// ---------- 取消 / 登录 / 探测 ----------

/// 取消一次 ask:查活动请求注册表,找到才触发;找不到(已完成/未知)= no-op,
/// 不再留下永久脏标记
#[tauri::command]
pub fn webchat_cancel(hub: State<'_, Arc<WebchatHub>>, request_id: String) -> Result<(), String> {
    if let Ok(map) = hub.requests.lock() {
        if let Some(h) = map.get(&request_id) {
            h.cancel();
        }
    }
    Ok(())
}

/// 拉起可见的 Edge 窗口给用户登录(隐藏主覆盖层让路)。
/// 实例已在跑 = 只开新标签页(其他站点标签页原样存活——多 AI 剧场两个站点
/// 并存的关键);只有没在跑才冷启动(epoch 失效会话句柄)。成功才隐藏主覆盖层:
/// 拉起失败没有可交互的 Edge 窗口,角色该留在屏幕上
#[tauri::command]
pub async fn webchat_login(
    app: AppHandle,
    hub: State<'_, Arc<WebchatHub>>,
    site: String,
) -> Result<(), String> {
    let url = adapter(&site)
        .ok_or_else(|| format!("未知站点: {site}"))?
        .url;
    let profile = profile_dir(&app)?;
    hub.open_login(&profile, url).await?;
    show_main(&app, false);
    Ok(())
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
    let Ok((port, mut browser)) = browser_connect(&profile).await else {
        return Ok(not_ready("连不上 Edge 调试端口:Edge 未启动或端口不对"));
    };
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
    match page_call(port, &target_id, &a.ready_js(), 8000, false, false).await {
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

    /// 阶段轨迹:阶段按序追加、毫秒数单调、finish 落库 LAST_TRACE 且可取回
    #[test]
    fn trace_builder_records_and_publishes() {
        let request_id = format!("trace-test-{}", std::process::id());
        let mut trace = TraceBuilder::new(&request_id);
        trace.mark("edge_ready");
        std::thread::sleep(Duration::from_millis(2));
        trace.mark("sent");
        let err = Some("网页生成超时".to_string());
        let total_hint = trace.t0.elapsed().as_millis() as u64;
        trace.finish(err.clone());
        let got = LAST_TRACE.lock().unwrap().clone().expect("轨迹应已落库");
        assert_eq!(got.request_id, request_id);
        assert_eq!(got.stages.len(), 2);
        assert_eq!(got.stages[0].stage, "edge_ready");
        assert!(got.stages[1].ms >= got.stages[0].ms);
        assert!(got.total_ms >= total_hint.saturating_sub(1));
        assert_eq!(got.error, err);
    }

    // ---------- 假传输层:内存簿记 + 可编排的失败注入 ----------

    #[derive(Default)]
    struct FakeOpsInner {
        pages: Vec<(String, String)>,
        launched: u32,
        next_id: u32,
        /// 每次 eval 的延时(模拟网页生成慢)
        eval_delay_ms: u64,
        /// 发送成功后立刻移除目标(模拟标签页被关)
        drop_target_after_send: bool,
        /// 活跃 eval 计数与峰值(并发断言用)
        active_evals: u32,
        peak_evals: u32,
        /// Edge 实例是否在跑(false = 探活失败,走冷启动路径)
        running: bool,
    }

    struct FakeOps {
        inner: Mutex<FakeOpsInner>,
    }

    impl FakeOps {
        fn new() -> Self {
            Self {
                inner: Mutex::new(FakeOpsInner {
                    running: true, // 缺省实例在跑;测试可置 false 模拟 Edge 未启动/已退出
                    ..FakeOpsInner::default()
                }),
            }
        }

        fn state(&self) -> std::sync::MutexGuard<'_, FakeOpsInner> {
            self.inner.lock().unwrap()
        }
    }

    impl CdpOps for FakeOps {
        async fn kill_and_launch(&self, _profile: &Path, url: &str) -> Result<(), String> {
            let mut s = self.state();
            s.launched += 1;
            s.pages.clear(); // 进程死亡 = 全部标签页消失
                             // 真实行为:Edge 以 URL 参数启动 = 新实例第一个窗口就打开该页
            s.next_id += 1;
            let id = format!("t{}", s.next_id);
            s.pages.push((id, url.to_string()));
            s.running = true;
            Ok(())
        }

        async fn probe_port(&self, _profile: &Path) -> Option<u16> {
            self.state().running.then_some(9222)
        }

        async fn list_pages(&self, _port: u16) -> Result<Vec<(String, String)>, String> {
            Ok(self.state().pages.clone())
        }

        async fn create_page(&self, _port: u16, url: &str) -> Result<String, String> {
            let mut s = self.state();
            s.next_id += 1;
            let id = format!("t{}", s.next_id);
            s.pages.push((id.clone(), url.to_string()));
            Ok(id)
        }

        async fn close_page(&self, _port: u16, target_id: &str) -> Result<(), String> {
            self.state().pages.retain(|(id, _)| id != target_id);
            Ok(())
        }

        async fn eval(
            &self,
            _port: u16,
            target_id: &str,
            expr: &str,
            _t: u64,
        ) -> Result<Value, String> {
            {
                let mut s = self.state();
                if !s.pages.iter().any(|(id, _)| id == target_id) {
                    return Err("Target closed".into()); // 标签页没了 = 上下文丢失
                }
                s.active_evals += 1;
                s.peak_evals = s.peak_evals.max(s.active_evals);
            }
            // 上下文稳定探测:返回 https URL 即通过
            if expr.contains("location.href") {
                let mut s = self.state();
                s.active_evals = s.active_evals.saturating_sub(1);
                return Ok(json!("https://chat.deepseek.com"));
            }
            let delay = self.state().eval_delay_ms;
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let mut s = self.state();
            s.active_evals = s.active_evals.saturating_sub(1);
            // 抓取快照:页面 JS 返回 JSON 字符串(外层 as_str 再解析)
            Ok(json!(
                json!({ "busy": false, "text": "回复文本", "count": 1 }).to_string()
            ))
        }

        async fn eval_await(
            &self,
            _port: u16,
            target_id: &str,
            _expr: &str,
            _t: u64,
        ) -> Result<Value, String> {
            let mut s = self.state();
            if !s.pages.iter().any(|(id, _)| id == target_id) {
                return Err("Target closed".into());
            }
            if s.drop_target_after_send {
                s.pages.retain(|(id, _)| id != target_id);
            }
            drop(s);
            Ok(json!({ "sent": true, "beforeCount": 0 }))
        }
    }

    fn hub_with(ops: FakeOps) -> Arc<HubState<FakeOps>> {
        Arc::new(HubState::new(Arc::new(ops)))
    }

    fn profile() -> PathBuf {
        std::env::temp_dir().join("webchat-hub-test")
    }

    fn cancel_of(hub: &Arc<HubState<FakeOps>>, request_id: &str) {
        if let Ok(map) = hub.requests.lock() {
            if let Some(h) = map.get(request_id) {
                h.cancel();
            }
        }
    }

    async fn ask_conv(
        hub: &Arc<HubState<FakeOps>>,
        request_id: &str,
        key: &str,
        timeout_ms: u64,
    ) -> Result<String, String> {
        let deadline = Deadline::after_ms(timeout_ms);
        let mut trace = TraceBuilder::new(request_id);
        let guard = RequestGuard::register(&hub.requests, request_id);
        let cancel = guard.handle();
        run_conversation(
            hub,
            &profile(),
            key,
            "prompt",
            "deepseek",
            false,
            &cancel,
            deadline,
            &mut trace,
        )
        .await
        .map_err(|f| f.msg())
    }

    #[tokio::test]
    async fn same_key_serial_different_keys_parallel() {
        let ops = FakeOps::new();
        ops.state().eval_delay_ms = 80;
        let hub = hub_with(ops);
        let (h1, h2) = (hub.clone(), hub.clone());
        let t0 = std::time::Instant::now();
        let a = tokio::spawn(async move { ask_conv(&h1, "r1", "k1", 10_000).await });
        let b = tokio::spawn(async move { ask_conv(&h2, "r2", "k1", 10_000).await });
        let (ra, rb) = tokio::join!(a, b);
        assert!(ra.unwrap().is_ok() && rb.unwrap().is_ok());
        // 串行:同 key 两次 ask 总耗时 ≥ 2 × eval 延时,且 eval 不并发
        assert!(t0.elapsed() >= Duration::from_millis(160));
        assert_eq!(hub.ops.state().peak_evals, 1, "同 key 不允许并发 eval");

        // 不同 key 并行:eval 延时 300ms、ask 起点错开 100ms → eval 必然重叠
        let ops2 = FakeOps::new();
        ops2.state().eval_delay_ms = 300;
        let hub2 = Arc::new(HubState::new(Arc::new(ops2)));
        let (h3, h4) = (hub2.clone(), hub2.clone());
        let c = tokio::spawn(async move { ask_conv(&h3, "r3", "k2", 15_000).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        let d = tokio::spawn(async move { ask_conv(&h4, "r4", "k3", 15_000).await });
        let (rc, rd) = tokio::join!(c, d);
        assert!(rc.unwrap().is_ok() && rd.unwrap().is_ok());
        assert_eq!(hub2.ops.state().peak_evals, 2, "不同 key 应并行 eval");
    }

    #[tokio::test]
    async fn cancel_while_waiting_permit_is_immediate() {
        let ops = FakeOps::new();
        ops.state().eval_delay_ms = 5_000; // 占住生成槽的 ask 很慢
        let hub = hub_with(ops);
        let (h1, h2, h3) = (hub.clone(), hub.clone(), hub.clone());
        let slow = tokio::spawn(async move { ask_conv(&h1, "slow", "k1", 30_000).await });
        tokio::time::sleep(Duration::from_millis(100)).await; // slow 拿到槽 1
        let slow2 = tokio::spawn(async move { ask_conv(&h2, "slow2", "k2", 30_000).await });
        tokio::time::sleep(Duration::from_millis(100)).await; // slow2 拿到槽 2,槽满
        let queued = tokio::spawn(async move { ask_conv(&h3, "queued", "k3", 30_000).await });
        tokio::time::sleep(Duration::from_millis(100)).await; // queued 在等槽
        cancel_of(&hub, "queued"); // 取消排队中的请求
        let r = tokio::time::timeout(Duration::from_millis(2_000), queued).await;
        assert!(r.is_ok(), "取消应即时生效,不等槽释放");
        assert_eq!(r.unwrap().unwrap(), Err(CANCELLED.to_string()));
        let _ = slow.await;
        let _ = slow2.await;
    }

    #[tokio::test]
    async fn sent_then_target_lost_returns_typed_error() {
        let ops = FakeOps::new();
        ops.state().drop_target_after_send = true;
        let hub = hub_with(ops);
        let r = ask_conv(&hub, "lost", "k1", 10_000).await.unwrap_err();
        assert_eq!(r, LOST_AFTER_SEND);
        // 不建空页继续轮询:失败后没有任何新标签页
        assert!(hub.ops.state().pages.is_empty());
    }

    #[tokio::test]
    async fn cancel_unknown_is_noop_and_guard_cleans_up() {
        let hub = hub_with(FakeOps::new());
        cancel_of(&hub, "nonexistent"); // 未知请求:无注册项 → no-op 不 panic
        assert!(hub.requests.lock().unwrap().is_empty());
        // ask 离场后注册项被 RAII 清除
        let _ = ask_conv(&hub, "done", "k1", 10_000).await;
        assert!(hub.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn deadline_bounds_the_ask() {
        let ops = FakeOps::new();
        ops.state().eval_delay_ms = 5_000;
        let hub = hub_with(ops);
        let t0 = std::time::Instant::now();
        let r = ask_conv(&hub, "slow", "k1", 800).await.unwrap_err();
        assert_eq!(r, "网页生成超时");
        assert!(t0.elapsed() < Duration::from_millis(4_000));
    }

    #[tokio::test]
    async fn restart_bumps_epoch_and_invalidates_handles() {
        let hub = hub_with(FakeOps::new());
        let _ = ask_conv(&hub, "r1", "k1", 10_000).await.unwrap();
        let old_pages = hub.ops.state().pages.len();
        assert!(old_pages >= 1);
        // 模拟 webchat_login 的重启语义:取消全部 → 写租约 → 重启 → epoch+1 → 清句柄
        hub.cancel_all();
        {
            let mut w = hub.edge.write().await;
            hub.ops
                .kill_and_launch(&profile(), "https://chat.deepseek.com")
                .await
                .unwrap();
            w.epoch += 1;
            hub.conversations.lock().await.clear();
        }
        assert!(hub.conversations.lock().await.is_empty());
        // 重启后同 key ask:全新标签页(旧的已随进程消失)
        let _ = ask_conv(&hub, "r2", "k1", 10_000).await.unwrap();
        let s = hub.ops.state();
        // 重启实例的启动页(以 URL 参数打开) + 为该 key 新建的会话页
        assert_eq!(s.pages.len(), 2);
        assert!(s.launched >= 1);
    }

    /// 登录复用路径(回归:多 AI 剧场两个站点并存的关键):
    /// 实例在跑时"打开登录窗口"只开新标签页,其他站点标签页与会话句柄原样存活
    #[tokio::test]
    async fn login_reuses_running_instance_and_keeps_other_tabs() {
        let hub = hub_with(FakeOps::new());
        // 甲(deepseek)已有一场会话
        let _ = ask_conv(&hub, "r1", "relay:e1:A", 10_000).await.unwrap();
        let before = hub.ops.state().pages.len();
        assert_eq!(before, 1);
        // 给乙(豆包)打开登录窗口:实例在跑,不允许杀实例
        let outcome = hub
            .open_login(&profile(), "https://www.doubao.com/chat/")
            .await
            .unwrap();
        assert_eq!(outcome, LoginOutcome::Reused);
        {
            // std Mutex 不可重入:守卫用完即释放,别跨断言持有(否则下面再锁即死锁)
            let s = hub.ops.state();
            assert_eq!(s.launched, 0, "复用路径不得重启 Edge");
            assert_eq!(s.pages.len(), before + 1, "登录只应新增一个标签页");
        }
        // 甲的会话句柄原样存活,且旧标签页仍在(豆包/深寻互不干扰)
        let map = hub.conversations.lock().await;
        assert!(map.contains_key("relay:e1:A"));
        let slot = map.get("relay:e1:A").unwrap().clone();
        drop(map);
        let tid = slot.state.lock().await.target_id.clone().unwrap();
        drop(slot);
        assert!(
            hub.ops.state().pages.iter().any(|(id, _)| id == &tid),
            "原会话标签页必须存活"
        );
        // 再问一次同 key:复用原标签页,不再新建
        let _ = ask_conv(&hub, "r2", "relay:e1:A", 10_000).await.unwrap();
        assert_eq!(hub.ops.state().pages.len(), before + 1);
    }

    /// 冷启动路径:实例真没在跑才重启;epoch 失效、会话句柄清空
    #[tokio::test]
    async fn login_cold_starts_when_edge_not_running() {
        let hub = hub_with(FakeOps::new());
        let _ = ask_conv(&hub, "r1", "relay:e1:A", 10_000).await.unwrap();
        let epoch_before = hub.edge.read().await.epoch;
        hub.ops.state().running = false; // 用户把 Edge 整个关了
        let outcome = hub
            .open_login(&profile(), "https://chat.deepseek.com/")
            .await
            .unwrap();
        assert_eq!(outcome, LoginOutcome::ColdStarted);
        assert_eq!(hub.ops.state().launched, 1);
        assert!(
            hub.edge.read().await.epoch > epoch_before,
            "冷启动必须失效旧句柄"
        );
        assert!(
            hub.conversations.lock().await.is_empty(),
            "旧会话句柄应被清空"
        );
        assert!(hub.ops.state().running, "冷启动后实例应在跑");
    }

    #[tokio::test]
    async fn sweeper_skips_active_slot_and_closes_idle_one() {
        let ops = FakeOps::new();
        ops.state().eval_delay_ms = 2_000;
        let hub = hub_with(ops);
        // 在飞 ask:key_lock 被持有
        let h1 = hub.clone();
        let inflight = tokio::spawn(async move { ask_conv(&h1, "busy", "k_active", 30_000).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        // 已完成的会话:回拨 last_used 到阈值外
        let _ = ask_conv(&hub, "idle", "k_idle", 10_000).await.unwrap();
        {
            let map = hub.conversations.lock().await;
            let slot = map.get("k_idle").unwrap();
            let mut st = slot.state.try_lock().unwrap();
            st.last_used_at = Instant::now() - Duration::from_secs(HUB_IDLE_SECS + 60);
        }
        hub.sweep_idle().await;
        assert!(
            hub.conversations.lock().await.contains_key("k_active"),
            "在飞会话不被清"
        );
        assert!(
            !hub.conversations.lock().await.contains_key("k_idle"),
            "闲置会话被清"
        );
        let _ = inflight.await;
    }

    /// 真机 CDP 冒烟:拉起专用 Edge(临时 profile)→ 浏览器级 Target 域 → 页面 evaluate。
    /// 会短暂弹出 Edge 窗口;CI 跳过,本机 `cargo test -- --ignored` 验证。
    /// profile 目录名含 "webchat-edge-profile",kill_profile_edge 按命令行过滤能清掉它
    #[test]
    #[ignore = "真机冒烟:拉起 Edge 并走完整 CDP 链路;CI 跳过"]
    fn webchat_cdp_smoke() {
        let profile =
            std::env::temp_dir().join(format!("webchat-edge-profile-smoke-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let ops = RealCdpOps;
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            ops.kill_and_launch(&profile, "https://chat.deepseek.com")
                .await
                .expect("kill_and_launch(端口文件 + 浏览器级 WS)");
            let port = ops.probe_port(&profile).await.expect("probe_port");
            let target = ops
                .create_page(port, "https://chat.deepseek.com")
                .await
                .expect("Target.createTarget");
            // createTarget 返回时页面还在 about:blank,导航到站点是异步的——
            // 与 generation 的上下文稳定等待同款,有界重试
            let mut href = Value::Null;
            for _ in 0..30 {
                href = ops
                    .eval(port, &target, "location.href", 5000)
                    .await
                    .unwrap_or(Value::Null);
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
