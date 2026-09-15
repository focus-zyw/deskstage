// 桌面环境感知:低敏感状态快照(仅分类与进程名,不读文档内容/剪贴板)。
// 一次调用返回全部传感器,前端低频轮询并做规则/冷却,避免变成"新闻播报"。
// - 电量/充电:GetSystemPowerStatus(255 = 无电池或未知 → null)
// - 网络:TCP 连通性探测(500ms 超时)
// - 前台应用:GetForegroundWindow → 进程名 → 本地分类映射(editor/browser/...),
//   返回类别 + exe 名;窗口标题属上下文感知,仅在前端显式传 includeTitle 时采集
//   (采集即截断,防注入清洗在前端 world/normalizer 统一执行);自己前台时全 None
// - 全屏应用:前台窗口矩形 ≈ 主显示器矩形
// - 连续使用:GetLastInputInfo 系统级输入空闲时长
// - 声音在播:WASAPI 默认渲染设备活动会话(附会话归属进程名,如 cloudmusic.exe;
//   是"什么应用在播",不是歌曲名)
// - CPU/内存:sysinfo 两次采样差值(CPU 采样需间隔 MINIMUM_CPU_UPDATE_INTERVAL)
//
// WASAPI 会话枚举与 CPU 双采样都有毫秒级阻塞,统一放 spawn_blocking 执行,
// 不卡主事件循环(光标轮询会停摆,见 audio_capture 同款处理)。

use serde::Serialize;

/// 采集选项:窗口标题属上下文感知(默认不采,前端按设置开关显式传入)
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvOptions {
    include_title: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvSnapshot {
    battery_percent: Option<u8>,
    charging: Option<bool>,
    network_ok: bool,
    /// 前台应用类别:editor/browser/terminal/media/other;自己在前台时为 None
    foreground: Option<String>,
    /// 前台进程 exe 名(小写,如 idea64.exe);友好名映射在前端渲染层本地做
    process_name: Option<String>,
    /// 前台窗口标题(仅 includeTitle 时采集;已截断;null = 未开启或自己在前台)
    active_window_title: Option<String>,
    fullscreen_app: bool,
    idle_minutes: u32,
    audio_playing: bool,
    /// 正在发声的应用进程名(WASAPI 会话归属,如 cloudmusic.exe)
    media_name: Option<String>,
    cpu_percent: Option<f32>,
    mem_percent: Option<f32>,
}

#[tauri::command]
pub async fn env_snapshot(options: Option<EnvOptions>) -> Result<EnvSnapshot, String> {
    let include_title = options.and_then(|o| o.include_title).unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || env_snapshot_blocking(include_title))
        .await
        .map_err(|e| format!("任务调度失败:{e}"))?
}

fn env_snapshot_blocking(include_title: bool) -> Result<EnvSnapshot, String> {
    let (foreground, process_name, active_window_title) = foreground_info(include_title);
    let (audio_playing, media_name) = media_info();
    let (cpu_percent, mem_percent) = cpu_mem_percent();
    Ok(EnvSnapshot {
        battery_percent: battery_percent(),
        charging: charging(),
        network_ok: network_ok(),
        fullscreen_app: fullscreen_app(),
        idle_minutes: idle_minutes(),
        foreground,
        process_name,
        active_window_title,
        audio_playing,
        media_name,
        cpu_percent,
        mem_percent,
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

/// 网络连通性:对公共 DNS 做一次 500ms 超时的 TCP 连接探测(逐地址尝试,任一可达即算通)
fn network_ok() -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;
    let Ok(addrs) = "223.5.5.5:53".to_socket_addrs() else {
        return false;
    };
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
            return true;
        }
    }
    false
}

/// 前台应用三元组:(exe 名小写, 类别, 窗口标题)。只取类别/exe 名,标题按需;
/// 自己在前台时返回全 None:别自己感知自己。
#[cfg(windows)]
fn foreground_info(include_title: bool) -> (Option<String>, Option<String>, Option<String>) {
    use windows::core::PWSTR;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, GA_ROOT,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return (None, None, None);
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        // 自己(主窗或控制台)前台时返回 None:别自己感知自己
        if pid == std::process::id() {
            return (None, None, None);
        }
        // 取根所有者窗口的进程(对话框归属主程序)
        let root = GetAncestor(hwnd, GA_ROOT);
        let mut root_pid: u32 = 0;
        GetWindowThreadProcessId(root, Some(&mut root_pid));
        let pid = if root_pid != 0 { root_pid } else { pid };

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        let handle = match handle {
            Ok(h) => h,
            Err(_) => return (None, None, None),
        };
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
            return (None, None, None);
        }
        let exe = String::from_utf16_lossy(&buf[..size as usize]);
        let base = exe.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
        let category = categorize(&base);
        // 标题取真实前台窗口(不是根所有者):用户看到的标题才是情境
        let title = if include_title {
            let mut tbuf = [0u16; 128];
            let n = GetWindowTextW(hwnd, &mut tbuf);
            Some(String::from_utf16_lossy(&tbuf[..(n.max(0) as usize).min(120)]))
        } else {
            None
        };
        (Some(base), Some(category), title)
    }
}

#[cfg(not(windows))]
fn foreground_info(_include_title: bool) -> (Option<String>, Option<String>, Option<String>) {
    (None, None, None)
}

