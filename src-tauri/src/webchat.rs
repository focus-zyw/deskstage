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

use std::collections::{HashMap, HashSet};
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

pub mod activity;
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
/// 应用自管的显式 CDP 端口文件。不能使用 Chromium 的 port=0：它会把
/// navigator.webdriver 置为 true，Google 等 OAuth 提供方会据此拦截登录。
const DEBUG_PORT_FILE: &str = "WebchatDebugPort";
/// 会话闲置清理阈值:超过该时长的标签页由 sweeper 关闭(崩溃兜底)
pub const HUB_IDLE_SECS: u64 = 30 * 60;
/// ResponseStarted(确认回复已开始生成)后的额外观察窗:慢响应/深度思考
/// 不再被原总超时掐死
const RESPONSE_STARTED_EXTRA_MS: u64 = 120_000;
/// 同会话连续失败的指数退避基数与上限(1s→2s→4s→8s→16s,封顶 30s)
const BACKOFF_BASE_MS: u64 = 1_000;
const BACKOFF_CAP_MS: u64 = 30_000;
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

    /// 延长观察窗(ResponseStarted 跃迁时调用:慢响应不被原总超时掐死)
    fn extend(&mut self, ms: u64) {
        self.at += Duration::from_millis(ms);
    }
}

/// 失败分类:命令层只对外暴露固定文案(前端据此识别取消/超时/发送后丢失)
enum AskFail {
    Cancelled,
    Timeout,
    LostAfterSend,
    /// 页面活性失败:页面活着但软唤醒+双脉冲后模型仍不动(方案 §七/§九)。
    /// 前端两段式恢复按普通失败接管,换代 + 全量上下文重发 → Hub 侧建独立窗口
    Stalled,
    Failed(String),
}

/// 生成阶段状态机:恢复策略按阶段分派(见 generation)。
/// Disconnected 是进入 generation 前的语义书档(读租约获取即 Connected),
/// 单独保留以完整表达状态空间
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum AskPhase {
    Disconnected,
    Connected,
    PageReady,
    Sent,
    ResponseStarted,
    Completed,
}

impl AskPhase {
    fn name(self) -> &'static str {
        match self {
            AskPhase::Disconnected => "phase:disconnected",
            AskPhase::Connected => "phase:connected",
            AskPhase::PageReady => "phase:page_ready",
            AskPhase::Sent => "phase:sent",
            AskPhase::ResponseStarted => "phase:response_started",
            AskPhase::Completed => "phase:completed",
        }
    }
}

impl AskFail {
    /// 超时按阶段给出具体诊断(模型慢?页面没就绪?),不再只是笼统超时
    fn timeout_hinted(phase: AskPhase) -> AskFail {
        let detail = if phase >= AskPhase::ResponseStarted {
            "模型响应慢(已在生成,超出延长观察窗)"
        } else if phase >= AskPhase::Sent {
            "已发送但模型迟迟未开始响应"
        } else {
            "页面/网络未就绪"
        };
        AskFail::Failed(format!("网页生成超时 —— 诊断:{detail}"))
    }

