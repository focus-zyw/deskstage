// 配置端点代理:可配置 origin 的外部请求(llm / ocr / gptsovits / coldLocal)统一经此发出。
//
// 为什么不放前端自由 fetch:capability scope 是静态的,而这四类端点的地址由
// 用户配置(自定义 OpenAI 兼容网关、局域网 GPT-SoVITS、本机 llama-server),静态白名单要么放行
// http://*(等于向前端开放任意内网请求),要么把合法配置挡死。把请求移进
// Rust后,前端只给 kind + 相对路径——origin 由 Rust 从 config.json 解析,
// 鉴权头由 Rust 从凭据库注入,前端从头到尾接触不到完整 URL 与密钥。
//
// 硬化清单(评审 PR C 规格):
//   · 仅 POST(四类端点的唯一合法方法),前端不可指定 method 与 header
//   · 目标 = 配置里的 base + 相对路径;resolve_target 重解析最终 URL 并复核
//     scheme/host/port 未被路径改变,拒绝 userinfo 与控制字符
//   · 禁止重定向(Policy::none):3xx 直接返回状态码,不做 SSRF 跳板
//   · 请求体 ≤ 2MB,响应累计 ≤ 32MB;连接超时 10s,总超时前端可调(1s~300s)
//   · 日志不含 Authorization/Cookie(错误文案只带 URL 路径与状态码)
//   · 取消:endpoint_cancel 经 oneshot 中断,连着请求一起 drop(连接即断)
//
// 固定 https 厂商(videoGen/商用 TTS)不走本代理:它们受静态 scope 管辖,白名单收得拢。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

const MAX_REQ_BODY: usize = 2 * 1024 * 1024;
const MAX_RESP_BODY: usize = 32 * 1024 * 1024;
const CANCELLED: &str = "已取消";
/// 冷记忆本地嵌入缺省地址:llama-server 默认端口 + OpenAI 兼容前缀
/// (与前端 configStore 的 COLD_LOCAL_URL_DEFAULT 保持一致)
const COLD_LOCAL_URL_DEFAULT: &str = "http://127.0.0.1:8080/v1";

/// 进行中请求的取消通道:request_id → oneshot;cancel 命令触发发送
#[derive(Default)]
pub struct ProxyState {
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client 构建失败")
    })
}

