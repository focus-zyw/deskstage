// B站接口专用 HTTP 通道:tauri-plugin-http 会按 fetch 规范剥离 JS 请求里的
// Cookie/Referer 等禁止头(commands.rs 的 is_forbidden 列表),而扫码登录、弹幕
// 服务器接口必须携带这些头(buvid/bili_ticket 设备凭证)。此命令用自有 reqwest
// 客户端全量透传请求头,并回传响应的 Set-Cookie,仅放行B站域名,避免被当成通用代理面滥用。
use tauri::command;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ALLOWED_PREFIXES: [&str; 3] = [
    "https://passport.bilibili.com/",
    "https://api.bilibili.com/",
    "https://api.live.bilibili.com/",
];

#[command]
pub async fn bili_http_request(
    url: String,
    method: Option<String>,
    cookie: Option<String>,
    referer: Option<String>,
) -> Result<serde_json::Value, String> {
    if !ALLOWED_PREFIXES.iter().any(|p| url.starts_with(p)) {
        return Err(format!("非B站接口:{}", &url[..url.len().min(64)]));
    }
    let client = tauri_plugin_http::reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(15))
        // 重定向逐跳重校验:默认跟随会绕出域名白名单(SSRF 跳板)
        .redirect(tauri_plugin_http::reqwest::redirect::Policy::custom(
            |attempt| {
                if attempt.previous().len() > 3 {
                    return attempt.error("重定向次数过多");
                }
                let url = attempt.url();
                let host_ok = url
                    .host_str()
                    .is_some_and(|h| h == "bilibili.com" || h.ends_with(".bilibili.com"));
                if url.scheme() == "https" && host_ok {
                    attempt.follow()
                } else {
                    attempt.error("重定向目标越出 B站域名")
                }
            },
        ))
        .build()
        .map_err(|e| e.to_string())?;
    let method = match method.as_deref().unwrap_or("GET").to_uppercase().as_str() {
        "POST" => tauri_plugin_http::reqwest::Method::POST,
        _ => tauri_plugin_http::reqwest::Method::GET,
    };
    let mut req = client.request(method, &url).header(
        "Referer",
        referer.unwrap_or_else(|| "https://live.bilibili.com/".into()),
    );
    if let Some(c) = cookie.filter(|c| !c.trim().is_empty()) {
        req = req.header("Cookie", c);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let set_cookie: Vec<String> = resp
        .headers()
        .get_all(tauri_plugin_http::reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(String::from))
        .collect();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": body, "set_cookie": set_cookie }))
}
