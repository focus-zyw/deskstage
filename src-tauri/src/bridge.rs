// 本地影子大脑桥(Shadow Brain AgentBridge)——外部编码 Agent 的运行现场入口。
//! 设计:docs/影子大脑桥接设计方案.md。**仅 dev 构建生效**(release 下所有命令
//! 返回错误,监听器整体不存在):开发期让 Agent 用 curl 读现场快照、提交决策,
//! 正式版零打包。Rust 侧是纯传输:HTTP/1.1 手写极小实现(零新依赖)、输入环、
//! 接管长轮询挂号、指挥回执;语义(清洗/配对/落盘/执行)全在 TS 侧 src/brain/。
//!
//! 安全:仅绑定 127.0.0.1;全部端点要求 X-Bridge-Token(首启随机,TS 持久化在
//! appData/data/bridge.json 供 Agent 发现);无 token 一律 401。
//!
//! 事件(Rust→TS):`bridge-decision`(外部决策,影子与接管同通道)、
//! `bridge-speak`(现场指挥)。命令(TS→Rust):bridge_start/bridge_stop/
//! bridge_push_input/bridge_offer_request/bridge_speak_reply/bridge_status。

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, RwLock};

/// 跨传输出口抽象:Rust 桥把外部决策/指挥转交给 TS(事件)。
/// 抽出来是为了回环测试能用收集器替身,不依赖 Tauri AppHandle。
/// (release 下只有命令桩碰它,无人调用转发方法,显式豁免)
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub trait BridgeSink: Send + Sync {
    fn emit_decision(&self, payload: Value);
    fn emit_speak(&self, payload: Value);
}

/// 生产出口:Tauri 全局事件(主窗 TS 侧监听消费)。release 下不会构造(桥整体缺席)
#[allow(dead_code)]
struct AppHandleSink(tauri::AppHandle);

impl BridgeSink for AppHandleSink {
    fn emit_decision(&self, payload: Value) {
        use tauri::Emitter;
        let _ = self.0.emit("bridge-decision", payload);
    }
    fn emit_speak(&self, payload: Value) {
        use tauri::Emitter;
        let _ = self.0.emit("bridge-speak", payload);
    }
}

/// 空出口:默认态/测试无关路径,丢弃一切转发
struct NullSink;

impl BridgeSink for NullSink {
    fn emit_decision(&self, _payload: Value) {}
    fn emit_speak(&self, _payload: Value) {}
}

/// 共享态:互斥量拆开,临界区只碰内存,绝不持锁跨 await。
/// release 下只有命令桩碰它(仅构造不读),dead_code 在该配置下显式豁免
#[cfg_attr(not(debug_assertions), allow(dead_code))]
struct Shared {
    meta: Mutex<Meta>,
    inputs: Mutex<VecDeque<Value>>,
    waiter: Mutex<Option<tokio::sync::oneshot::Sender<Value>>>,
    speak: Mutex<Option<tokio::sync::oneshot::Sender<Value>>>,
    sink: RwLock<Box<dyn BridgeSink>>,
}

#[allow(dead_code)] // release 桩不消费全部字段,保留同一结构减少分叉
struct Meta {
    token: String,
    port: u16,
    started_at: u128,
    task: Option<tokio::task::JoinHandle<()>>,
    counts: Counts,
}

#[allow(dead_code)]
#[derive(Default, Clone, Copy)]
struct Counts {
    decisions: u64,
    speaks: u64,
    offers: u64,
    pushes: u64,
}

/// Tauri 管理态(release 也注册:命令壳共用,桩实现返回错误)
pub struct BridgeState {
    inner: Arc<Shared>,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Shared {
                meta: Mutex::new(Meta {
                    token: String::new(),
                    port: 0,
                    started_at: 0,
                    task: None,
                    counts: Counts::default(),
                }),
                inputs: Mutex::new(VecDeque::new()),
                waiter: Mutex::new(None),
                speak: Mutex::new(None),
                sink: RwLock::new(Box::new(NullSink)),
            }),
        }
    }
}

impl BridgeState {
    /// 注入生产出口(bridge_start 时调用;测试注入收集器)
    pub fn set_sink(&self, sink: Box<dyn BridgeSink>) {
        *self.inner.sink.write().unwrap() = sink;
    }
}

// dev 服务器专用的转发助手(release 桩用不到,随 dev 模块一起缺席)
#[cfg(debug_assertions)]
impl BridgeState {
    fn emit_decision(&self, payload: Value) {
        if let Ok(sink) = self.inner.sink.read() {
            sink.emit_decision(payload);
        }
    }