/// 进程名 → 面向观众的类别(本地映射表,命中不了归 other)
fn categorize(exe: &str) -> String {
    // 代码编辑器/IDE:传统 IDE + AI 编程工具(ZCode/Windsurf/Trae/Zed 等)
    const EDITORS: &[&str] = &[
        "code.exe",
        "code - insiders.exe",
        "cursor.exe",
        "zcode.exe",
        "windsurf.exe",
        "trae.exe",
        "zed.exe",
        "idea64.exe",
        "webstorm64.exe",
        "pycharm64.exe",
        "clion64.exe",
        "goland64.exe",
        "rider64.exe",
        "phpstorm64.exe",
        "rubymine64.exe",
        "datagrip64.exe",
        "androidstudio64.exe",
        "devenv.exe",
        "eclipse.exe",
        "sublime_text.exe",
        "notepad++.exe",
        "notepad.exe",
        "gvim.exe",
        "neovide.exe",
        "emacs.exe",
        "wechatdevtools.exe",
        "hbuilderx.exe",
    ];
    const TERMINALS: &[&str] = &[
        "windowsterminal.exe",
        "cmd.exe",
        "powershell.exe",
        "pwsh.exe",
        "conhost.exe",
        "openconsole.exe",
        "wezterm-gui.exe",
        "alacritty.exe",
        "mintty.exe",
        "hyper.exe",
        "tabby.exe",
        "xshell.exe",
        "putty.exe",
        "mobaxterm.exe",
        "finalshell.exe",
        "windterm.exe",
        "ttermpro.exe",
    ];
    const BROWSERS: &[&str] = &[
        "chrome.exe",
        "msedge.exe",
        "firefox.exe",
        "browser.exe",
        "360se.exe",
        "360chrome.exe",
        "qqbrowser.exe",
        "opera.exe",
        "brave.exe",
        "vivaldi.exe",
        "arc.exe",
        "maxthon.exe",
        "sogouexplorer.exe",
        "huaweibrowser.exe",
        "quark.exe",
    ];
    const MEDIA: &[&str] = &[
        "cloudmusic.exe",
        "qqmusic.exe",
        "kugou.exe",
        "kuwo.exe",
        "potplayermini64.exe",
        "vlc.exe",
        "wmplayer.exe",
        "bilibili.exe",
        "mpv.exe",
        "dandanplay.exe",
        // 视频客户端:腾讯视频已确认;爱奇艺/优酷为高置信惯例名,不命中也只是不分类
        "qqlive.exe",
        "qyclient.exe",
        "youkuclient.exe",
        "douyin.exe",
        "spotify.exe",
        "foobar2000.exe",
        "aimp.exe",
        "musicbee.exe",
        "kodi.exe",
        "mpc-hc.exe",
        "mpc-hc64.exe",
        "mpc-be64.exe",
        "potplayer.exe",
    ];

    let is = |list: &[&str]| list.contains(&exe);
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
        let mut mi = windows::Win32::Graphics::Gdi::MONITORINFO {
            cbSize: std::mem::size_of::<windows::Win32::Graphics::Gdi::MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut mi).as_bool() {
            return false;
        }
        (rect.left <= tol)
            && (rect.top <= tol)
            && (rect.right >= sw - tol)
            && (rect.bottom >= sh - tol)
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
        return idle_ms / 60_000;
    }
    0
}

#[cfg(not(windows))]
fn idle_minutes() -> u32 {
    0
}

/// WASAPI 活动会话 → (是否在播, 归属进程名)。
/// 会话展示名多为空,取进程名更有信息量("cloudmusic.exe" 前端映射成"网易云音乐");
/// sysinfo 只刷单个 pid,不付全进程表的成本。
#[cfg(windows)]
fn media_info() -> (bool, Option<String>) {
    use wasapi::{DeviceEnumerator, SessionState};
    let _ = wasapi::initialize_mta();
    let playing_pid = (|| -> Option<u32> {
        let enumerator = DeviceEnumerator::new().ok()?;
        let device = enumerator.get_default_device(&wasapi::Direction::Render).ok()?;
        let manager = device.get_iaudiosessionmanager().ok()?;
        let sessions = manager.get_audiosessionenumerator().ok()?;
        let count = sessions.get_count().ok()?;
        for i in 0..count {
            let control = sessions.get_session(i).ok()?;
            if control.get_state().ok()? == SessionState::Active {
                if let Ok(pid) = control.get_process_id() {
                    return Some(pid);
                }
            }
        }
        None
    })();
    let Some(pid) = playing_pid else {
        return (false, None);
    };
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]), true);
    let name = sys
        .process(sysinfo::Pid::from_u32(pid))
        .map(|p| p.name().to_string_lossy().to_lowercase());
    (true, name)
}

#[cfg(not(windows))]
fn media_info() -> (bool, Option<String>) {
    (false, None)
}

/// CPU/内存占用。CPU 占用率是"两次刷新差值",静态 System 跨轮询保存采样状态;
/// 首帧只有一次采样,返回 None,下一帧起有值(60s 节奏下无感)。
fn cpu_mem_percent() -> (Option<f32>, Option<f32>) {
    use sysinfo::{MINIMUM_CPU_UPDATE_INTERVAL, System};
    static SYS: std::sync::Mutex<Option<System>> = std::sync::Mutex::new(None);
    let Ok(mut guard) = SYS.lock() else {
        return (None, None);
    };
    let sys = guard.get_or_insert_with(System::new);
    sys.refresh_cpu_usage();
    std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
    sys.refresh_cpu_usage();
    let cpu = sys.global_cpu_usage();
    sys.refresh_memory();
    let mem = if sys.total_memory() > 0 {
        (sys.used_memory() as f32 / sys.total_memory() as f32 * 100.0).min(100.0)
    } else {
        0.0
    };
    (Some(cpu), Some(mem))
}
