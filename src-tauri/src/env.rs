// 桌面环境感知:低敏感状态快照(仅分类,不读窗口标题/文档内容/剪贴板)。
// 一次调用返回全部传感器,前端低频轮询并做规则/冷却,避免变成"新闻播报"。
// - 电量/充电:GetSystemPowerStatus(255 = 无电池或未知 → null)
// - 网络:TCP 连通性探测(500ms 超时)
// - 前台应用:GetForegroundWindow → 进程名 → 本地分类映射(editor/browser/...),
//   只返回类别不返回标题;自己前台时返回 None(别自己感知自己)
// - 全屏应用:前台窗口矩形 ≈ 主显示器矩形
// - 连续使用:GetLastInputInfo 系统级输入空闲时长
// - 声音在播:WASAPI 默认渲染设备存在活动会话(复用 audio_capture 的枚举模式)

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvSnapshot {
    battery_percent: Option<u8>,
    charging: Option<bool>,
    network_ok: bool,
    /// 前台应用类别:editor/browser/terminal/media/other;自己在前台时为 None
    foreground: Option<String>,
    fullscreen_app: bool,
    idle_minutes: u32,
    audio_playing: bool,
}

#[tauri::command]
pub fn env_snapshot() -> Result<EnvSnapshot, String> {
    Ok(EnvSnapshot {
        battery_percent: battery_percent(),
        charging: charging(),
        network_ok: network_ok(),
        foreground: foreground_category(),
        fullscreen_app: fullscreen_app(),
        idle_minutes: idle_minutes(),
        audio_playing: audio_playing(),
    })
}

/// 电量与充电状态。无电池(或数值未知)时两者都为 None。
#[cfg(windows)]
fn battery_percent() -> Option<u8> {
    use windows::Win32::System::Power::GetSystemPowerStatus;
    let mut st = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut st) }.is_err() {
        return None;
    }
    // 255 = 无电池/未知;128 = BatteryFlag 无电池
    if st.BatteryLifePercent == 255 || st.BatteryFlag == 128 {
        return None;
    }
    Some(st.BatteryLifePercent)
}

#[cfg(windows)]
fn charging() -> Option<bool> {
    use windows::Win32::System::Power::GetSystemPowerStatus;
    let mut st = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut st) }.is_err() || st.ACLineStatus == 255 {
        return None;
    }
    Some(st.ACLineStatus == 1)
}

#[cfg(not(windows))]
fn battery_percent() -> Option<u8> {
    None
}

#[cfg(not(windows))]
fn charging() -> Option<bool> {
    None
}

/// 网络连通性:对公共 DNS 做一次 500ms 超时的 TCP 连接探测
fn network_ok() -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;
    if let Ok(addrs) = "223.5.5.5:53".to_socket_addrs() {
        for addr in addrs {
            return TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok();
        }
    }
    false
}

/// 前台应用进程名 → 本地分类。只取类别,不取窗口标题/内容。
#[cfg(windows)]
fn foreground_category() -> Option<String> {
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, GA_ROOT,
    };
    use windows::core::PWSTR;

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        // 自己(主窗或控制台)前台时返回 None:别自己感知自己
        if pid == std::process::id() {
            return None;
        }
        // 取根所有者窗口的进程(对话框归属主程序)
        let root = GetAncestor(hwnd, GA_ROOT);
        let mut root_pid: u32 = 0;
        GetWindowThreadProcessId(root, Some(&mut root_pid));
        let pid = if root_pid != 0 { root_pid } else { pid };

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 260];
        let mut size = buf.len() as u32;
        if QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .is_err()
        {
            return None;
        }
        let exe = String::from_utf16_lossy(&buf[..size as usize]);
        let base = exe.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
        Some(categorize(&base))
    }
}

#[cfg(not(windows))]
fn foreground_category() -> Option<String> {
    None
}

