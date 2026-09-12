// 视频工坊的落盘辅助:把生成结果(平台给的临时下载链接)保存成用户选定的本地文件,
// 以及在资源管理器里定位已保存的文件。
// 为什么下载放 Rust:结果 URL 指向各家云存储的临时 CDN 域,不在 capabilities 的 http
// 放行清单里,WebView 侧 fetch 会被 scope/CORS 拦;Rust 侧 reqwest(tauri-plugin-http
// 的复用依赖,自带 rustls)不受该清单约束。

use tauri_plugin_http::reqwest;

/// 下载视频并写入用户选定的路径,返回写入字节数。
/// 内容小于 4KB 视为失效链接(平台对过期 URL 常返回小体积错误页)。
#[tauri::command]
pub async fn video_save_from_url(url: String, path: String) -> Result<u64, String> {
    if url.trim().is_empty() || path.trim().is_empty() {
        return Err("参数缺失".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 virtual-character")
        .build()
        .map_err(|e| format!("创建下载客户端失败:{e}"))?;
    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("连接下载地址失败:{e}"))?;
    if !res.status().is_success() {
        return Err(format!("下载失败:HTTP {}", res.status().as_u16()));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("读取下载数据失败:{e}"))?;
    if bytes.len() < 4096 {
        return Err("下载内容过小,链接可能已失效".into());
    }
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, &bytes).map_err(|e| format!("写入文件失败:{e}"))?;
    Ok(bytes.len() as u64)
}

/// 在资源管理器中定位文件(explorer /select);非 Windows 无实现。
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // /select 与路径必须是单个参数,带引号防路径含空格被拆
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败:{e}"))?;
    }
    #[cfg(not(windows))]
    let _ = path;
    Ok(())
}