    fn emit_speak(&self, payload: Value) {
        if let Ok(sink) = self.inner.sink.read() {
            sink.emit_speak(payload);
        }
    }

    fn with_meta<R>(&self, f: impl FnOnce(&mut Meta) -> R) -> R {
        let mut meta = self.inner.meta.lock().unwrap();
        f(&mut meta)
    }
}

// ---------- 命令壳(TS→Rust;debug 走 dev 实现,release 走 prod 桩) ----------

/// 启动本地监听(token 必配,port 0 = 随机);返回实际端口。幂等:已运行仅更新 token
#[tauri::command]
pub async fn bridge_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, BridgeState>,
    token: String,
) -> Result<u16, String> {
    state.set_sink(Box::new(AppHandleSink(app)));
    #[cfg(debug_assertions)]
    return dev::start(&state, token).await;
    #[cfg(not(debug_assertions))]
    {
        let _ = &state;
        let _ = token;
        Err("影子大脑桥仅在 dev 构建提供".into())
    }
}

/// 停止监听(配置关掉时;未运行是空操作)
#[tauri::command]
pub async fn bridge_stop(state: tauri::State<'_, BridgeState>) -> Result<(), String> {
    #[cfg(debug_assertions)]
    return dev::stop(&state).await;
    #[cfg(not(debug_assertions))]
    {
        let _ = &state;
        Ok(())
    }
}

/// TS 侧把当前 BrainInput 推入环(每 tick 一次);返回环长度
#[tauri::command]
pub async fn bridge_push_input(
    state: tauri::State<'_, BridgeState>,
    input: Value,
) -> Result<usize, String> {
    #[cfg(debug_assertions)]
    return dev::push_input(&state, input).await;
    #[cfg(not(debug_assertions))]
    {
        let _ = (&state, &input);
        Err("影子大脑桥仅在 dev 构建提供".into())
    }
}

/// 接管请求投递:有 Agent 挂在长轮询上即取走(返回 true),无人接 = false(TS 回落本地)
#[tauri::command]
pub async fn bridge_offer_request(
    state: tauri::State<'_, BridgeState>,
    request: Value,
) -> Result<bool, String> {
    #[cfg(debug_assertions)]
    return Ok(dev::offer_request(&state, request));
    #[cfg(not(debug_assertions))]
    {
        let _ = (&state, &request);
        Err("影子大脑桥仅在 dev 构建提供".into())
    }
}

/// 指挥回执:TS 侧过闸/播出判定后回填 /brain/speak 的 HTTP 响应
#[tauri::command]
pub async fn bridge_speak_reply(
    state: tauri::State<'_, BridgeState>,
    ok: bool,
    error: Option<String>,
) -> Result<(), String> {
    #[cfg(debug_assertions)]
    return Ok(dev::speak_reply(&state, ok, error));
    #[cfg(not(debug_assertions))]
    {
        let _ = (&state, &ok, &error);
        Err("影子大脑桥仅在 dev 构建提供".into())
    }
}

/// 桥状态(设置卡展示:端口/计数/是否运行)
#[tauri::command]
pub async fn bridge_status(state: tauri::State<'_, BridgeState>) -> Result<Value, String> {
    #[cfg(debug_assertions)]
    return Ok(dev::status(&state).await);
    #[cfg(not(debug_assertions))]
    {
        let _ = &state;
        Ok(json!({ "devBuild": false, "running": false }))
    }
}

// ---------- dev 实现(仅 debug_assertions 编译) ----------

#[cfg(debug_assertions)]
mod dev {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 输入环上限:约等于 30 分钟的 tick 粒度(15s 一个)
    const RING_CAP: usize = 120;
    /// 接管长轮询的等待上限(超出的 clamp 下来)
    const LONG_POLL_CAP_MS: u64 = 60_000;
    /// 指挥回执预算:TS 侧过闸与播出起播的判定窗口
    const SPEAK_REPLY_BUDGET_MS: u64 = 3_000;
    /// 单请求体上限
    const BODY_CAP: usize = 256 * 1024;