/// base(可带路径前缀,如 https://api.deepseek.com/v1)+ 相对路径 → 最终 URL。
/// 重解析复核 scheme/host/port 未被路径改变:base 侧是用户配置的信任边界,
/// path 侧一律不得越出它。
fn resolve_target(base: &str, path_and_query: &str) -> Result<url::Url, String> {
    let bad = |why: &str| -> String { format!("端点地址不合法({why})") };
    let parsed = url::Url::parse(base.trim()).map_err(|_| bad("base 不是合法 URL"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(bad("仅支持 http/https"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(bad("不允许携带用户信息"));
    }
    if !path_and_query.starts_with('/') {
        return Err(bad("path 必须以 / 开头"));
    }
    if path_and_query
        .chars()
        .any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(bad("path 含空白或控制字符"));
    }
    let joined = format!(
        "{}{}",
        parsed.as_str().trim_end_matches('/'),
        path_and_query
    );
    let target = url::Url::parse(&joined).map_err(|_| bad("拼接后不是合法 URL"))?;
    let same = target.scheme() == parsed.scheme()
        && target.host_str() == parsed.host_str()
        && target.port_or_known_default() == parsed.port_or_known_default()
        && target.username() == parsed.username()
        && target.password() == parsed.password();
    if !same {
        return Err(bad("path 不得改变目标主机"));
    }
    Ok(target)
}

/// kind → (配置文件里的 base 指针, 是否需要 Authorization)
fn kind_spec(kind: &str) -> Result<(&'static str, bool), String> {
    match kind {
        "llm" => Ok(("/baseUrl", true)),
        "ocr" => Ok(("/ocr/baseUrl", true)),
        "gptsovits" => Ok(("/voice/gptsovits/url", false)),
        // 冷记忆本地嵌入:llama-server 手动起在用户自己机器上,免鉴权
        "coldLocal" => Ok(("/coldMemory/localUrl", false)),
        other => Err(format!("未知端点类型: {other}")),
    }
}

/// 解析端点 base。统一状态中心的内存配置优先:写路径经临时文件 rename 原子提交、
/// 加载在进程锁内单飞,内存态永不撕裂。服务未加载(极端场景)才回退读一次文件。
/// config.json 不含明文密钥,读它不等于读凭证。本地嵌入托管模块(local_embed_server)
/// 读配置同用此入口。
pub(crate) fn committed_or_file_config(app: &AppHandle) -> Result<Value, String> {
    if let Some(v) = crate::config_service::committed(app) {
        return Ok(v);
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("data")
        .join("config.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("配置解析失败: {e}"))
}

/// 模型档案 id 封闭字符集(与前端 PROFILE_ID_RE 一致)
fn is_valid_profile_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 模型档案解析:先校验 profileId,再按对象键读取——不拼 JSON Pointer,
/// 天然规避 '/'、'~' 转义与路径注入(评审③)。缺档案报可读错误。
fn profile_base(v: &Value, profile_id: &str) -> Result<String, String> {
    if !is_valid_profile_id(profile_id) {
        return Err(format!("模型档案 id 不合法: {profile_id}"));
    }
    let base = v
        .get("modelProfiles")
        .and_then(|m| m.get(profile_id))
        .and_then(|p| p.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if base.is_empty() {
        return Err(format!(
            "未找到模型档案 {profile_id} 的端点地址(请在设置的群聊角色绑定中配置)"
        ));
    }
    Ok(base.to_string())
}

/// 解析端点 base:kind 指针为缺省路径;kind=llm 且带 profile(非缺省/'main')时
/// 改走模型档案;kind=coldLocal 时应用托管的 llama-server 实例优先(临时端口),
/// 按需拉起模式在此闸门里触发后台拉起,手动模式回退配置地址。地址由 Rust 从
/// config.json 解析,前端从头到尾接触不到完整 URL。
fn configured_base(app: &AppHandle, kind: &str, profile: Option<&str>) -> Result<String, String> {
    let (pointer, _) = kind_spec(kind)?;
    let v = committed_or_file_config(app)?;
    if kind == "coldLocal" {
        match crate::local_embed_server::cold_local_gate(app) {
            crate::local_embed_server::ColdLocalGate::Ready(base) => return Ok(base),
            crate::local_embed_server::ColdLocalGate::Refuse(msg) => return Err(msg),
            crate::local_embed_server::ColdLocalGate::Manual => {}
        }
    }
    if kind == "llm" {
        if let Some(pid) = profile
            .map(str::trim)
            .filter(|p| !p.is_empty() && *p != "main")
        {
            return profile_base(&v, pid);
        }
    }
    let s = v
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if s.is_empty() {
        // 冷记忆本地嵌入有缺省地址(llama-server 默认端口):选了 local 没填地址也能用
        if kind == "coldLocal" {
            return Ok(COLD_LOCAL_URL_DEFAULT.to_string());
        }
        Err("未配置端点地址(请在设置里填写后重试)".into())
    } else {
        Ok(s.to_string())
    }
}

/// 鉴权头由 Rust 注入(密钥不流经前端);gptsovits 本地服务无鉴权。
/// 档案请求的 Key 从 'llm:profileKeys' 整组 JSON(map 型凭据)里按已校验的
/// 对象键取;Key 缺失返回无鉴权头——让厂商 401 暴露配置问题,而不是这里猜测。
fn auth_header(kind: &str, profile: Option<&str>) -> Result<Option<String>, String> {
    let needs_auth = kind_spec(kind)?.1;
    if !needs_auth {
        return Ok(None);
    }
    if kind == "llm" {
        if let Some(pid) = profile
            .map(str::trim)
            .filter(|p| !p.is_empty() && *p != "main")
        {
            if !is_valid_profile_id(pid) {
                return Err(format!("模型档案 id 不合法: {pid}"));
            }
            let raw = crate::secrets::read_secret("llm:profileKeys")?.unwrap_or_default();
            let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            let key = parsed.get(pid).and_then(Value::as_str).unwrap_or("").trim();
            return Ok(if key.is_empty() {
                None
            } else {
                Some(format!("Bearer {key}"))
            });
        }
        return Ok(crate::secrets::read_secret("llm:apiKey")?.map(|k| format!("Bearer {k}")));
    }
    Ok(crate::secrets::read_secret("ocr:apiKey")?.map(|k| format!("Bearer {k}")))
}

/// 代理请求参数(kind 解析后的最终形态;参数打包避免 8 参函数)
pub struct ProxyRequest<'a> {
    pub state: &'a ProxyState,
    pub request_id: &'a str,
    pub base: &'a str,
    pub auth: Option<String>,
    pub path_and_query: &'a str,
    pub body: String,
    pub timeout_ms: u64,
    pub channel: &'a Channel<InvokeResponseBody>,
}

/// 代理主体:发起 POST 并把响应体流式转发给前端通道,返回 HTTP 状态码
pub async fn proxy_core(req: ProxyRequest<'_>) -> Result<u16, String> {
    let ProxyRequest {
        state,
        request_id,
        base,
        auth,
        path_and_query,
        body,
        timeout_ms,
        channel,
    } = req;
    if body.len() > MAX_REQ_BODY {
        return Err("请求体过大".into());
    }
    let target = resolve_target(base, path_and_query)?;
    let host_for_log = target.host_str().unwrap_or("?").to_string();
    let has_auth = auth.is_some();
    let is_stream_req = body.contains("\"stream\":true") || body.contains("\"stream\": true");
    let mut req = client()
        .post(target)
        .header("Content-Type", "application/json");
    if let Some(a) = auth {
        req = req.header("Authorization", a);
    }
    req = req
        .body(body.into_bytes())
        .timeout(Duration::from_millis(timeout_ms));

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .insert(request_id.to_string(), tx);

    let work = async {
        log::info!("端点代理发送: host={host_for_log} stream={is_stream_req}");
        let resp = req.send().await.map_err(|e| {
            log::warn!("端点代理发送失败: host={host_for_log} err={e}");
            format!("请求失败: {e}")
        })?;
        let status = resp.status().as_u16();
        log::info!("端点代理响应头: host={host_for_log} status={status}");
        let mut stream = resp.bytes_stream();
        let mut total: usize = 0;
        // 流空闲超时:仅对 SSE 流式请求启用。上游挂起(200+心跳后迟迟不出正文)时
        // 快速失败,避免前端等满整个请求超时;非流式生成完成前 body 本就无数据,
        // 空闲判定会误杀长生成,仍由整体 timeout 兜底
        const STREAM_IDLE: Duration = Duration::from_secs(45);
        let idle = if is_stream_req {
            Some(STREAM_IDLE)
        } else {
            None
        };
        loop {
            let next = match idle {
                Some(d) => match tokio::time::timeout(d, stream.next()).await {
                    Err(_) => {
                        log::warn!(
                            "端点代理流空闲超时: host={host_for_log} idle={d:?} total={total}"
                        );
                        return Err("响应体空闲超时(上游长时间无数据)".into());
                    }
                    Ok(next) => next,
                },
                None => stream.next().await,
            };
            match next {
                Some(Ok(chunk)) => {
                    total += chunk.len();
                    if total > MAX_RESP_BODY {
                        return Err("响应体过大".into());
                    }
                    if channel
                        .send(InvokeResponseBody::Raw(chunk.to_vec()))
                        .is_err()
                    {
                        return Err("前端通道已关闭".into());
                    }
                }
                Some(Err(e)) => {
                    log::warn!("端点代理流读失败: host={host_for_log} err={e}");
                    return Err(format!("响应读取失败: {e}"));
                }
                None => {
                    // 空字节哨兵:Channel 内部保序,前端见到它即知 body 已完整,
                    // 与 invoke 返回值何时不相关(IPC 两条通路间无顺序保证)
                    let _ = channel.send(InvokeResponseBody::Raw(vec![]));
                    log::info!(
                        "端点代理完成: host={host_for_log} status={status} bytes={total} auth={has_auth}"
                    );
                    return Ok(status);
                }
            }
        }
    };

    let out = tokio::select! {
        r = work => r,
        _ = rx => {
            log::info!("端点代理取消: host={host_for_log}");
            Err(CANCELLED.to_string())
        }
    };
    if let Ok(mut map) = state.pending.lock() {
        map.remove(request_id);
    }
    out
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // command 签名由 IPC 契约决定,参数一一对应 invoke 传参
pub async fn endpoint_request(
    app: AppHandle,
    state: State<'_, ProxyState>,
    request_id: String,
    kind: String,
    path_and_query: String,
    body: String,
    timeout_ms: Option<u64>,
    profile: Option<String>,
    on_chunk: Channel<InvokeResponseBody>,
) -> Result<u16, String> {
    log::info!(
        "端点代理入口: kind={kind} path={path_and_query} body={}",
        body.len()
    );
    let base = configured_base(&app, &kind, profile.as_deref())?;
    let auth = auth_header(&kind, profile.as_deref())?;
    let timeout = timeout_ms.unwrap_or(90_000).clamp(1_000, 300_000);
    log::info!(
        "端点代理参数就绪: host={}",
        url::Url::parse(&base)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default()
    );
    proxy_core(ProxyRequest {
        state: &state,
        request_id: &request_id,
        base: &base,
        auth,
        path_and_query: &path_and_query,
        body,
        timeout_ms: timeout,
        channel: &on_chunk,
    })
    .await
}

#[tauri::command]
pub fn endpoint_cancel(state: State<'_, ProxyState>, request_id: String) -> Result<(), String> {
    if let Ok(mut map) = state.pending.lock() {
        if let Some(tx) = map.remove(&request_id) {
            let _ = tx.send(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_target_joins_base_and_relative() {
        let ok = resolve_target("https://api.deepseek.com/v1", "/chat/completions").unwrap();
        assert_eq!(ok.as_str(), "https://api.deepseek.com/v1/chat/completions");
        // 尾斜杠归一
        let ok2 = resolve_target("http://127.0.0.1:9880/", "/tts").unwrap();
        assert_eq!(ok2.as_str(), "http://127.0.0.1:9880/tts");
        // 点段规范化:base 带 /v1 前缀时,DeepSeek Responses 用 ../ 回到源站根
        // (联网搜索走 /responses,参照实证可用实现;WHATWG URL 解析消解点段)
        let root = resolve_target("https://api.deepseek.com/v1", "/../responses").unwrap();
        assert_eq!(root.as_str(), "https://api.deepseek.com/responses");
    }

    #[test]
    fn resolve_target_rejects_malformed_and_hijack() {
        // 非 http/https
        assert!(resolve_target("ftp://x/y", "/a").is_err());
        // userinfo
        assert!(resolve_target("http://user:pw@evil.com/", "/a").is_err());
        // path 不以 / 开头
        assert!(resolve_target("http://h.com/", "http://evil.com/").is_err());
        // path 带空白/控制字符
        assert!(resolve_target("http://h.com/", "/a b").is_err());
        assert!(resolve_target("http://h.com/", "/a\n").is_err());
        // path 挪不走目标:写成 //evil.com/… 或 /@evil.com/…,重解析复核后
        // host 仍是 base 的(这是拼接后整体重新 parse 再复核的意义)
        let smuggle = resolve_target("http://h.com/base", "//evil.com/x").unwrap();
        assert_eq!(smuggle.host_str(), Some("h.com"));
        let at = resolve_target("http://h.com/", "/@evil.com/x").unwrap();
        assert_eq!(at.host_str(), Some("h.com"));
        assert!(at.username().is_empty());
    }

    #[test]
    fn kind_spec_allows_only_four_kinds() {
        assert!(kind_spec("llm").is_ok());
        assert!(kind_spec("ocr").is_ok());
        assert!(kind_spec("gptsovits").is_ok());
        // 冷记忆本地嵌入:免鉴权(本机 llama-server)
        assert!(kind_spec("coldLocal").is_ok());
        assert!(!kind_spec("coldLocal").unwrap().1);
        assert!(kind_spec("anything").is_err());
    }

    #[test]
    fn profile_id_rejects_path_characters_and_overflow() {
        assert!(is_valid_profile_id("deepseek-a"));
        assert!(is_valid_profile_id("B_2"));
        assert!(is_valid_profile_id("x1y9z0"));
        // 非法:空 / 路径符号 / JSON Pointer 转义字符 / 超长(评审③:非法 id 不进对象读取)
        assert!(!is_valid_profile_id(""));
        assert!(!is_valid_profile_id("a/b"));
        assert!(!is_valid_profile_id("a~b"));
        assert!(!is_valid_profile_id(".."));
        assert!(!is_valid_profile_id("含中文"));
        assert!(!is_valid_profile_id(&"x".repeat(49)));
    }

    #[test]
    fn profile_base_reads_by_object_key_never_pointer_interp() {
        let v: Value = serde_json::from_str(
            r#"{
            "modelProfiles": {
                "p1": { "label": "档案一", "baseUrl": "https://api.x.com/v1", "model": "m" },
                "a/b": { "baseUrl": "https://evil.example.com/v1" }
            }
        }"#,
        )
        .unwrap();
        assert_eq!(profile_base(&v, "p1").unwrap(), "https://api.x.com/v1");
        // 非法 id 一律拒绝:即使配置里恰好存在同名键(如 "a/b")也读不到
        assert!(profile_base(&v, "a/b").is_err());
        // 缺档案/缺地址报可读错误
        assert!(profile_base(&v, "missing").unwrap_err().contains("missing"));
        let empty: Value = serde_json::from_str("{}").unwrap();
        assert!(profile_base(&empty, "p1").unwrap_err().contains("p1"));
    }

    /// 本机回环集成:真实 TCP 服务器 + 真实 reqwest + 通道转发,CI 可跑
    #[test]
    fn proxy_streams_body_from_localhost() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf); // 请求头读一次即可(测试不校验细节)
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
                .unwrap();
        });

        let collected: std::sync::Arc<Mutex<Vec<u8>>> = std::sync::Arc::default();
        let sink = collected.clone();
        let channel = Channel::new(move |payload: InvokeResponseBody| {
            if let InvokeResponseBody::Raw(bytes) = payload {
                sink.lock().unwrap().extend_from_slice(&bytes);
            }
            Ok(())
        });

        let state = ProxyState::default();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let status = rt
            .block_on(proxy_core(ProxyRequest {
                state: &state,
                request_id: "test-1",
                base: &format!("http://{addr}"),
                auth: None,
                path_and_query: "/chat/completions",
                body: "{}".into(),
                timeout_ms: 5_000,
                channel: &channel,
            }))
            .unwrap();
        assert_eq!(status, 200);
        assert_eq!(collected.lock().unwrap().as_slice(), b"hello");
    }
}