/// 进程名 → 面向观众的类别(本地映射表,命中不了归 other)
fn categorize(exe: &str) -> String {
    // 代码编辑器/IDE:传统 IDE + AI 编程工具(ZCode/Windsurf/Trae/Zed 等)
    const EDITORS: &[&str] = &[
        "code.exe", "code - insiders.exe", "cursor.exe", "zcode.exe", "windsurf.exe",
        "trae.exe", "zed.exe",
        "idea64.exe", "webstorm64.exe", "pycharm64.exe", "clion64.exe", "goland64.exe",
        "rider64.exe", "phpstorm64.exe", "rubymine64.exe", "datagrip64.exe",
        "androidstudio64.exe", "devenv.exe", "eclipse.exe",
        "sublime_text.exe", "notepad++.exe", "notepad.exe",
        "gvim.exe", "neovide.exe", "emacs.exe",
        "wechatdevtools.exe", "hbuilderx.exe",
    ];
    const TERMINALS: &[&str] = &[
        "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "conhost.exe",
        "openconsole.exe", "wezterm-gui.exe", "alacritty.exe",
        "mintty.exe", "hyper.exe", "tabby.exe",
        "xshell.exe", "putty.exe", "mobaxterm.exe", "finalshell.exe", "windterm.exe",
        "ttermpro.exe",
    ];
    const BROWSERS: &[&str] = &[
        "chrome.exe", "msedge.exe", "firefox.exe", "browser.exe", "360se.exe",
        "360chrome.exe", "qqbrowser.exe", "opera.exe", "brave.exe",
        "vivaldi.exe", "arc.exe", "maxthon.exe", "sogouexplorer.exe",
        "huaweibrowser.exe", "quark.exe",
    ];
    const MEDIA: &[&str] = &[
        "cloudmusic.exe", "qqmusic.exe", "kugou.exe", "kuwo.exe", "potplayermini64.exe",
        "vlc.exe", "wmplayer.exe", "bilibili.exe", "mpv.exe", "dandanplay.exe",
        // 视频客户端:腾讯视频已确认;爱奇艺/优酷为高置信惯例名,不命中也只是不分类
        "qqlive.exe", "qyclient.exe", "youkuclient.exe", "douyin.exe",
        "spotify.exe", "foobar2000.exe", "aimp.exe", "musicbee.exe", "kodi.exe",
        "mpc-hc.exe", "mpc-hc64.exe", "mpc-be64.exe", "potplayer.exe",
    ];

    let is = |list: &[&str]| list.iter().any(|n| exe == *n);
    if is(EDITORS) {
        return "editor".into();
    }
    if is(TERMINALS) {
        return "terminal".into();
    }
    if is(BROWSERS) {
        return "browser".into();
    }
    if is(MEDIA) {
        return "media".into();
    }
    "other".into()
}

/// 前台窗口是否接近铺满主显示器(全屏应用/全屏视频)
#[cfg(windows)]
fn fullscreen_app() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowRect, SM_CXSCREEN, SM_CYSCREEN,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let sw = GetSystemMetrics(SM_CXSCREEN);
        let sh = GetSystemMetrics(SM_CYSCREEN);
        let tol = 8;
        // 前台窗自身铺满主屏(最大化窗口不算:两侧会留出任务栏以外区域?最大化恰好贴满工作区,
        // 工作区高 < 屏高,所以用"贴满四边"判定全屏而非最大化)
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = windows::Win32::Graphics::Gdi::MONITORINFO::default();
        mi.cbSize = std::mem::size_of::<windows::Win32::Graphics::Gdi::MONITORINFO>() as u32;
        if !GetMonitorInfoW(monitor, &mut mi).as_bool() {
            return false;
        }
        let covers_screen = (rect.left <= tol)
            && (rect.top <= tol)
            && (rect.right >= sw - tol)
            && (rect.bottom >= sh - tol);
        let _ = mi;
        covers_screen
    }
}

#[cfg(not(windows))]
fn fullscreen_app() -> bool {
    false
}

/// 系统级输入空闲分钟数(键鼠都没动多久)
#[cfg(windows)]
fn idle_minutes() -> u32 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        let idle_ms = unsafe { GetTickCount() }.saturating_sub(info.dwTime);
        return (idle_ms / 60_000) as u32;
    }
    0
}

#[cfg(not(windows))]
fn idle_minutes() -> u32 {
    0
}

/// 默认渲染设备上是否有活动音频会话(听歌/看视频中)
#[cfg(windows)]
fn audio_playing() -> bool {
    try_audio_playing().unwrap_or(false)
}

#[cfg(windows)]
fn try_audio_playing() -> Result<bool, String> {
    use wasapi::{DeviceEnumerator, SessionState};
    let _ = wasapi::initialize_mta();
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = enumerator
        .get_default_device(&wasapi::Direction::Render)
        .map_err(|e| e.to_string())?;
    let manager = device.get_iaudiosessionmanager().map_err(|e| e.to_string())?;
    let sessions = manager.get_audiosessionenumerator().map_err(|e| e.to_string())?;
    let count = sessions.get_count().map_err(|e| e.to_string())?;
    for i in 0..count {
        if let Ok(control) = sessions.get_session(i) {
            if let Ok(state) = control.get_state() {
                if state == SessionState::Active {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

#[cfg(not(windows))]
fn audio_playing() -> bool {
    false
}