    pub async fn start(state: &BridgeState, token: String) -> Result<u16, String> {
        // 幂等:已运行只更新 token,返回现端口
        let already = state.with_meta(|m| {
            m.token = token;
            m.task.as_ref().map(|t| !t.is_finished()).unwrap_or(false)
        });
        if already {
            return Ok(state.with_meta(|m| m.port));
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("桥监听绑定失败:{e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("桥监听地址读取失败:{e}"))?
            .port();
        let shared = Arc::clone(&state.inner);
        let task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let shared = Arc::clone(&shared);
                        tokio::spawn(async move {
                            let _ = handle_conn(stream, shared).await;
                        });
                    }
                    Err(_) => break, // 监听器异常退出,循环结束(停止 = abort 本任务)
                }
            }
        });
        state.with_meta(|m| {
            m.port = port;
            m.started_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            m.task = Some(task);
        });
        Ok(port)
    }

    pub async fn stop(state: &BridgeState) -> Result<(), String> {
        let task = state.with_meta(|m| {
            m.port = 0;
            m.task.take()
        });
        if let Some(task) = task {
            task.abort();
        }
        Ok(())
    }

    pub async fn push_input(state: &BridgeState, input: Value) -> Result<usize, String> {
        if !input.is_object() {
            return Err("input 必须是对象".into());
        }
        let mut inputs = state.inner.inputs.lock().unwrap();
        inputs.push_back(input);
        while inputs.len() > RING_CAP {
            inputs.pop_front();
        }
        state.with_meta(|m| m.counts.pushes += 1);
        Ok(inputs.len())
    }

    /// 有 Agent 挂在长轮询上即完成它;无人接 = false(TS 侧回落本地大脑)
    pub fn offer_request(state: &BridgeState, request: Value) -> bool {
        let tx = state.inner.waiter.lock().unwrap().take();
        match tx {
            Some(tx) => {
                let _ = tx.send(request);
                state.with_meta(|m| m.counts.offers += 1);
                true
            }
            None => false,
        }
    }

    pub fn speak_reply(state: &BridgeState, ok: bool, error: Option<String>) {
        let tx = state.inner.speak.lock().unwrap().take();
        if let Some(tx) = tx {
            let _ = tx.send(json!({ "ok": ok, "error": error }));
        }
    }

    pub async fn status(state: &BridgeState) -> Value {
        let (token_set, port, started_at, counts, running) = state.with_meta(|m| {
            (
                !m.token.is_empty(),
                m.port,
                m.started_at,
                m.counts,
                m.task.as_ref().map(|t| !t.is_finished()).unwrap_or(false),
            )
        });
        let inputs = state.inner.inputs.lock().unwrap().len();
        let waiting = state.inner.waiter.lock().unwrap().is_some();
        json!({
            "app": "DeskStage",
            "bridge": "shadow-brain",
            "devBuild": true,
            "running": running,
            "tokenSet": token_set,
            "port": port,
            "startedAt": started_at,
            "inputs": inputs,
            "agentWaiting": waiting,
            "counts": {
                "decisions": counts.decisions,
                "speaks": counts.speaks,
                "offers": counts.offers,
                "pushes": counts.pushes,
            },
        })
    }

    // ---------- HTTP 极小实现 ----------

    struct Request {
        method: String,
        path: String,
        query: String,
        token: Option<String>,
        body: Vec<u8>,
    }

    async fn read_request(stream: &mut tokio::net::TcpStream) -> Result<Request, String> {
        let mut buf: Vec<u8> = Vec::with_capacity(1024);
        let mut chunk = [0u8; 2048];
        let head_end = loop {
            if let Some(pos) = find(&buf, b"\r\n\r\n") {
                break pos;
            }
            if buf.len() > 32 * 1024 {
                return Err("头过大".into());
            }
            let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk))
                .await
                .map_err(|_| "读头超时".to_string())?
                .map_err(|e| format!("读头失败:{e}"))?;
            if n == 0 {
                return Err("连接提前关闭".into());
            }
            buf.extend_from_slice(&chunk[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let mut lines = head.split("\r\n");
        let request_line = lines.next().unwrap_or("");
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_uppercase();
        let target = parts.next().unwrap_or("/");
        let (path, query) = match target.split_once('?') {
            Some((p, q)) => (p.to_string(), q.to_string()),
            None => (target.to_string(), String::new()),
        };
        let mut token = None;
        let mut content_length = 0usize;
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                let name = name.trim().to_ascii_lowercase();
                let value = value.trim();
                if name == "x-bridge-token" {
                    token = Some(value.to_string());
                } else if name == "content-length" {
                    content_length = value.parse().unwrap_or(0);
                }
            }
        }
        if content_length > BODY_CAP {
            return Err("体过大".into());
        }
        let mut body: Vec<u8> = buf[head_end + 4..].to_vec();
        while body.len() < content_length {
            let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk))
                .await
                .map_err(|_| "读体超时".to_string())?
                .map_err(|e| format!("读体失败:{e}"))?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
        body.truncate(content_length);
        Ok(Request {
            method,
            path,
            query,
            token,
            body,
        })
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    async fn write_json(
        stream: &mut tokio::net::TcpStream,
        status: u16,
        body: &Value,
    ) -> Result<(), String> {
        let text = body.to_string();
        let reason = match status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            404 => "Not Found",
            405 => "Method Not Allowed",
            429 => "Too Many Requests",
            _ => "Internal Server Error",
        };
        let head = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", text.len());
        stream
            .write_all(head.as_bytes())
            .await
            .map_err(|e| format!("写响应失败:{e}"))?;
        stream
            .write_all(text.as_bytes())
            .await
            .map_err(|e| format!("写响应失败:{e}"))?;
        stream
            .shutdown()
            .await
            .map_err(|e| format!("关闭连接失败:{e}"))
    }

    async fn handle_conn(mut stream: tokio::net::TcpStream, shared: Arc<Shared>) {
        let state = BridgeState { inner: shared };
        let response = match read_request(&mut stream).await {
            Ok(request) => route(&state, &request).await,
            Err(e) => (400, json!({ "ok": false, "error": e })),
        };
        if let Err(e) = write_json(&mut stream, response.0, &response.1).await {
            eprintln!("[bridge] 响应写出失败:{e}");
        }
    }

    fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
        query.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == key).then_some(v)
        })
    }

    fn check_token(state: &BridgeState, request: &Request) -> Result<(), (u16, Value)> {
        let token = state.with_meta(|m| m.token.clone());
        if request.token.as_deref() == Some(token.as_str()) && !token.is_empty() {
            Ok(())
        } else {
            Err((401, json!({ "ok": false, "error": "token 不匹配" })))
        }
    }

    async fn route(state: &BridgeState, request: &Request) -> (u16, Value) {
        if let Err(denied) = check_token(state, request) {
            return denied;
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/brain/status") => (200, status(state).await),
            ("GET", "/brain/inputs") => {
                let last = query_param(&request.query, "last")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(RING_CAP)
                    .clamp(1, RING_CAP);
                let inputs = state.inner.inputs.lock().unwrap();
                let picked: Vec<Value> = inputs.iter().rev().take(last).rev().cloned().collect();
                (200, json!({ "inputs": picked }))
            }
            ("POST", "/brain/decisions") => shadow_decisions(state, &request.body),
            ("GET", "/brain/requests") => long_poll(state, &request.query).await,
            ("POST", "/brain/decision") => takeover_decision(state, &request.body),
            ("POST", "/brain/speak") => speak(state, &request.body).await,
            ("GET", _) | ("POST", _) => (
                404,
                json!({ "ok": false, "error": "未知端点(见 docs/影子大脑桥接设计方案.md)" }),
            ),
            _ => (405, json!({ "ok": false, "error": "方法不支持" })),
        }
    }

    /// 影子批量应答:校验 inputId 在环内(拒绝基于过期现场发言),转发 TS 落盘
    fn shadow_decisions(state: &BridgeState, body: &[u8]) -> (u16, Value) {
        let parsed: Value = match serde_json::from_slice(body) {
            Ok(v) => v,
            Err(e) => return (400, json!({ "ok": false, "error": format!("体不是 JSON:{e}") })),
        };
        let Some(items) = parsed.get("decisions").and_then(Value::as_array) else {
            return (400, json!({ "ok": false, "error": "缺 decisions 数组" }));
        };
        let inputs = state.inner.inputs.lock().unwrap();
        let known = |id: &str| inputs.iter().any(|v| v.get("inputId").and_then(Value::as_str) == Some(id));
        let mut accepted = 0u64;
        let mut results = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            let id_ok = item
                .get("inputId")
                .and_then(Value::as_str)
                .map(known)
                .unwrap_or(false);
            if id_ok {
                state.emit_decision(json!({ "mode": "shadow", "decision": item }));
                accepted += 1;
                results.push(json!({ "index": index, "ok": true }));
            } else {
                results.push(json!({ "index": index, "ok": false, "error": "unknown-input" }));
            }
        }
        state.with_meta(|m| m.counts.decisions += accepted);
        (
            200,
            json!({ "ok": true, "accepted": accepted, "results": results }),
        )
    }

    /// 接管长轮询:挂号等待 TS 侧 offer;超时回空数组(Agent 据此继续轮)
    async fn long_poll(state: &BridgeState, query: &str) -> (u16, Value) {
        let wait_ms = query_param(query, "waitMs")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(25_000)
            .min(LONG_POLL_CAP_MS);
        let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
        {
            let mut waiter = state.inner.waiter.lock().unwrap();
            if waiter.is_some() {
                return (
                    429,
                    json!({ "ok": false, "error": "已有等待中的长轮询" }),
                );
            }
            *waiter = Some(tx);
        }
        match tokio::time::timeout(Duration::from_millis(wait_ms), rx).await {
            Ok(Ok(payload)) => (200, json!({ "requests": [payload] })),
            // 超时 / 发送端被丢弃(桥停止):一律按"本轮无请求"
            _ => (200, json!({ "requests": [] })),
        }
    }

    /// 接管应答:单条转发 TS(是否及时生效由 TS 侧按预算判定,迟到转影子)
    fn takeover_decision(state: &BridgeState, body: &[u8]) -> (u16, Value) {
        let parsed: Value = match serde_json::from_slice(body) {
            Ok(v) => v,
            Err(e) => return (400, json!({ "ok": false, "error": format!("体不是 JSON:{e}") })),
        };
        if parsed.get("requestId").and_then(Value::as_str).is_none() {
            return (400, json!({ "ok": false, "error": "缺 requestId" }));
        }
        state.emit_decision(json!({ "mode": "takeover", "decision": parsed }));
        state.with_meta(|m| m.counts.decisions += 1);
        (200, json!({ "ok": true }))
    }

    /// 现场指挥:转发 TS 过闸,3s 内收回执(过闸失败/正在播都要让 Agent 知道)
    async fn speak(state: &BridgeState, body: &[u8]) -> (u16, Value) {
        let parsed: Value = match serde_json::from_slice(body) {
            Ok(v) => v,
            Err(e) => return (400, json!({ "ok": false, "error": format!("体不是 JSON:{e}") })),
        };
        // 挂号与发射在锁块内完成,锁卫绝不跨 await(guard 不是 Send)
        let rx = {
            let mut speak = state.inner.speak.lock().unwrap();
            if speak.is_some() {
                return (429, json!({ "ok": false, "error": "已有指挥在等待回执" }));
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            *speak = Some(tx);
            rx
        };
        state.emit_speak(json!({ "body": parsed }));
        state.with_meta(|m| m.counts.speaks += 1);
        match tokio::time::timeout(Duration::from_millis(SPEAK_REPLY_BUDGET_MS), rx).await {
            Ok(Ok(reply)) => (200, reply),
            _ => (200, json!({ "ok": false, "error": "speak-timeout" })),
        }
    }

    // ---------- 回环测试:真实 TCP 打真实监听 ----------
    #[cfg(test)]
    mod tests {
        use super::*;

        /// 事件收集器:所有转发(决策/指挥)进同一条日志,(is_speak, payload) 对
        type EventLog = Arc<Mutex<Vec<(bool, Value)>>>;

        struct LogSink(EventLog);

        impl BridgeSink for LogSink {
            fn emit_decision(&self, payload: Value) {
                self.0.lock().unwrap().push((false, payload));
            }
            fn emit_speak(&self, payload: Value) {
                self.0.lock().unwrap().push((true, payload));
            }
        }

        async fn spawn_bridge() -> (BridgeState, u16) {
            let state = BridgeState::default();
            let port = dev::start(&state, "test-token".to_string()).await.unwrap();
            (state, port)
        }

        async fn http(
            port: u16,
            method: &str,
            path: &str,
            token: Option<&str>,
            body: Option<Value>,
        ) -> (u16, Value) {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            let body_text = body.map(|v| v.to_string()).unwrap_or_default();
            let mut head = format!(
                "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: {}\r\n",
                body_text.len()
            );
            if let Some(token) = token {
                head.push_str(&format!("x-bridge-token: {token}\r\n"));
            }
            head.push_str("\r\n");
            stream.write_all(head.as_bytes()).await.unwrap();
            if !body_text.is_empty() {
                stream.write_all(body_text.as_bytes()).await.unwrap();
            }
            let mut raw = String::new();
            stream.read_to_string(&mut raw).await.unwrap();
            let status: u16 = raw
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let body = raw
                .split("\r\n\r\n")
                .nth(1)
                .map(|s| serde_json::from_str(s).unwrap_or(Value::Null))
                .unwrap_or(Value::Null);
            (status, body)
        }

        fn sample_input(id: &str) -> Value {
            json!({ "inputId": id, "ts": 1, "local": { "candidate": "none" } })
        }

        #[tokio::test]
        async fn 无token一律401() {
            let (_state, port) = spawn_bridge().await;
            let (status, _) = http(port, "GET", "/brain/status", None, None).await;
            assert_eq!(status, 401);
            let (status, _) = http(port, "GET", "/brain/status", Some("错token"), None).await;
            assert_eq!(status, 401);
        }

        #[tokio::test]
        async fn 推入环后可经get取回() {
            let (state, port) = spawn_bridge().await;
            dev::push_input(&state, sample_input("brin_a")).await.unwrap();
            dev::push_input(&state, sample_input("brin_b")).await.unwrap();
            let (status, body) = http(port, "GET", "/brain/inputs?last=1", Some("test-token"), None).await;
            assert_eq!(status, 200);
            let inputs = body.get("inputs").and_then(Value::as_array).unwrap();
            assert_eq!(inputs.len(), 1);
            assert_eq!(inputs[0].get("inputId").and_then(Value::as_str), Some("brin_b"));
        }

        #[tokio::test]
        async fn 影子批量应答_未知id拒绝_已知id转发事件() {
            let (state, port) = spawn_bridge().await;
            let log: EventLog = Arc::default();
            state.set_sink(Box::new(LogSink(Arc::clone(&log))));
            dev::push_input(&state, sample_input("brin_ok")).await.unwrap();
            let body = json!({ "decisions": [
                { "inputId": "brin_ok", "decision": "listen" },
                { "inputId": "brin_过期", "decision": "listen" }
            ] });
            let (status, resp) =
                http(port, "POST", "/brain/decisions", Some("test-token"), Some(body)).await;
            assert_eq!(status, 200);
            assert_eq!(resp.get("accepted").and_then(Value::as_u64), Some(1));
            assert_eq!(
                resp.get("results").and_then(Value::as_array).unwrap()[1]
                    .get("error")
                    .and_then(Value::as_str),
                Some("unknown-input")
            );
            let events = log.lock().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].0, false, "决策走 decision 通道");
            assert_eq!(
                events[0].1.get("mode").and_then(Value::as_str),
                Some("shadow")
            );
        }

        #[tokio::test]
        async fn 长轮询挂号后offer立即送达() {
            let (state, port) = spawn_bridge().await;
            let poll = tokio::spawn(
                http(port, "GET", "/brain/requests?waitMs=3000", Some("test-token"), None),
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
            let offered = dev::offer_request(
                &state,
                json!({ "requestId": "breq_1", "candidate": "spontaneous" }),
            );
            assert!(offered, "有挂号时 offer 应成功");
            let (status, body) = poll.await.unwrap();
            assert_eq!(status, 200);
            let requests = body.get("requests").and_then(Value::as_array).unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(
                requests[0].get("requestId").and_then(Value::as_str),
                Some("breq_1")
            );
        }

        #[tokio::test]
        async fn 长轮询超时回空数组() {
            let (_state, port) = spawn_bridge().await;
            let (status, body) =
                http(port, "GET", "/brain/requests?waitMs=150", Some("test-token"), None).await;
            assert_eq!(status, 200);
            assert_eq!(
                body.get("requests").and_then(Value::as_array).map(Vec::len),
                Some(0)
            );
        }

        #[tokio::test]
        async fn 指挥回执闭环() {
            let (state, port) = spawn_bridge().await;
            let log: EventLog = Arc::default();
            state.set_sink(Box::new(LogSink(Arc::clone(&log))));
            let payload = json!({ "text": "你好" });
            let ask =
                tokio::spawn(http(port, "POST", "/brain/speak", Some("test-token"), Some(payload)));
            tokio::time::sleep(Duration::from_millis(50)).await;
            {
                let events = log.lock().unwrap();
                assert_eq!(events.len(), 1, "指挥应立即转发 TS");
                assert_eq!(events[0].0, true, "指挥走 speak 通道");
            }
            dev::speak_reply(&state, true, None);
            let (status, body) = ask.await.unwrap();
            assert_eq!(status, 200);
            assert_eq!(body.get("ok").and_then(Value::as_bool), Some(true));
        }
    }
}