    fn msg(&self) -> String {
        match self {
            AskFail::Cancelled => CANCELLED.into(),
            AskFail::Timeout => "网页生成超时".into(),
            AskFail::LostAfterSend => LOST_AFTER_SEND.into(),
            AskFail::Stalled => "页面长时间无进展(已软唤醒与激活仍未恢复)".into(),
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
    /// placement:Tab = 普通标签页(登录复用/会话重建);DedicatedWindow = 独立窗口
    /// (Target.createTarget newWindow,同 profile 免登录;站点持续无法后台生成时)
    async fn create_page(
        &self,
        port: u16,
        url: &str,
        placement: activity::TargetPlacement,
    ) -> Result<String, String>;
    async fn close_page(&self, port: u16, target_id: &str) -> Result<(), String>;
    /// 将目标标签页切为当前活动页，避免站点在后台页暂停提交或生成。
    async fn activate_page(&self, port: u16, target_id: &str) -> Result<(), String>;
    /// 生成期间的常驻页面会话(软唤醒的 Emulation 覆盖挂在它上面);
    /// 打不开时软唤醒降级跳过,梯子仍有激活脉冲
    async fn open_page_session(&self, port: u16, target_id: &str) -> Result<PageSession, String>;
    /// 软唤醒(方案 §四):不切标签页、不抢用户焦点、不 reload、不重发。
    /// 会话态的焦点/空闲覆盖挂常驻连接;单条失败整包报错,由调用方记轨迹继续
    async fn soft_wake(&self, session: &mut PageSession) -> Result<(), String>;
    /// 激活脉冲(方案 §五):一次性 bringToFront,命令结束即释放,
    /// 不等待回复;调用方先过 PulseCoordinator 节流
    async fn activation_pulse(&self, port: u16, target_id: &str) -> Result<(), String>;
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

fn reserve_debug_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
        .map_err(|e| format!("分配 Edge 调试端口失败: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读取 Edge 调试端口失败: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn launch_edge(profile: &Path, url: &str) -> Result<u16, String> {
    use std::process::Stdio;
    let exe = find_edge()?;
    std::fs::create_dir_all(profile).map_err(|e| e.to_string())?;
    let port = reserve_debug_port()?;
    std::fs::write(profile.join(DEBUG_PORT_FILE), port.to_string())
        .map_err(|e| format!("保存 Edge 调试端口失败: {e}"))?;
    let mut cmd = Command::new(exe);
    cmd.args(edge_launch_args(profile, url, port));
    // stdio 接 null:Edge 生命周期远长于调用方,若继承 stdout/stderr 管道,
    // 读管道的一侧(cargo test / tauri dev 终端)会因等不到 EOF 卡死
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Err(e) = cmd.spawn() {
        let _ = std::fs::remove_file(profile.join(DEBUG_PORT_FILE));
        return Err(format!("启动 Edge 失败({exe}): {e}"));
    }
    Ok(port)
}

fn edge_launch_args(profile: &Path, url: &str, port: u16) -> Vec<String> {
    vec![
        format!("--remote-debugging-port={port}"),
        "--remote-debugging-address=127.0.0.1".into(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-background-timer-throttling".into(),
        "--disable-backgrounding-occluded-windows".into(),
        "--disable-renderer-backgrounding".into(),
        "--window-size=960,760".into(),
        url.into(),
    ]
}

/// 新版读取应用自管的显式端口；旧版 port=0 实例仍可从 DevToolsActivePort 迁移探活。
fn read_debug_port(profile: &Path) -> Option<u16> {
    std::fs::read_to_string(profile.join(DEBUG_PORT_FILE))
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .or_else(|| {
            std::fs::read_to_string(profile.join("DevToolsActivePort"))
                .ok()?
                .lines()
                .next()?
                .trim()
                .parse()
                .ok()
        })
}

/// 显式非零端口不会生成可依赖的 DevToolsActivePort 浏览器路径，改从 Chromium
/// 官方 discovery endpoint 读取 browser WebSocket URL，再只保留其路径。
async fn discover_browser_path(port: u16) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(1500))
        .build()
        .map_err(|e| format!("创建 Edge 探活客户端失败: {e}"))?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .await
        .map_err(|e| format!("Edge discovery 连接失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Edge discovery 返回 HTTP {}", response.status()));
    }
    let body: Value = serde_json::from_str(
        &response
            .text()
            .await
            .map_err(|e| format!("读取 Edge discovery 失败: {e}"))?,
    )
    .map_err(|e| format!("解析 Edge discovery 失败: {e}"))?;
    let ws_url = body
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "Edge discovery 缺少 browser WebSocket 地址".to_string())?;
    let parsed = url::Url::parse(ws_url).map_err(|e| format!("浏览器调试地址无效: {e}"))?;
    if parsed.scheme() != "ws" || !parsed.path().starts_with("/devtools/browser/") {
        return Err("Edge discovery 返回了非 browser WebSocket 地址".into());
    }
    Ok(parsed.path().to_string())
}

async fn connect_ws(url: String) -> Result<WsStream, String> {
    // Windows 上 connect_async(String) 对真实 Edge 调试端口偶发走到无效地址
    // (WSAEADDRNOTAVAIL/10049)，尽管同端口的 HTTP 与显式 IPv4 TCP 都可达。
    // CDP 地址由本模块构造且恒为本机，先钉死 IPv4 loopback socket，再在该
    // socket 上做握手，避免 ToSocketAddrs 的平台解析分支。
    let parsed = url::Url::parse(&url).map_err(|e| format!("Edge 调试地址无效: {e}"))?;
    if parsed.scheme() != "ws" || parsed.host_str() != Some("127.0.0.1") {
        return Err("Edge 调试地址必须是本机 ws://127.0.0.1".into());
    }
    let port = parsed
        .port()
        .ok_or_else(|| "Edge 调试地址缺少端口".to_string())?;
    let socket = TokioTcpStream::connect(std::net::SocketAddr::from(([127, 0, 0, 1], port)))
        .await
        .map_err(|e| format!("连接 Edge 调试端口失败: {e}"))?;
    let (ws, _) = tokio_tungstenite::client_async(url, MaybeTlsStream::Plain(socket))
        .await
        .map_err(|e| format!("Edge WebSocket 握手失败: {e}"))?;
    Ok(ws)
}

/// 浏览器级短连接(自管端口 → HTTP discovery → WS);每次操作即建即弃
async fn browser_connect(profile: &Path) -> Result<(u16, Cdp), String> {
    let Some(port) = read_debug_port(profile) else {
        return Err("Edge 调试端口文件不存在(Edge 未启动)".into());
    };
    let path = discover_browser_path(port).await?;
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

/// 页面级常驻会话:生成期间持有同一 target 的 WS 连接(最多两条,双生成槽各一)。
/// 软唤醒的 Emulation 覆盖(setFocusEmulationEnabled/setIdleOverride)是会话态——
/// 短连接发完即断会被渲染进程复位,必须挂在常驻连接上才持续生效;ask 结束
/// 断开即自动清除,无残留。页面导航销毁执行上下文后按同 target 重连
pub struct PageSession {
    port: u16,
    target_id: String,
    cdp: Option<Cdp>,
}

impl PageSession {
    fn new(port: u16, target_id: &str) -> Self {
        Self {
            port,
            target_id: target_id.to_string(),
            cdp: None,
        }
    }

    /// 导航重建标签页后改盯新目标(丢弃旧连接,下次调用重连)
    fn retarget(&mut self, target_id: &str) {
        if self.target_id != target_id {
            self.target_id = target_id.to_string();
            self.cdp = None;
        }
    }

    async fn connect(&mut self) -> Result<(), String> {
        if self.cdp.is_some() {
            return Ok(());
        }
        let ws = connect_ws(format!(
            "ws://127.0.0.1:{}/devtools/page/{}",
            self.port, self.target_id
        ))
        .await?;
        self.cdp = Some(Cdp::new(ws));
        Ok(())
    }

    async fn call(
        &mut self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        self.connect().await?;
        // 连接死亡(导航/空闲掐断)重连一次再试;target 真没了则持续失败,
        // 由调用方按"软唤醒不可用"记录并继续梯子
        let first = self
            .cdp
            .as_mut()
            .expect("connect 已确保")
            .call(method, params.clone(), timeout_ms)
            .await;
        match first {
            Ok(v) => Ok(v),
            Err(e) if is_context_lost(&e) => {
                self.cdp = None;
                self.connect().await?;
                self.cdp
                    .as_mut()
                    .expect("connect 已确保")
                    .call(method, params, timeout_ms)
                    .await
            }
            Err(e) => Err(e),
        }
    }
}

/// 桌面端真实传输:每次操作新建短连接(本机 WS 连接毫秒级,轮询间隔 300ms 完全淹没)。
/// Chromium 的浏览器级 WS 路径包含启动时生成的 UUID；probe 时从
/// `/json/version` 读取并按端口缓存，Target 域操作必须复用该路径。
#[derive(Default)]
pub struct RealCdpOps {
    browser_paths: Mutex<HashMap<u16, String>>,
}

impl RealCdpOps {
    fn remember_browser_path(&self, port: u16, path: &str) {
        if let Ok(mut paths) = self.browser_paths.lock() {
            paths.insert(port, path.to_string());
        }
    }

    async fn browser_cdp(&self, port: u16) -> Result<Cdp, String> {
        let path = self
            .browser_paths
            .lock()
            .map_err(|e| e.to_string())?
            .get(&port)
            .cloned()
            .ok_or_else(|| "Edge 浏览器调试路径尚未探活".to_string())?;
        let ws = connect_ws(format!("ws://127.0.0.1:{port}{path}")).await?;
        Ok(Cdp::new(ws))
    }
}

impl CdpOps for RealCdpOps {
    async fn kill_and_launch(&self, profile: &Path, url: &str) -> Result<(), String> {
        kill_profile_edge();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let port = launch_edge(profile, url)?;
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(EDGE_READY_SECS) {
            if let Ok(path) = discover_browser_path(port).await {
                let attempt = tokio::time::timeout(
                    Duration::from_millis(1200),
                    connect_ws(format!("ws://127.0.0.1:{port}{path}")),
                )
                .await;
                if let Ok(Ok(_)) = attempt {
                    self.remember_browser_path(port, &path);
                    return Ok(());
                }
            }
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
        Err(format!("Edge 调试通道 {EDGE_READY_SECS} 秒未就绪"))
    }

    async fn probe_port(&self, profile: &Path) -> Option<u16> {
        let port = read_debug_port(profile)?;
        let path = discover_browser_path(port).await.ok()?;
        connect_ws(format!("ws://127.0.0.1:{port}{path}"))
            .await
            .ok()?;
        self.remember_browser_path(port, &path);
        Some(port)
    }

    async fn list_pages(&self, port: u16) -> Result<Vec<(String, String)>, String> {
        let mut browser = self.browser_cdp(port).await?;
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

    async fn create_page(
        &self,
        port: u16,
        url: &str,
        placement: activity::TargetPlacement,
    ) -> Result<String, String> {
        let mut browser = self.browser_cdp(port).await?;
        // newWindow=true = 独立窗口(同 profile、同进程,免登录);
        // background=false = 前台激活——站点对完全不可见的窗口仍会暂停生成
        let mut params = json!({ "url": url });
        if placement == activity::TargetPlacement::DedicatedWindow {
            params["newWindow"] = json!(true);
            params["background"] = json!(false);
        }
        let res = browser.call("Target.createTarget", params, 15_000).await?;
        res.get("targetId")
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| "打开标签页失败".into())
    }

    async fn close_page(&self, port: u16, target_id: &str) -> Result<(), String> {
        let mut browser = self.browser_cdp(port).await?;
        browser
            .call("Target.closeTarget", json!({ "targetId": target_id }), 5000)
            .await?;
        Ok(())
    }

    async fn activate_page(&self, port: u16, target_id: &str) -> Result<(), String> {
        let mut cdp =
            Cdp::new(connect_ws(format!("ws://127.0.0.1:{port}/devtools/page/{target_id}")).await?);
        cdp.call("Page.bringToFront", json!({}), 5000).await?;
        Ok(())
    }

    async fn open_page_session(&self, port: u16, target_id: &str) -> Result<PageSession, String> {
        // 连接惰性建立:open 只登记 target,首条软唤醒命令时才连
        Ok(PageSession::new(port, target_id))
    }

    async fn soft_wake(&self, session: &mut PageSession) -> Result<(), String> {
        // 逐条执行;覆盖是会话态,断开自动清除,无残留(方案 §四)
        session
            .call(
                "Page.setWebLifecycleState",
                json!({ "state": "active" }),
                5000,
            )
            .await?;
        session
            .call(
                "Emulation.setFocusEmulationEnabled",
                json!({ "enabled": true }),
                5000,
            )
            .await?;
        session
            .call(
                "Emulation.setIdleOverride",
                json!({ "isUserActive": true, "isScreenUnlocked": true }),
                5000,
            )
            .await?;
        // window.focus 无用户手势通常被忽略,但配合焦点模拟对部分站点有效
        session
            .call(
                "Runtime.evaluate",
                json!({ "expression": "window.focus && window.focus()", "returnByValue": true }),
                3000,
            )
            .await?;
        Ok(())
    }

    async fn activation_pulse(&self, port: u16, target_id: &str) -> Result<(), String> {
        self.activate_page(port, target_id).await
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
    /// true = Hub 为该会话创建，可在释放时关闭；false = 用户预先打开的登录页，只解除占用。
    target_owned: bool,
    edge_epoch: u64,
    turn_count: u32,
    last_used_at: Instant,
    released: bool,
    /// 同会话连续失败计数(成功清零):驱动下一次 ask 的指数退避
    consecutive_failures: u32,
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
                target_owned: false,
                edge_epoch: 0,
                turn_count: 0,
                last_used_at: Instant::now(),
                released: false,
                consecutive_failures: 0,
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
    /// 已被 Conversation 路由认领的 target，防止两个同站点角色抢到同一登录页。
    claimed_targets: tokio::sync::Mutex<HashSet<String>>,
    requests: Arc<Mutex<HashMap<String, Arc<CancellationHandle>>>>,
    /// Conversation 路由的全局生成槽;Shared 路由走自己的单飞槽,互不占位
    permits: Arc<Semaphore>,
    /// Shared 路由单飞(与旧通道外部行为一致:同时只允许一个 ask)
    inflight: Mutex<Option<String>>,
    /// 活性恢复梯子阈值(测试注入快策略;默认值见 activity::ActivityPolicy)
    activity_policy: activity::ActivityPolicy,
    /// 激活脉冲全局节流(两个生成任务同时停滞时不疯狂切标签页)
    pulse: Mutex<activity::PulseCoordinator>,
    /// 站点健康总账(Tab/DedicatedPending/Dedicated + 用户覆盖;按站点分账)
    site_health: Mutex<activity::SiteHealthBook>,
}

/// 生成路由差异:target 解析与"丢失恢复"策略
#[derive(Clone)]
enum Route {
    Shared { host: String },
    Conversation,
}

/// generation 的成功产物:回复正文 + 本轮是否动用过激活脉冲
/// (后者是站点健康 3-of-5 规则的输入)
struct GenerationOutcome {
    text: String,
    used_pulse: bool,
}

impl<O: CdpOps> HubState<O> {
    pub fn new(ops: Arc<O>) -> Self {
        Self {
            ops,
            edge: tokio::sync::RwLock::new(EdgeRuntime { port: 0, epoch: 1 }),
            conversations: tokio::sync::Mutex::new(HashMap::new()),
            claimed_targets: tokio::sync::Mutex::new(HashSet::new()),
            requests: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(Semaphore::new(HUB_PERMITS)),
            inflight: Mutex::new(None),
            activity_policy: activity::ActivityPolicy::default(),
            pulse: Mutex::new(activity::PulseCoordinator::new()),
            site_health: Mutex::new(activity::SiteHealthBook::default()),
        }
    }

    /// 测试注入快策略:默认阈值(6s~60s)对单测太慢
    #[cfg(test)]
    fn with_activity_policy(mut self, policy: activity::ActivityPolicy) -> Self {
        self.activity_policy = policy;
        self
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
            let probed_port = within(
                self.probe_running(profile, deadline),
                cancel,
                deadline,
                "edge",
            )
            .await?;
            if let Some(port) = probed_port {
                if guard.port == port {
                    return Ok(guard);
                }
                // Hub 刚创建时 port=0；或用户在外部重启了专用 Edge 导致端口变化。
                // 升写锁同步真实端口，下一轮再交付覆盖整段 ask 的读租约。
                drop(guard);
                let mut w = within(self.edge.write(), cancel, deadline, "edge").await?;
                let latest = within(
                    self.probe_running(profile, deadline),
                    cancel,
                    deadline,
                    "edge",
                )
                .await?;
                if let Some(latest) = latest {
                    if w.port != latest {
                        let replaced_running_edge = w.port != 0;
                        w.port = latest;
                        if replaced_running_edge {
                            w.epoch += 1;
                            self.conversations.lock().await.clear();
                            self.claimed_targets.lock().await.clear();
                        }
                    }
                }
                drop(w);
                continue;
            }
            drop(guard);
            // 升写:杀旧拉新(写者之间互斥;另一写者刚修好则直接回落读)
            let mut w = within(self.edge.write(), cancel, deadline, "edge").await?;
            let current_port = within(
                self.probe_running(profile, deadline),
                cancel,
                deadline,
                "edge",
            )
            .await?;
            if let Some(port) = current_port {
                if w.port != port {
                    let replaced_running_edge = w.port != 0;
                    w.port = port;
                    if replaced_running_edge {
                        w.epoch += 1;
                        self.conversations.lock().await.clear();
                        self.claimed_targets.lock().await.clear();
                    }
                }
            } else {
                self.ops
                    .kill_and_launch(profile, url)
                    .await
                    .map_err(AskFail::Failed)?;
                let t0 = Instant::now();
                let launched_port = loop {
                    if let Some(port) = self.ops.probe_port(profile).await {
                        break port;
                    }
                    if t0.elapsed() > Duration::from_secs(EDGE_READY_SECS) {
                        return Err(AskFail::Failed(format!(
                            "Edge 调试通道 {EDGE_READY_SECS} 秒未就绪"
                        )));
                    }
                    tokio::time::sleep(Duration::from_millis(600)).await;
                };
                w.port = launched_port;
                w.epoch += 1;
                self.conversations.lock().await.clear();
                self.claimed_targets.lock().await.clear();
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

    /// Shared 路由的站点标签页:复用同宿主页,没有才建。
    /// 站点已升级(Pending/Dedicated)时直接开独立窗口
    async fn find_or_create_shared(
        &self,
        port: u16,
        site: &str,
        cancel: &CancellationHandle,
        deadline: Deadline,
    ) -> Result<String, AskFail> {
        let a = adapter(site).ok_or_else(|| AskFail::Failed(format!("未知站点: {site}")))?;
        let pages = self.op(self.ops.list_pages(port), cancel, deadline).await?;
        if let Some((id, _)) = pages.iter().rev().find(|p| p.1.contains(a.host)) {
            return Ok(id.clone());
        }
        let placement = {
            let book = self.site_health.lock();
            if book.is_ok_and(|b| b.effective_mode(site) != activity::SiteMode::Tab) {
                activity::TargetPlacement::DedicatedWindow
            } else {
                activity::TargetPlacement::Tab
            }
        };
        self.op(
            self.ops.create_page(port, a.url, placement),
            cancel,
            deadline,
        )
        .await
    }

    /// 优先认领用户已打开并登录的同站点页；没有可用页时才创建会话页。
    /// claimed_targets 的锁覆盖“选择/创建/登记”，保证同站点并发会话不会抢同一页。
    /// 站点已升级(Pending/Dedicated)时跳过认领,直接开独立窗口(§九/§十):
    /// 只发生在会话重建点(reset/句柄丢失),进行中的会话绝不中途迁移
    async fn claim_or_create_conversation_target(
        &self,
        port: u16,
        site: &str,
        cancel: &CancellationHandle,
        deadline: Deadline,
    ) -> Result<(String, bool), AskFail> {
        let a = adapter(site).ok_or_else(|| AskFail::Failed(format!("未知站点: {site}")))?;
        let mode = self
            .site_health
            .lock()
            .map(|book| book.effective_mode(site))
            .unwrap_or(activity::SiteMode::Tab); // 毒化保守回落标签页(毒化仅 panics 时发生)
        if mode != activity::SiteMode::Tab {
            let tid = self
                .op(
                    self.ops
                        .create_page(port, a.url, activity::TargetPlacement::DedicatedWindow),
                    cancel,
                    deadline,
                )
                .await?;
            if let Ok(mut book) = self.site_health.lock() {
                book.note_promoted(site, Instant::now());
            }
            let mut claimed = self.claimed_targets.lock().await;
            claimed.insert(tid.clone());
            return Ok((tid, true));
        }
        let pages = self.op(self.ops.list_pages(port), cancel, deadline).await?;
        let mut claimed = self.claimed_targets.lock().await;
        if let Some((id, _)) = pages
            .iter()
            .rev()
            .find(|(id, url)| url.contains(a.host) && !claimed.contains(id))
        {
            claimed.insert(id.clone());
            return Ok((id.clone(), false));
        }
        let tid = self
            .op(
                self.ops
                    .create_page(port, a.url, activity::TargetPlacement::Tab),
                cancel,
                deadline,
            )
            .await?;
        claimed.insert(tid.clone());
        Ok((tid, true))
    }

    async fn create_claimed_conversation_target(
        &self,
        port: u16,
        site: &str,
        cancel: &CancellationHandle,
        deadline: Deadline,
    ) -> Result<String, AskFail> {
        let url = adapter(site)
            .ok_or_else(|| AskFail::Failed(format!("未知站点: {site}")))?
            .url;
        let mut claimed = self.claimed_targets.lock().await;
        let tid = self
            .op(
                self.ops
                    .create_page(port, url, activity::TargetPlacement::Tab),
                cancel,
                deadline,
            )
            .await?;
        claimed.insert(tid.clone());
        Ok(tid)
    }

    /// 解析会话标签页:首轮优先认领现有登录页；后续复用同一 target。
    /// reset/epoch 变化/站点变化/句柄丢失时释放旧 target，再认领或新建。
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
            self.claimed_targets.lock().await.remove(&tid);
            old = None;
        }
        // 释放旧上下文；恢复靠 transcript prompt。
        if let Some(tid) = old {
            self.claimed_targets.lock().await.remove(&tid);
            let _ = self
                .op(self.ops.close_page(port, &tid), cancel, deadline)
                .await;
        }
        let (tid, target_owned) = self
            .claim_or_create_conversation_target(port, site, cancel, deadline)
            .await?;
        trace.mark(if target_owned {
            "target_created"
        } else {
            "target_adopted"
        });
        st.site = site.to_string();
        st.target_id = Some(tid.clone());
        st.target_owned = target_owned;
        st.edge_epoch = epoch;
        st.turn_count = 0;
        st.last_used_at = Instant::now();
        Ok(tid)
    }

    /// 生成主流程(显式阶段状态机):
    ///   Disconnected → Connected(Edge 读租约)→ PageReady(右站点宿主+输入框可见)
    ///   → Sent(prompt 已写入且发出)→ ResponseStarted(回复开始生成,观察窗延长)
    ///   → Completed(稳定 2.5s)
    /// 分阶段恢复:PageReady 前确认丢失 = 安全重建;Sent 后断线 = 先恢复同 target
    /// 检查是否已有回复,确认无回复才安全重发一次;ResponseStarted 后疑似丢失 =
    /// 退避重试探活,确认消失才 LostAfterSend,绝不重建标签页
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
    ) -> Result<GenerationOutcome, AskFail> {
        let a = adapter(site).ok_or_else(|| AskFail::Failed(format!("未知站点: {site}")))?;
        // 读租约已持有 = Connected;Disconnected 仅是进入本函数前的语义书档
        let mut phase = AskPhase::Connected;
        let mut deadline = deadline;
        trace.mark(phase.name());

        // ---- PageReady:上下文稳定 + 右站点宿主 + 输入框可见(全部只读检查) ----
        let mut wrong_site = 0u32;
        loop {
            if cancel.is_cancelled() {
                return Err(AskFail::Cancelled);
            }
            if deadline.expired() {
                return Err(AskFail::timeout_hinted(phase));
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
            let href = v.as_str().unwrap_or("");
            if href.starts_with("https://") {
                if href.contains(a.host) {
                    break;
                }
                // 认领到了别的站点的标签页:发送前丢失,安全重建(有界,防重建循环)
                wrong_site += 1;
                if wrong_site > 2 {
                    let short = &href[..href.len().min(80)];
                    return Err(AskFail::Failed(format!("认领到错误站点的标签页: {short}")));
                }
                *target_id = self
                    .recreate_target(port, route, site, cancel, deadline)
                    .await?;
                trace.mark("target_recreated");
                continue;
            }
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
        // 输入框可见 = 未登录/站点改版在此暴露(只读检查;最多 ~10s 等页面水合)
        let ready_expr = a.ready_js();
        let mut input_ready = false;
        for _ in 0..10 {
            if cancel.is_cancelled() {
                return Err(AskFail::Cancelled);
            }
            if deadline.expired() {
                return Err(AskFail::timeout_hinted(phase));
            }
            if let Ok(v) = self
                .op(
                    self.ops.eval(port, target_id, &ready_expr, 5000),
                    cancel,
                    deadline,
                )
                .await
            {
                if v.as_bool() == Some(true) {
                    input_ready = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(1000)).await;
        }
        if !input_ready {
            return Err(AskFail::Failed(
                "输入框未出现(可能登录失效,或站点改版需更新选择器)".into(),
            ));
        }
        phase = AskPhase::PageReady;
        trace.mark(phase.name());

        // ---- Sent:写入校验与清空判定在 send_js 内(5 次重试逐字比对) ----
        // 某些站点会暂停后台标签页的提交/生成；发送前选中本会话 target。
        self.op(self.ops.activate_page(port, target_id), cancel, deadline)
            .await?;
        trace.mark("target_activated");
        let send_expr = format!("({})({})", a.send_js(), json_arg(prompt));
        let mut before_count: Option<u64> = None;
        let mut before_text: Option<String> = None;
        // 发送结果未知(导航殉职)= true:进入轮询前必须先恢复并检查是否已有回复
        let mut send_ambiguous = false;
        let sent = match self
            .op(
                self.ops.eval_await(port, target_id, &send_expr, 60_000),
                cancel,
                deadline,
            )
            .await
        {
            Ok(v) => {
                if v.get("sent") == Some(&json!(false)) {
                    let why = v.get("why").and_then(Value::as_str).unwrap_or("未能发送");
                    return Err(AskFail::Failed(why.to_string()));
                }
                before_count = v.get("beforeCount").and_then(Value::as_u64);
                before_text = v
                    .get("beforeText")
                    .and_then(Value::as_str)
                    .map(String::from);
                trace.mark("sent");
                true
            }
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
                send_ambiguous = true;
                true
            }
        };
        phase = AskPhase::Sent;
        let mut resent = false;
        // 活性梯子(方案 §二):发送确认时刻起跑。每拍快照喂入,动作实时派发
        let mut activity = activity::ActivityTracker::begin(self.activity_policy, Instant::now());
        // 常驻页面会话:软唤醒的会话态 Emulation 覆盖挂它上面;
        // 打不开则软唤醒降级跳过,梯子仍有激活脉冲
        let mut page_session: Option<PageSession> =
            self.ops.open_page_session(port, target_id).await.ok();

        // ---- 发送结果未知的立即恢复:先查原 target 是否已有回复,
        //      确认无回复才安全重发一次(有回复再发会污染会话/触发限流) ----
        let head: String = prompt.chars().take(20).collect();
        let watch_expr = format!("({})({})", a.snap_js(), json_arg(&head));
        let mut response_started = false;
        if send_ambiguous {
            trace.mark("post_send_recover");
            tokio::time::sleep(Duration::from_millis(1000)).await;
            if !self.target_alive(port, target_id, cancel, deadline).await {
                return Err(AskFail::LostAfterSend);
            }
            let replied = self
                .op(
                    self.ops.eval(port, target_id, &watch_expr, 8000),
                    cancel,
                    deadline,
                )
                .await
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(raw.as_str().unwrap_or("{}")).ok())
                .map(|snap| {
                    snap.get("busy").and_then(Value::as_bool).unwrap_or(false)
                        || !snap
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .is_empty()
                })
                .unwrap_or(false);
            if replied {
                response_started = true;
                phase = AskPhase::ResponseStarted;
                deadline.extend(RESPONSE_STARTED_EXTRA_MS);
                trace.mark("response_started_recovered");
            } else if !resent {
                resent = true;
                trace.mark("safe_resend");
                self.op(self.ops.activate_page(port, target_id), cancel, deadline)
                    .await?;
                if let Ok(v2) = self
                    .op(
                        self.ops.eval_await(port, target_id, &send_expr, 60_000),
                        cancel,
                        deadline,
                    )
                    .await
                {
                    before_count = v2.get("beforeCount").and_then(Value::as_u64);
                    before_text = v2
                        .get("beforeText")
                        .and_then(Value::as_str)
                        .map(String::from);
                }
            }
        }

        // ---- ResponseStarted → Completed:首次见到生成迹象即延长观察窗 ----
        let mut saw_generating = false;
        let mut saw_text = false;
        let mut last = String::new();
        let mut stable_since: Option<Instant> = None;
        loop {
            if cancel.is_cancelled() {
                return Err(AskFail::Cancelled);
            }
            if deadline.expired() {
                return Err(AskFail::timeout_hinted(phase));
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
                    // Sent/ResponseStarted 后疑似丢失:退避重试探活,绝不立即重建标签页
                    let mut alive = self.target_alive(port, target_id, cancel, deadline).await;
                    if !alive {
                        for _ in 0..2 {
                            tokio::time::sleep(Duration::from_millis(1500)).await;
                            if self.target_alive(port, target_id, cancel, deadline).await {
                                alive = true;
                                break;
                            }
                        }
                    }
                    if !alive {
                        if !sent {
                            *target_id = self
                                .recreate_target(port, route, site, cancel, deadline)
                                .await?;
                            trace.mark("target_recreated");
                            continue;
                        }
                        return Err(AskFail::LostAfterSend);
                    }
                    // 恢复成功:先看页面是否已经产生回复——
                    // 有(busy/增长/变化)= 按 ResponseStarted 继续等完成;
                    // 无 = 本次发送没落地,安全重发一次(已有回复再发会污染会话)
                    if sent && !response_started {
                        if let Ok(raw2) = self
                            .op(
                                self.ops.eval(port, target_id, &watch_expr, 8000),
                                cancel,
                                deadline,
                            )
                            .await
                        {
                            let snap: Value = serde_json::from_str(raw2.as_str().unwrap_or("{}"))
                                .unwrap_or_else(|_| json!({}));
                            let busy = snap.get("busy").and_then(Value::as_bool).unwrap_or(false);
                            let text = snap.get("text").and_then(Value::as_str).unwrap_or("");
                            let grew = before_count.is_some_and(|b| {
                                snap.get("count")
                                    .and_then(Value::as_u64)
                                    .is_some_and(|c| c > b)
                            });
                            let changed = before_text
                                .as_ref()
                                .is_some_and(|b| !text.is_empty() && text != *b);
                            if busy || grew || changed {
                                response_started = true;
                                phase = AskPhase::ResponseStarted;
                                deadline.extend(RESPONSE_STARTED_EXTRA_MS);
                                trace.mark("response_started_recovered");
                            } else if !resent {
                                resent = true;
                                trace.mark("safe_resend");
                                self.op(self.ops.activate_page(port, target_id), cancel, deadline)
                                    .await?;
                                // 重发后以这次发送的 before 值为新基线(否则
                                // before_count=None 会让 ResponseStarted 永远无法判定)
                                if let Ok(v2) = self
                                    .op(
                                        self.ops.eval_await(port, target_id, &send_expr, 60_000),
                                        cancel,
                                        deadline,
                                    )
                                    .await
                                {
                                    before_count = v2.get("beforeCount").and_then(Value::as_u64);
                                    before_text = v2
                                        .get("beforeText")
                                        .and_then(Value::as_str)
                                        .map(String::from);
                                }
                            }
                        }
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
                // ---- 活性观察(方案实施第 1 步:只观察不恢复)----
                // 每拍把快照归一化喂入梯子;动作与 recovered 标记先进轨迹,
                // 真实的软唤醒/激活脉冲/升级派发在下一步接入
                {
                    let act_snap = activity::ActivitySnapshot {
                        count: count.unwrap_or(0),
                        text_hash: activity::ActivitySnapshot::text_hash(&text),
                        text_len: text.len(),
                        busy,
                        input_ready: snap
                            .get("inputReady")
                            .and_then(Value::as_bool)
                            .unwrap_or(true),
                        turn_error: snap
                            .get("turnError")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        visibility: snap
                            .get("visibility")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        focused: snap
                            .get("focused")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    };
                    let obs = activity.observe(phase, &act_snap, Instant::now());
                    for m in &obs.marks {
                        trace.mark(m);
                    }
                    let attempt = obs.wake_attempt + 1;
                    match obs.action {
                        activity::RecoveryAction::None => {}
                        activity::RecoveryAction::SoftWake => match page_session.as_mut() {
                            Some(session) => {
                                let executed = self
                                    .op(self.ops.soft_wake(session), cancel, deadline)
                                    .await
                                    .is_ok();
                                activity.note_action(obs.action, executed, Instant::now());
                                trace.mark(&format!(
                                    "activity:soft_wake_{attempt} vis={} focus={} idle={}s{}",
                                    act_snap.visibility,
                                    act_snap.focused,
                                    obs.idle_ms / 1000,
                                    if executed { "" } else { "(failed)" }
                                ));
                            }
                            None => {
                                // 会话不可用:不计数,下一拍梯子重发请求;
                                // 始终不可用时由脉冲路径兜底
                                trace.mark(&format!(
                                    "activity:soft_wake_{attempt}(session_unavailable)"
                                ));
                            }
                        },
                        activity::RecoveryAction::ActivationPulse => {
                            // 全局节流:拒绝时不计数,下一拍重试(300ms 粒度)
                            let granted = self
                                .pulse
                                .lock()
                                .map(|mut c| c.try_acquire(target_id, Instant::now()))
                                .unwrap_or(false);
                            if granted {
                                let executed = self
                                    .op(
                                        self.ops.activation_pulse(port, target_id),
                                        cancel,
                                        deadline,
                                    )
                                    .await
                                    .is_ok();
                                activity.note_action(obs.action, executed, Instant::now());
                                trace.mark(&format!(
                                    "activity:pulse_{attempt} vis={} focus={} idle={}s{}",
                                    act_snap.visibility,
                                    act_snap.focused,
                                    obs.idle_ms / 1000,
                                    if executed { "" } else { "(failed)" }
                                ));
                            }
                        }
                        activity::RecoveryAction::PromoteDedicated => {
                            // §七 前置:输入框在(登录态/选择器正常)、页面无站点错误、
                            // 用户未强制标签页模式——不满足者换窗口也没用,不算活性失败
                            let book_ok = self.site_health.lock().ok().is_some_and(|book| {
                                book.effective_mode(site) != activity::SiteMode::Dedicated
                                    && book.override_of(site)
                                        != Some(activity::ModeOverride::PreferTab)
                            });
                            let allowed = act_snap.input_ready && !act_snap.turn_error && book_ok;
                            if !allowed {
                                activity.suppress_promotion();
                                trace.mark("activity:promote_rejected");
                            } else {
                                let changed = self
                                    .site_health
                                    .lock()
                                    .map(|mut book| book.note_pulse_exhausted(site))
                                    .unwrap_or(false);
                                activity.suppress_promotion();
                                trace.mark(if changed {
                                    "activity:promote_pending"
                                } else {
                                    "activity:promote_pending(kept)"
                                });
                                // §九:当前消息已发送,不迁移;返回可恢复失败,
                                // 前端换代 + 全量上下文重试 → 独立窗口在下一次
                                // 会话重建点创建
                                return Err(AskFail::Stalled);
                            }
                        }
                    }
                }
                // ResponseStarted:回复确已开始生成(busy/计数增长/文本变化任一)——
                // 此刻起延长观察窗,慢响应(深度思考等)不再被原总超时掐死
                if !response_started && (busy || grew || changed) {
                    response_started = true;
                    phase = AskPhase::ResponseStarted;
                    deadline.extend(RESPONSE_STARTED_EXTRA_MS);
                    trace.mark(phase.name());
                }
                if !text.is_empty() && !saw_text {
                    saw_text = true;
                    trace.mark("first_text");
                }
                let has_answer = !text.is_empty() && !truncated;
                if response_started && !busy && has_answer {
                    if text == last {
                        let since = stable_since.get_or_insert_with(Instant::now);
                        if since.elapsed() >= Duration::from_millis(STABLE_MS) {
                            trace.mark("stable_done");
                            phase = AskPhase::Completed;
                            trace.mark(phase.name());
                            return Ok(GenerationOutcome {
                                text,
                                used_pulse: activity.used_pulse(),
                            });
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
        match route {
            Route::Shared { host } => {
                let _ = host;
                self.find_or_create_shared(port, site, cancel, deadline)
                    .await
            }
            Route::Conversation => {
                self.create_claimed_conversation_target(port, site, cancel, deadline)
                    .await
            }
        }
    }

    /// 打开登录窗口(设置页"打开登录窗口"/AI剧场甲乙各自登录)。
    /// 关键语义:实例已在跑 = **只开一个新标签页**——绝不杀实例,其他站点的
    /// 标签页与会话原样存活；该新页会在对应角色首轮生成时被认领并持续复用。
    /// 冷启动会重启进程:epoch +1、全部会话句柄失效(后续 ask 自动重建标签页)。
    pub async fn open_login(&self, profile: &Path, url: &str) -> Result<LoginOutcome, String> {
        if let Some(port) = self.ops.probe_port(profile).await {
            // 复用路径:新标签页落在已有窗口(createTarget 默认前台激活)
            self.ops
                .create_page(port, url, activity::TargetPlacement::Tab)
                .await?;
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
                self.ops
                    .create_page(port, url, activity::TargetPlacement::Tab)
                    .await?;
                Ok(LoginOutcome::Reused)
            }
            None => {
                // kill 兜底:清理"端口文件缺失但进程还在"的僵尸实例(无调试参数)
                self.ops.kill_and_launch(profile, url).await?;
                w.port = self
                    .ops
                    .probe_port(profile)
                    .await
                    .ok_or_else(|| "Edge 重启后调试端口仍不可用".to_string())?;
                w.epoch += 1;
                // 全部会话句柄失效(target 随进程消失):清表,后续 ask 自动重建
                self.conversations.lock().await.clear();
                self.claimed_targets.lock().await.clear();
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
                self.claimed_targets.lock().await.remove(&tid);
                if !st.target_owned {
                    st.released = true;
                    drop(st);
                    self.conversations.lock().await.remove(&key);
                    continue;
                }
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
            .find_or_create_shared(port, &site, &cancel, deadline)
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
        result.map(|outcome| outcome.text)
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
    // 同会话连续失败的指数退避(1s→2s→4s…封顶 30s):连续失败往往伴随站点
    // 限流/风控,立刻重试只会火上浇油;退避可取消、受 deadline 钳制
    {
        let backoff_ms = {
            let st = slot.state.lock().await;
            if st.consecutive_failures == 0 {
                0
            } else {
                BACKOFF_BASE_MS << (st.consecutive_failures - 1).min(4)
            }
        }
        .min(BACKOFF_CAP_MS);
        if backoff_ms > 0 {
            trace.mark("backoff");
            within(
                tokio::time::sleep(Duration::from_millis(backoff_ms)),
                cancel,
                deadline,
                "backoff",
            )
            .await?;
        }
    }
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
    let original_target = target_id.clone();
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
    // 结账:成败都记使用时刻;成功累计轮次并清零失败计数,失败累计(驱动退避)
    if let Ok(mut st) = slot.state.try_lock() {
        st.last_used_at = Instant::now();
        if target_id != original_target {
            hub.claimed_targets.lock().await.remove(&original_target);
            hub.claimed_targets.lock().await.insert(target_id.clone());
            st.target_id = Some(target_id);
            st.target_owned = true;
        }
        if result.is_ok() {
            st.turn_count += 1;
            st.consecutive_failures = 0;
        } else {
            st.consecutive_failures = st.consecutive_failures.saturating_add(1);
        }
    }
    // 站点健康分账(按站点,不影响其他站点):成功喂 3-of-5 规则;
    // 仅活性失败(Stalled)计失败——登录/风控/丢失/取消换窗口也没用,不升级
    match &result {
        Ok(outcome) => {
            if let Ok(mut book) = hub.site_health.lock() {
                book.note_turn_success(site, outcome.used_pulse);
            }
        }
        Err(AskFail::Stalled) => {
            if let Ok(mut book) = hub.site_health.lock() {
                book.note_turn_liveness_failure(site);
            }
        }
        Err(_) => {}
    }
    drop(permit);
    result.map(|outcome| outcome.text)
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
        hub.claimed_targets.lock().await.remove(&tid);
        if !st.target_owned {
            st.released = true;
            return Ok(());
        }
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

/// 拉起可见的 Edge 窗口给用户登录，主角色窗口保持显示。
/// 实例已在跑 = 只开新标签页(其他站点标签页原样存活——多 AI 剧场两个站点
/// 并存的关键);只有没在跑才冷启动(epoch 失效会话句柄)。
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
    Ok(())
}

// ---------- 就绪探测(设置页测试按钮) ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ready: bool,
    pub detail: String,
    /// 阶段状态(替代布尔"已就绪"):沿状态机逐级只读走查的结果,
    /// 断在哪一级,诊断就指向哪一级(连接 / 页面 / 输入框与登录态)
    pub stages: Vec<ProbeStage>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProbeStage {
    /// 阶段名:connected / page / input(与 AskPhase 状态机对齐)
    pub stage: String,
    pub ok: bool,
    pub detail: String,
}

/// 逐级探测目标站点可否发消息,detail 说明断点位置(未就绪时展示给用户/排查用)
#[tauri::command]
pub async fn webchat_probe(app: AppHandle, site: String) -> Result<ProbeResult, String> {
    let a = adapter(&site).ok_or_else(|| format!("未知站点: {site}"))?;
    let profile = profile_dir(&app)?;
    let mut stages: Vec<ProbeStage> = Vec::new();

    // ---- Connected:Edge 进程存在 + 调试通道可连 ----
    let connected = browser_connect(&profile).await;
    stages.push(ProbeStage {
        stage: "connected".into(),
        ok: connected.is_ok(),
        detail: connected
            .as_ref()
            .map(|_| "Edge 专用实例在跑,调试通道可连".into())
            .unwrap_or_else(|e| format!("Edge 未启动或调试通道不可连: {e}")),
    });
    let Ok((port, mut browser)) = connected else {
        return Ok(ProbeResult {
            ready: false,
            detail: "Edge 未启动:先点「打开登录窗口」拉起专用 Edge".into(),
            stages,
        });
    };

    // ---- Page:标签页存活且属于正确站点 ----
    let found = match browser.call("Target.getTargets", json!({}), 8000).await {
        Ok(res) => res
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
            }),
        Err(e) => {
            stages.push(ProbeStage {
                stage: "page".into(),
                ok: false,
                detail: format!("拉取标签页列表失败: {e}"),
            });
            return Ok(ProbeResult {
                ready: false,
                detail: format!("拉取标签页列表失败: {e}"),
                stages,
            });
        }
    };
    let Some(target_id) = found else {
        stages.push(ProbeStage {
            stage: "page".into(),
            ok: false,
            detail: format!("没有 {} 的标签页(未打开,或打开的是别的站点)", a.host),
        });
        return Ok(ProbeResult {
            ready: false,
            detail: format!("Edge 里没有 {} 的标签页:先点「打开登录窗口」", a.host),
            stages,
        });
    };
    stages.push(ProbeStage {
        stage: "page".into(),
        ok: true,
        detail: "站点标签页存活".into(),
    });

    // ---- Input:页面加载完成 + 输入框可见 + 无风控/验证码拦截(全部只读) ----
    let state = page_call(port, &target_id, &a.state_js(), 8000, false, false).await;
    match state {
        Ok(v) => {
            let parsed: Value =
                serde_json::from_str(v.as_str().unwrap_or("{}")).unwrap_or_else(|_| json!({}));
            let input_ready = parsed.get("inputReady").and_then(Value::as_bool) == Some(true);
            let blocker = parsed
                .get("blocker")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            stages.push(ProbeStage {
                stage: "input".into(),
                ok: input_ready && blocker.is_none(),
                detail: if let Some(b) = blocker {
                    b.to_string()
                } else if input_ready {
                    "输入框可见,可以发送".into()
                } else {
                    "输入框未出现:可能登录已失效,或站点改版需更新选择器".into()
                },
            });
            let input_stage = stages.last().unwrap();
            let ready = input_stage.ok;
            let detail = if ready {
                "已就绪".into()
            } else {
                input_stage.detail.clone()
            };
            if ready {
                show_main(&app, true);
            }
            Ok(ProbeResult {
                ready,
                detail,
                stages,
            })
        }
        Err(e) => {
            stages.push(ProbeStage {
                stage: "input".into(),
                ok: false,
                detail: format!("页面检查失败: {e}"),
            });
            Ok(ProbeResult {
                ready: false,
                detail: format!("附加到页面失败: {e}"),
                stages,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edge_launch_never_enables_webdriver_via_zero_debug_port() {
        let args = edge_launch_args(
            Path::new("D:/isolated-profile"),
            "https://chatgpt.com/",
            19333,
        );
        assert!(
            !args.iter().any(|arg| arg == "--remote-debugging-port=0"),
            "端口 0 会令 Chromium 暴露 navigator.webdriver=true，触发 OAuth 风控"
        );
        assert!(args
            .iter()
            .any(|arg| arg == "--remote-debugging-port=19333"));
        assert!(
            args.iter()
                .any(|arg| arg == "--remote-debugging-address=127.0.0.1"),
            "调试端口必须只监听本机"
        );
        for flag in [
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
        ] {
            assert!(
                args.iter().any(|arg| arg == flag),
                "专用 Edge 缺少后台生成保障参数: {flag}"
            );
        }
    }

    #[test]
    fn managed_debug_port_wins_over_stale_chromium_port_file() {
        let profile =
            std::env::temp_dir().join(format!("webchat-debug-port-test-{}", std::process::id()));
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join(DEBUG_PORT_FILE), "19333").unwrap();
        std::fs::write(
            profile.join("DevToolsActivePort"),
            "2407\n/devtools/browser/stale",
        )
        .unwrap();
        assert_eq!(read_debug_port(&profile), Some(19333));
        std::fs::remove_dir_all(profile).unwrap();
    }

    #[tokio::test]
    async fn browser_path_is_discovered_from_explicit_debug_port() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            let body = format!(
                r#"{{"webSocketDebuggerUrl":"ws://localhost:{port}/devtools/browser/fixed-port"}}"#
            );
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        assert_eq!(
            discover_browser_path(port).await.unwrap(),
            "/devtools/browser/fixed-port"
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn connect_ws_reaches_ipv4_loopback_server() {
        let listener =
            tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
                .await
                .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(socket).await.unwrap()
        });

        let client = tokio::time::timeout(
            Duration::from_secs(3),
            connect_ws(format!("ws://127.0.0.1:{port}/devtools/test")),
        )
        .await
        .expect("连接不得挂起");
        assert!(client.is_ok(), "IPv4 回环 WebSocket 应可连接: {client:?}");
        server.abort();
    }

    #[tokio::test]
    async fn target_commands_use_cached_browser_websocket_path() {
        let listener =
            tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
                .await
                .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (path_tx, path_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut path_tx = Some(path_tx);
            let mut ws = tokio_tungstenite::accept_hdr_async(
                socket,
                move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                      response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    let _ = path_tx.take().unwrap().send(request.uri().path().to_string());
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let request = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let request: Value = serde_json::from_str(&request).unwrap();
            assert_eq!(
                request.get("method").and_then(Value::as_str),
                Some("Target.createTarget")
            );
            ws.send(Message::text(
                json!({ "id": request["id"], "result": { "targetId": "target-1" } }).to_string(),
            ))
            .await
            .unwrap();
        });

        let ops = RealCdpOps::default();
        ops.remember_browser_path(port, "/devtools/browser/test-id");
        let target = ops
            .create_page(
                port,
                "https://chat.deepseek.com/",
                activity::TargetPlacement::Tab,
            )
            .await
            .unwrap();
        assert_eq!(target, "target-1");
        assert_eq!(path_rx.await.unwrap(), "/devtools/browser/test-id");
        server.await.unwrap();
    }

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
        /// Hub 传给物理操作的端口(回归:探活端口必须写回 EdgeRuntime)
        ports_seen: Vec<u16>,
        /// Edge 实例是否在跑(false = 探活失败,走冷启动路径)
        running: bool,
        /// PageReady 输入框探测的应答(false = 未登录/改版)
        ready_flag: bool,
        /// 可编排的快照序列:逐次消费耗尽后回落默认快照(延窗/恢复测试用)
        snap_script: Vec<Value>,
        /// eval_await 失败注入:下次发送抛上下文丢失
        fail_next_send_with_context_lost: bool,
        /// eval_await 调用计数(安全重发恰一次断言用)
        send_calls: u32,
        /// 需要活动标签页才能发送(复现后台页不启动生成)
        require_active_for_send: bool,
        active_target: Option<String>,
        activation_calls: u32,
        /// location.href 的应答覆写(None = 默认 deepseek 宿主;宿主校验测试用)
        wrong_site_href: Option<String>,
        /// 软唤醒/激活脉冲执行计数(活性派发断言用)
        wake_calls: u32,
        pulse_calls: u32,
        /// 软唤醒注入失败(PageSession 不可用降级路径)
        fail_soft_wake: bool,
        /// 独立窗口创建计数(placement=DedicatedWindow)
        dedicated_creations: u32,
    }

    struct FakeOps {
        inner: Mutex<FakeOpsInner>,
    }

    impl FakeOps {
        fn new() -> Self {
            Self {
                inner: Mutex::new(FakeOpsInner {
                    running: true,    // 缺省实例在跑;测试可置 false 模拟 Edge 未启动/已退出
                    ready_flag: true, // 缺省输入框可见;测试可置 false 模拟未登录/改版
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

        async fn create_page(
            &self,
            port: u16,
            url: &str,
            placement: activity::TargetPlacement,
        ) -> Result<String, String> {
            let mut s = self.state();
            s.ports_seen.push(port);
            s.next_id += 1;
            let id = format!("t{}", s.next_id);
            s.pages.push((id.clone(), url.to_string()));
            if placement == activity::TargetPlacement::DedicatedWindow {
                s.dedicated_creations += 1;
            }
            Ok(id)
        }

        async fn open_page_session(
            &self,
            port: u16,
            target_id: &str,
        ) -> Result<PageSession, String> {
            Ok(PageSession::new(port, target_id))
        }

        async fn soft_wake(&self, _session: &mut PageSession) -> Result<(), String> {
            let mut s = self.state();
            if s.fail_soft_wake {
                return Err("PageSession 不可用".into());
            }
            s.wake_calls += 1;
            Ok(())
        }

        async fn activation_pulse(&self, _port: u16, target_id: &str) -> Result<(), String> {
            let mut s = self.state();
            if !s.pages.iter().any(|(id, _)| id == target_id) {
                return Err("Target closed".into());
            }
            s.pulse_calls += 1;
            Ok(())
        }

        async fn close_page(&self, _port: u16, target_id: &str) -> Result<(), String> {
            self.state().pages.retain(|(id, _)| id != target_id);
            Ok(())
        }

        async fn activate_page(&self, _port: u16, target_id: &str) -> Result<(), String> {
            let mut s = self.state();
            if !s.pages.iter().any(|(id, _)| id == target_id) {
                return Err("Target closed".into());
            }
            s.active_target = Some(target_id.to_string());
            s.activation_calls += 1;
            Ok(())
        }

        async fn eval(
            &self,
            port: u16,
            target_id: &str,
            expr: &str,
            _t: u64,
        ) -> Result<Value, String> {
            {
                let mut s = self.state();
                s.ports_seen.push(port);
                if !s.pages.iter().any(|(id, _)| id == target_id) {
                    return Err("Target closed".into()); // 标签页没了 = 上下文丢失
                }
                s.active_evals += 1;
                s.peak_evals = s.peak_evals.max(s.active_evals);
            }
            // 上下文稳定探测:返回 https URL 即通过(可覆写为错误站点,验证宿主校验)
            if expr.contains("location.href") {
                let mut s = self.state();
                s.active_evals = s.active_evals.saturating_sub(1);
                let href = s
                    .wrong_site_href
                    .clone()
                    .unwrap_or_else(|| "https://chat.deepseek.com".into());
                return Ok(json!(href));
            }
            // 抓取快照:snap 脚本是唯一的 `(head) =>` 箭头签名(它现在也内嵌
            // composer 选择器做 inputReady,不能用选择器字符串判别,否则和
            // 输入框探测互相劫持);页面 JS 返回 JSON 字符串(外层 as_str 再解析)
            if expr.contains("(head) =>") {
                let delay = self.state().eval_delay_ms;
                tokio::time::sleep(Duration::from_millis(delay)).await;
                let mut s = self.state();
                s.active_evals = s.active_evals.saturating_sub(1);
                if !s.snap_script.is_empty() {
                    return Ok(json!(s.snap_script.remove(0).to_string()));
                }
                return Ok(json!(
                    json!({ "busy": false, "text": "回复文本", "count": 1 }).to_string()
                ));
            }
            // PageReady 输入框探测:按脚本应答(缺省 = 输入框可见)
            if expr.contains("composerSels") || expr.contains("chat-input") {
                let mut s = self.state();
                s.active_evals = s.active_evals.saturating_sub(1);
                return Ok(json!(s.ready_flag));
            }
            let delay = self.state().eval_delay_ms;
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let mut s = self.state();
            s.active_evals = s.active_evals.saturating_sub(1);
            Ok(json!(
                json!({ "busy": false, "text": "回复文本", "count": 1 }).to_string()
            ))
        }

        async fn eval_await(
            &self,
            port: u16,
            target_id: &str,
            _expr: &str,
            _t: u64,
        ) -> Result<Value, String> {
            let mut s = self.state();
            s.send_calls += 1;
            s.ports_seen.push(port);
            if s.require_active_for_send && s.active_target.as_deref() != Some(target_id) {
                return Err("后台标签页未激活,生成暂停".into());
            }
            let fail_context_lost = s.fail_next_send_with_context_lost;
            s.fail_next_send_with_context_lost = false;
            if !s.pages.iter().any(|(id, _)| id == target_id) || fail_context_lost {
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

    // ---------- 活性派发集成(快策略;默认 6s 阈值对单测太慢) ----------

    // 阈值错开在 300ms 轮询边界之间(留 50ms 余量),tick 序列确定:
    // tick1≈0ms 建基线 → tick2≈300ms 软唤醒 → tick3≈600ms 脉冲 → tick4≈900ms 二次唤醒
    const FAST: activity::ActivityPolicy = activity::ActivityPolicy {
        first_soft_wake_ms: 250,
        first_pulse_ms: 550,
        second_soft_wake_ms: 850,
        second_pulse_ms: 1_150,
        promote_ms: 1_450,
        streaming_soft_wake_ms: 400,
        streaming_pulse_ms: 800,
    };

    fn hub_fast(ops: FakeOps) -> Arc<HubState<FakeOps>> {
        let mut hub = HubState::new(Arc::new(ops)).with_activity_policy(FAST);
        hub.pulse = Mutex::new(fast_pulse_coordinator());
        Arc::new(hub)
    }

    /// 快策略配套的快节流(生产 1.5s/10s 对 FAST 的 600ms 梯子会把第二拍
    /// 脉冲拒到超时;间隔可注入,生产路径不变)
    fn fast_pulse_coordinator() -> activity::PulseCoordinator {
        activity::PulseCoordinator::with_gaps(
            Duration::from_millis(300),
            Duration::from_millis(500),
        )
    }

    /// 停滞快照:count=0(不高于发送前基线)、无文本、不忙——三无 = 无进展
    fn idle_snap() -> Value {
        json!({ "busy": false, "text": "", "count": 0 })
    }

    async fn ask_conv_trace(
        hub: &Arc<HubState<FakeOps>>,
        request_id: &str,
        key: &str,
        timeout_ms: u64,
    ) -> (Result<String, String>, Vec<String>) {
        let deadline = Deadline::after_ms(timeout_ms);
        let mut trace = TraceBuilder::new(request_id);
        let guard = RequestGuard::register(&hub.requests, request_id);
        let cancel = guard.handle();
        let r = run_conversation(
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
        .await;
        let stages = trace.stages.iter().map(|s| s.stage.clone()).collect();
        (r.map_err(|f| f.msg()), stages)
    }

    // ---------- 站点健康与独立窗口升级集成(方案 §八/§九) ----------

    async fn ask_conv_reset(
        hub: &Arc<HubState<FakeOps>>,
        request_id: &str,
        key: &str,
        timeout_ms: u64,
        reset: bool,
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
            reset,
            &cancel,
            deadline,
            &mut trace,
        )
        .await
        .map_err(|f| f.msg())
    }

    const STALLED_MSG: &str = "页面长时间无进展(已软唤醒与激活仍未恢复)";

    /// 双脉冲耗尽仍无进展 → typed Stalled + 站点标记 DedicatedPending;
    /// 活性失败计入站点健康(登录/丢失/取消类错误不算——见后续用例)
    #[tokio::test]
    async fn double_pulse_stall_returns_stalled_and_marks_site_pending() {
        let ops = FakeOps::new();
        ops.state().snap_script = vec![idle_snap(); 16];
        let hub = hub_fast(ops);
        let (r, stages) = ask_conv_trace(&hub, "stall", "k1", 3_000).await;
        assert_eq!(r.unwrap_err(), STALLED_MSG);
        assert!(stages.iter().any(|s| *s == "activity:promote_pending"));
        let st = hub.site_health.lock().unwrap().status("deepseek");
        assert_eq!(st.mode, activity::SiteMode::DedicatedPending);
        assert_eq!(st.liveness_failures, 1);
    }

    /// 升级后的恢复请求(reset:true)在会话重建点创建独立窗口(§九);
    /// 进行中的会话绝不中途迁移
    #[tokio::test]
    async fn recovery_ask_after_promotion_creates_dedicated_window() {
        let ops = FakeOps::new();
        ops.state().snap_script = vec![idle_snap(); 16];
        let hub = hub_fast(ops);
        // 第一轮:升级 Pending(以 Stalled 收场)
        let r1 = ask_conv_reset(&hub, "first", "k1", 3_000, false).await;
        assert_eq!(r1.unwrap_err(), STALLED_MSG);
        assert_eq!(hub.ops.state().dedicated_creations, 0, "已发送的消息不迁移");
        // 第二轮(前端两段式恢复,reset:true):独立窗口落地
        let r2 = ask_conv_reset(&hub, "retry", "k1", 1_200, true).await;
        assert!(r2.is_err(), "停滞站点重建后仍以超时收场(不再断言成功)");
        assert_eq!(
            hub.ops.state().dedicated_creations,
            1,
            "恢复请求应创建独立窗口"
        );
        let st = hub.site_health.lock().unwrap().status("deepseek");
        assert_eq!(st.mode, activity::SiteMode::Dedicated);
    }

    /// 用户强制标签页模式压制自动升级(§十四):仍走软唤醒/脉冲,但不换窗口
    #[tokio::test]
    async fn prefer_tab_override_blocks_promotion() {
        let ops = FakeOps::new();
        ops.state().snap_script = vec![idle_snap(); 16];
        let hub = hub_fast(ops);
        hub.site_health
            .lock()
            .unwrap()
            .set_override("deepseek", Some(activity::ModeOverride::PreferTab));
        let (r, stages) = ask_conv_trace(&hub, "forced-tab", "k1", 3_000).await;
        assert_ne!(r.unwrap_err(), STALLED_MSG, "PreferTab 下不得升级");
        assert!(stages.iter().any(|s| *s == "activity:promote_rejected"));
        let st = hub.site_health.lock().unwrap().status("deepseek");
        assert_eq!(st.mode, activity::SiteMode::Tab);
        assert_eq!(hub.ops.state().dedicated_creations, 0);
    }

    /// LostAfterSend 等非活性失败不计入站点健康(§七:换窗口解决不了)
    #[tokio::test]
    async fn lost_after_send_not_counted_as_liveness_failure() {
        let ops = FakeOps::new();
        ops.state().drop_target_after_send = true;
        let hub = hub_fast(ops);
        let r = ask_conv_reset(&hub, "lost", "k1", 10_000, false).await;
        assert_eq!(r.unwrap_err(), LOST_AFTER_SEND);
        let st = hub.site_health.lock().unwrap().status("deepseek");
        assert_eq!(st.liveness_failures, 0);
        assert_eq!(st.mode, activity::SiteMode::Tab);
    }

    #[tokio::test]
    async fn stalled_site_soft_wakes_then_recovers_without_resend() {
        let ops = FakeOps::new();
        // 前 2 拍停滞,第 3 拍出现 busy(软唤醒起效)→ 走默认快照稳定完成
        ops.state().snap_script = vec![
            idle_snap(),
            idle_snap(),
            json!({ "busy": true, "text": "", "count": 0 }),
        ];
        let hub = hub_fast(ops);
        let (r, stages) = ask_conv_trace(&hub, "wake-ok", "k1", 30_000).await;
        assert!(r.is_ok(), "软唤醒后应恢复正常完成: {r:?}");
        let st = hub.ops.state();
        assert_eq!(st.wake_calls, 1, "恰好一次软唤醒");
        assert_eq!(st.send_calls, 1, "软唤醒绝不重发提示词");
        assert_eq!(st.pulse_calls, 0, "唤醒起效就不需要脉冲");
        assert!(
            stages.iter().any(|s| s.starts_with("activity:soft_wake_1")),
            "轨迹应记录软唤醒: {stages:?}"
        );
        assert!(
            stages.iter().any(|s| *s == "activity:soft_wake_recovered"),
            "轨迹应记录唤醒后恢复: {stages:?}"
        );
    }

    #[tokio::test]
    async fn stalled_site_escalates_to_activation_pulse() {
        let ops = FakeOps::new();
        // 全程停滞(脚本耗尽后回落默认快照,但总超时先到)
        ops.state().snap_script = vec![idle_snap(); 8];
        let hub = hub_fast(ops);
        let (r, stages) = ask_conv_trace(&hub, "pulse", "k1", 1_400).await;
        assert!(r.is_err(), "持续停滞以超时收场");
        let st = hub.ops.state();
        assert_eq!(st.send_calls, 1, "脉冲绝不重发提示词");
        assert_eq!(st.wake_calls, 2, "双软唤醒按梯子执行(250ms/850ms)");
        assert_eq!(
            st.pulse_calls, 2,
            "双脉冲按梯子执行(550ms/1150ms,快节流放行)"
        );
        assert!(
            stages.iter().any(|s| s.starts_with("activity:pulse_")),
            "轨迹应记录脉冲: {stages:?}"
        );
    }

    #[tokio::test]
    async fn soft_wake_failure_degrades_to_pulse_without_counting() {
        let ops = FakeOps::new();
        ops.state().fail_soft_wake = true;
        ops.state().snap_script = vec![idle_snap(); 8];
        let hub = hub_fast(ops);
        let (_r, _stages) = ask_conv_trace(&hub, "no-session", "k1", 1_400).await;
        let st = hub.ops.state();
        assert_eq!(st.wake_calls, 0, "会话不可用:软唤醒不执行也不计数");
        assert!(st.pulse_calls >= 1, "梯子由脉冲路径兜底");
        assert_eq!(st.send_calls, 1);
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
    async fn probe_port_is_written_into_edge_lease() {
        let hub = hub_with(FakeOps::new());
        ask_conv(&hub, "port", "k1", 10_000).await.unwrap();
        assert_eq!(hub.edge.read().await.port, 9222);
        assert!(
            hub.ops.state().ports_seen.iter().all(|port| *port == 9222),
            "create/eval 不得收到初始占位端口 0"
        );
    }

    #[tokio::test]
    async fn generation_activates_target_before_send() {
        let ops = FakeOps::new();
        ops.state().require_active_for_send = true;
        let hub = hub_with(ops);

        let result = ask_conv(&hub, "needs-active-tab", "k1", 10_000).await;

        assert!(result.is_ok(), "发送前应激活目标标签页,实际: {result:?}");
        assert_eq!(hub.ops.state().activation_calls, 1);
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
        assert!(
            r.starts_with("网页生成超时"),
            "超时错误应带诊断前缀,实际: {r}"
        );
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
        hub.claimed_targets.lock().await.clear();
        // 重启后同 key ask:认领 Edge 启动时已经打开的站点页
        let _ = ask_conv(&hub, "r2", "k1", 10_000).await.unwrap();
        let s = hub.ops.state();
        assert_eq!(s.pages.len(), 1);
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

    /// 设置页提前打开并完成登录的站点页，应直接成为该角色的会话页。
    /// 否则第一次生成会额外创建标签页，用户刚登录的页面也不会承接后续对话。
    #[tokio::test]
    async fn first_conversation_adopts_open_login_tab_and_keeps_using_it() {
        let hub = hub_with(FakeOps::new());
        hub.open_login(&profile(), "https://chat.deepseek.com/")
            .await
            .unwrap();
        let login_target = hub.ops.state().pages[0].0.clone();

        ask_conv(&hub, "r1", "relay:e1:A", 10_000).await.unwrap();
        assert_eq!(
            hub.ops.state().pages.len(),
            1,
            "首轮生成应复用已打开的登录标签页"
        );

        let slot = hub
            .conversations
            .lock()
            .await
            .get("relay:e1:A")
            .unwrap()
            .clone();
        assert_eq!(
            slot.state.lock().await.target_id.as_deref(),
            Some(login_target.as_str())
        );

        ask_conv(&hub, "r2", "relay:e1:A", 10_000).await.unwrap();
        assert_eq!(
            hub.ops.state().pages.len(),
            1,
            "同一 conversationKey 的后续轮次必须继续使用同一标签页"
        );
    }

    #[tokio::test]
    async fn same_site_conversations_never_share_one_login_tab() {
        let ops = FakeOps::new();
        ops.state().eval_delay_ms = 100;
        let hub = hub_with(ops);
        hub.open_login(&profile(), "https://chat.deepseek.com/")
            .await
            .unwrap();

        let (h1, h2) = (hub.clone(), hub.clone());
        let a = tokio::spawn(async move { ask_conv(&h1, "r1", "relay:e1:A", 10_000).await });
        let b = tokio::spawn(async move { ask_conv(&h2, "r2", "relay:e1:B", 10_000).await });
        let (ra, rb) = tokio::join!(a, b);
        assert!(ra.unwrap().is_ok() && rb.unwrap().is_ok());
        assert_eq!(hub.ops.state().pages.len(), 2);

        let map = hub.conversations.lock().await;
        let a = map.get("relay:e1:A").unwrap().state.lock().await;
        let b = map.get("relay:e1:B").unwrap().state.lock().await;
        assert_ne!(a.target_id, b.target_id, "两个角色不能向同一页面并发发消息");
    }

    #[tokio::test]
    async fn sweeping_adopted_conversation_keeps_login_tab_open() {
        let hub = hub_with(FakeOps::new());
        hub.open_login(&profile(), "https://chat.deepseek.com/")
            .await
            .unwrap();
        ask_conv(&hub, "r1", "relay:e1:A", 10_000).await.unwrap();
        {
            let map = hub.conversations.lock().await;
            let slot = map.get("relay:e1:A").unwrap();
            slot.state.lock().await.last_used_at =
                Instant::now() - Duration::from_secs(HUB_IDLE_SECS + 60);
        }

        hub.sweep_idle().await;
        assert_eq!(hub.ops.state().pages.len(), 1, "用户登录页不应被清扫关闭");
        assert!(hub.conversations.lock().await.is_empty());
        assert!(hub.claimed_targets.lock().await.is_empty());
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

    // ---------- 状态机:ResponseStarted 延窗 / Sent 后安全恢复 / 退避 ----------

    fn snap(busy: bool, text: &str, count: u64) -> Value {
        json!({ "busy": busy, "text": text, "count": count })
    }

    /// ResponseStarted 延窗:回复开始生成后,原 deadline 到点不再掐死,
    /// 延长观察窗内完成即成功(旧实现此处必超时)
    #[tokio::test]
    async fn response_started_extends_the_observation_window() {
        let ops = FakeOps::new();
        ops.state().eval_delay_ms = 600;
        // 快照脚本:前 3 拍 busy(生成中,原 deadline 已过),之后出文本完成
        ops.state().snap_script = vec![snap(true, "", 1), snap(true, "", 1), snap(true, "", 1)];
        let hub = hub_with(ops);
        let r = ask_conv(&hub, "slow-gen", "k1", 1_600).await;
        assert!(r.is_ok(), "ResponseStarted 后应延长观察窗而不是超时: {r:?}");
    }

    /// Sent 后断线:恢复同 target 发现已有回复 → 直接等完成,不重发
    #[tokio::test]
    async fn post_send_recovery_finds_existing_reply_and_skips_resend() {
        let ops = FakeOps::new();
        ops.state().fail_next_send_with_context_lost = true;
        // 恢复后的快照:回复已在生成(busy)→ 无需重发
        ops.state().snap_script = vec![snap(true, "", 1)];
        let hub = hub_with(ops);
        let r = ask_conv(&hub, "recover-reply", "k1", 20_000).await;
        assert!(r.is_ok(), "恢复发现已有回复应继续等完成: {r:?}");
        assert_eq!(
            hub.ops.state().send_calls,
            1,
            "已有回复时不得重复发送(污染会话/触发限流)"
        );
    }

    /// Sent 后断线:恢复确认无回复 → 安全重发恰一次,随后完成
    #[tokio::test]
    async fn post_send_recovery_without_reply_resends_exactly_once() {
        let ops = FakeOps::new();
        ops.state().fail_next_send_with_context_lost = true;
        // 恢复后的快照:无回复(count 未增长)→ 触发一次安全重发
        ops.state().snap_script = vec![snap(false, "", 0)];
        let hub = hub_with(ops);
        let r = ask_conv(&hub, "recover-resend", "k1", 20_000).await;
        assert!(r.is_ok(), "安全重发后应正常完成: {r:?}");
        assert_eq!(hub.ops.state().send_calls, 2, "无回复才允许重发,且恰一次");
    }

    /// ResponseStarted 后 target 消失:退避确认后 LostAfterSend,绝不新建标签页
    #[tokio::test]
    async fn response_started_target_gone_never_recreates_tab() {
        let ops = FakeOps::new();
        ops.state().drop_target_after_send = true;
        // 恢复快照:有回复已开始(进入 ResponseStarted)
        ops.state().snap_script = vec![snap(true, "", 1)];
        let hub = hub_with(ops);
        let r = ask_conv(&hub, "gone", "k1", 30_000).await.unwrap_err();
        assert_eq!(r, LOST_AFTER_SEND);
        assert!(
            hub.ops.state().pages.is_empty(),
            "ResponseStarted 后丢失绝不允许重建标签页"
        );
    }

    /// PageReady 宿主校验:location.href 返回错误站点 → 不认领,重建有界后报错
    #[tokio::test]
    async fn page_ready_rejects_wrong_site_tab() {
        let ops = FakeOps::new();
        // 让 location.href 返回豆包宿主(deepseek 会话认领到别站 = 拒绝)
        ops.state().wrong_site_href = Some("https://www.doubao.com/chat/".to_string());
        let hub = hub_with(ops);
        let r = ask_conv(&hub, "wrong", "k1", 30_000).await.unwrap_err();
        assert!(r.contains("认领到错误站点的标签页"), "实际: {r}");
    }

    /// 同会话连续失败的指数退避:下一次 ask 起始延迟 ≥1s;退避中取消即时生效
    #[tokio::test]
    async fn consecutive_failures_back_off_exponentially_and_reset_on_success() {
        let ops = FakeOps::new();
        let hub = hub_with(ops);
        // 第一次失败(drop target 模拟站点异常)
        hub.ops.state().drop_target_after_send = true;
        let r1 = ask_conv(&hub, "f1", "k1", 30_000).await;
        assert!(r1.is_err());
        hub.ops.state().drop_target_after_send = false;
        // 基线:无失败时一场成功 ask 的耗时(含 2.5s 稳定窗)
        let t_base = std::time::Instant::now();
        let r_ok = ask_conv(&hub, "base", "k_base", 30_000).await;
        assert!(r_ok.is_ok());
        let baseline = t_base.elapsed();
        // 第二次 ask:退避 ≥1s → 总耗时应 ≥ 基线 + 900ms
        let t1 = std::time::Instant::now();
        let r2 = ask_conv(&hub, "r2", "k1", 30_000).await;
        assert!(r2.is_ok());
        let with_backoff = t1.elapsed();
        assert!(
            with_backoff.as_millis() >= baseline.as_millis() + 900,
            "连续失败后应指数退避: 基线 {baseline:?} vs 退避后 {with_backoff:?}"
        );
        // 成功清零:第三次不再退避(耗时应回落到基线水平)
        let t2 = std::time::Instant::now();
        let r3 = ask_conv(&hub, "r3", "k1", 30_000).await;
        assert!(r3.is_ok());
        let cleared = t2.elapsed();
        assert!(
            cleared.as_millis() + 500 < with_backoff.as_millis(),
            "成功后退避应清零: {cleared:?} vs {with_backoff:?}"
        );
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
        let ops = RealCdpOps::default();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            ops.kill_and_launch(&profile, "https://chat.deepseek.com")
                .await
                .expect("kill_and_launch(端口文件 + 浏览器级 WS)");
            let port = ops.probe_port(&profile).await.expect("probe_port");
            let target = ops
                .create_page(
                    port,
                    "https://chat.deepseek.com",
                    activity::TargetPlacement::Tab,
                )
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
