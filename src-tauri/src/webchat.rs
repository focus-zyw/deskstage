// 网页版生成通道 · Plan B:CDP 驱动系统 Edge。
//
// 为什么不用应用内嵌第二 WebView2:本机实测四连败——独立 profile 白屏、共享环境
// 白屏、诊断离线页(回环纯本地 HTML)也一帧画不出、历史截屏窗 0x8007139F。
// 渲染层在本应用的第二 WebView 上是坏的,无法修复,故改为遥控系统已装 Edge:
//   Edge(独立 --user-data-dir,不影响日常浏览)+ --remote-debugging-port
//   → 前端经 CDP(WebSocket)开标签页/注入 prompt/抓回复(见 src/engine/webchat.ts)。
// 登录 cookie 持久化在 webchat-edge-profile 目录,一次登录长期使用。
//
// 本模块只做两件事:找到并拉起 Edge、开关主覆盖层(登录/生成期间角色让路)。
// 调试端口约定 9223,与前端 src/engine/webchat.ts 的 CDP_PORT 保持一致。

use std::path::Path;
use std::process::Command;

use tauri::Manager;

/// CDP 调试端口(改这里必须同步改前端 webchat.ts 的 CDP_PORT)
pub const CDP_PORT: u16 = 9223;
const MAIN_LABEL: &str = "main";

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

/// 拉起 Edge(独立 profile + 调试端口)。url 缺省直达 DeepSeek 网页版。
/// 同 profile 已有实例在跑时,新进程只是唤起新窗口后立即退出,天然幂等;
/// 因此无论冷启还是复用,调用方之后轮询 CDP 端口就绪即可。
#[tauri::command]
pub fn webchat_edge_launch(app: tauri::AppHandle, url: Option<String>) -> Result<(), String> {
    let exe = find_edge()?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("webchat-edge-profile");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.arg(format!("--remote-debugging-port={CDP_PORT}"))
        // Chromium 111+ 默认拒绝一切带 Origin 头的 WS 连到调试端口(防恶意网页),
        // 我们的应用主窗口恰是浏览器页面,必须显式放行,否则 CDP 全部 403
        .arg("--remote-allow-origins=*")
        .arg(format!("--user-data-dir={}", dir.display()))
        .args([
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=960,760",
        ]);
    cmd.arg(url.unwrap_or_else(|| "https://chat.deepseek.com/".into()));
    cmd.spawn()
        .map_err(|e| format!("启动 Edge 失败({exe}): {e}"))?;
    Ok(())
}

/// 只杀我们 profile 的 Edge 实例(按命令行里的目录名过滤),绝不碰用户日常浏览的 Edge。
/// 用于「打开窗口」时带着新启动参数干净重启旧实例。
#[tauri::command]
pub fn webchat_edge_kill() -> Result<(), String> {
    let ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*webchat-edge-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    Command::new("powershell")
        .args(["-NoProfile", "-Command", ps])
        .output()
        .map_err(|e| format!("清理旧 Edge 实例失败: {e}"))?;
    Ok(())
}

/// 主覆盖层开关:登录/生成期间角色隐藏让路(全屏置顶层会挡住 Edge 与点击)
#[tauri::command]
pub fn webchat_main_visible(app: tauri::AppHandle, show: bool) {
    if let Some(m) = app.get_webview_window(MAIN_LABEL) {
        if show {
            let _ = m.show();
        } else {
            let _ = m.hide();
        }
    }
}
