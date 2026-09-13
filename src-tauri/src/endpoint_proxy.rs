// 配置端点代理:可配置 origin 的外部请求(llm / ocr / gptsovits)统一经此发出。
//
// 为什么不放前端自由 fetch:capability scope 是静态的,而这三类端点的地址由
// 用户配置(自定义 OpenAI 兼容网关、局域网 GPT-SoVITS),静态白名单要么放行
// http://*(等于向前端开放任意内网请求),要么把合法配置挡死。把请求移进
// Rust后,前端只给 kind + 相对路径——origin 由 Rust 从 config.json 解析,
// 鉴权头由 Rust 从凭据库注入,前端从头到尾接触不到完整 URL 与密钥。
//
// 硬化清单(评审 PR C 规格):
//   · 仅 POST(三类端点的唯一合法方法),前端不可指定 method 与 header
//   · 目标 = 配置里的 base + 相对路径;resolve_target 重解析最终 URL 并复核
//     scheme/host/port 未被路径改变,拒绝 userinfo 与控制字符
//   · 禁止重定向(Policy::none):3xx 直接返回状态码,不做 SSRF 跳板
//   · 请求体 ≤ 2MB,响应累计 ≤ 32MB;连接超时 10s,总超时前端可调(1s~300s)
//   · 日志不含 Authorization/Cookie(错误文案只带 URL 路径与状态码)
//   · 取消:endpoint_cancel 经 oneshot 中断,连着请求一起 drop(连接即断)
//
// 固定 https 厂商(videoGen/商用 TTS/B站接口)不走本代理:它们受静态 scope
// 管辖,白名单收得拢;B站通道见 bili_http.rs(同样逐跳校验重定向)。

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
        other => Err(format!("未知端点类型: {other}")),
    }
}

/// 从配置文件解析 base。前端写配置非原子:撕裂读稍候重试一次。
/// config.json 不含明文密钥(PR A),读它不等于读凭证。
fn configured_base(app: &AppHandle, kind: &str) -> Result<String, String> {
    let (pointer, _) = kind_spec(kind)?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("data")
        .join("config.json");
    let mut last_err: Option<String> = None;
    for attempt in 0..2 {
        let outcome = (|| -> Result<String, String> {
            let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
            let v: Value = serde_json::from_str(&raw).map_err(|e| format!("配置解析失败: {e}"))?;
            let s = v
                .pointer(pointer)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if s.is_empty() {
                return Err("未配置端点地址(请在设置里填写后重试)".into());
            }
            Ok(s)
        })();
        match outcome {
            Ok(s) => return Ok(s),
            Err(e) => {
                last_err = Some(e);
                if attempt == 0 {
                    std::thread::sleep(Duration::from_millis(150));
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "读取配置失败".into()))
}

/// 鉴权头由 Rust 注入(密钥不流经前端);gptsovits 本地服务无鉴权
fn auth_header(kind: &str) -> Result<Option<String>, String> {
    let needs_auth = kind_spec(kind)?.1;
    if !needs_auth {
        return Ok(None);
    }
    let secret_id = match kind {
        "llm" => "llm:apiKey",
        _ => "ocr:apiKey",
    };
    Ok(crate::secrets::read_secret(secret_id)?.map(|k| format!("Bearer {k}")))
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
        let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
        let status = resp.status().as_u16();
        let mut stream = resp.bytes_stream();
        let mut total: usize = 0;
        loop {
            match stream.next().await {
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
                Some(Err(e)) => return Err(format!("响应读取失败: {e}")),
                None => return Ok(status),
            }
        }
    };

    let out = tokio::select! {
        r = work => r,
        _ = rx => Err(CANCELLED.to_string()),
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
    on_chunk: Channel<InvokeResponseBody>,
) -> Result<u16, String> {
    let base = configured_base(&app, &kind)?;
    let auth = auth_header(&kind)?;
    let timeout = timeout_ms.unwrap_or(90_000).clamp(1_000, 300_000);
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
    fn kind_spec_allows_only_three_kinds() {
        assert!(kind_spec("llm").is_ok());
        assert!(kind_spec("ocr").is_ok());
        assert!(kind_spec("gptsovits").is_ok());
        assert!(kind_spec("anything").is_err());
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
