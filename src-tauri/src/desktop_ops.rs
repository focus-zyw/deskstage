// 桌面信息与确定性操作(阶段2:读;阶段3:操作)。
// 全部是自定义 #[tauri::command],模型不可直接触达——调用方是工具适配器,
// 经白名单 validate + policy 风险分级(确认卡)后才到这里;Rust 侧再放一道
// 硬校验,防未来新调用方绕过前端策略(模型只建议、不决定安全,双层兜底)。

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFileInfo {
    pub name: String,
    pub is_dir: bool,
    /// 目录恒 null(目录大小无意义)
    pub size_bytes: Option<u64>,
    /// 修改时间 ms;取不到为 null
    pub modified_ms: Option<u64>,
}

/// 桌面清单条数上限:摘要用,防巨型桌面拖垮 IPC
const DESKTOP_LIST_CAP: usize = 200;

/// 桌面文件清单(仅元数据:名称/类型/大小/修改时间,永不读内容)。
/// 桌面目录走已知文件夹 API(跟随 OneDrive 重定向),不用 USERPROFILE 拼接。
#[tauri::command]
pub fn desktop_files_list() -> Result<Vec<DesktopFileInfo>, String> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Shell::{
            FOLDERID_Desktop, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG,
        };
        unsafe {
            let path = SHGetKnownFolderPath(&FOLDERID_Desktop, KNOWN_FOLDER_FLAG(0), None)
                .map_err(|e| format!("取桌面目录失败:{e}"))?;
            let dir = path.to_string().map_err(|e| e.to_string())?;
            windows::Win32::System::Com::CoTaskMemFree(Some(path.as_ptr().cast()));
            list_dir_metadata(&dir)
        }
    }
    #[cfg(not(windows))]
    {
        Err("仅支持 Windows".into())
    }
}

#[cfg(windows)]
fn list_dir_metadata(dir: &str) -> Result<Vec<DesktopFileInfo>, String> {
    let mut out: Vec<DesktopFileInfo> = std::fs::read_dir(dir)
        .map_err(|e| format!("读桌面目录失败:{e}"))?
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            let is_dir = meta.is_dir();
            Some(DesktopFileInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                is_dir,
                size_bytes: if is_dir { None } else { Some(meta.len()) },
                modified_ms,
            })
        })
        .collect();
    // 最近动过的排前面(摘要展示顺序),超容截断
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out.truncate(DESKTOP_LIST_CAP);
    Ok(out)
}

/// 剪贴板文本。pull 制:只在用户明确要求时经工具调用读取一次,
/// 不做环境轮询也不进世界状态——密码/验证码常躺在剪贴板里,环境式读取风险不成比例。
#[tauri::command]
pub fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .read_text()
        .map_err(|e| format!("剪贴板没有文本或读取失败:{e}"))
}

// ---------- 阶段3:确定性操作 ----------
// 风险位次:模型只建议 → 前端适配器 validate 白名单 → policy external 确认卡 →
// 这里的 Rust 侧硬校验。四道里 Rust 这道不信任任何上游,独立成立。

/// system_open 的路径黑名单(小写扩展名):可执行类一律拒绝——
/// "打开应用"走 system_run_app(独立确认卡),open 只管文档/文件夹/网址。
/// .lnk 有意放行:桌面上打开快捷方式是正常用法,且有确认卡兜底
const OPEN_BLOCKED_EXTS: &[&str] = &[
    "exe", "bat", "cmd", "com", "pif", "scr", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf",
    "wsh", "hta", "msi", "msp", "mst", "jar", "apk", "reg",
];

fn validate_target_common(target: &str, max: usize) -> Result<(), String> {
    if target.is_empty() {
        return Err("目标为空".into());
    }
    if target.len() > max {
        return Err("目标过长".into());
    }
    if target.chars().any(|c| c.is_control()) {
        return Err("目标含非法控制字符".into());
    }
    Ok(())
}

fn validate_open_target(kind: &str, target: &str) -> Result<(), String> {
    validate_target_common(target, 2048)?;
    match kind {
        "url" => {
            if !(target.starts_with("http://") || target.starts_with("https://")) {
                return Err("网址只支持 http/https".into());
            }
            Ok(())
        }
        "path" => {
            let ext = std::path::Path::new(target)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_default();
            if OPEN_BLOCKED_EXTS.contains(&ext.as_str()) {
                return Err("可执行文件请用「启动应用」(需要确认)".into());
            }
            Ok(())
        }
        other => Err(format!("未知类型:{other}")),
    }
}

fn validate_app_target(target: &str) -> Result<(), String> {
    validate_target_common(target, 1024)?;
    let lower = target.to_lowercase();
    let bare = !lower.contains('\\') && !lower.contains('/');
    let is_bare_exe = bare
        && lower.ends_with(".exe")
        && lower
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '));
    let is_path_exe = !bare && lower.ends_with(".exe");
    if !is_bare_exe && !is_path_exe {
        return Err("只支持启动 .exe 程序(绝对路径或系统可解析的程序名)".into());
    }
    Ok(())
}

/// 打开网址/文件/文件夹(系统默认方式)
#[tauri::command]
pub fn system_open(kind: String, target: String) -> Result<(), String> {
    validate_open_target(&kind, &target)?;
    shell_open(&target)
}

/// 启动应用(.exe 绝对路径或系统可解析的程序名)
#[tauri::command]
pub fn system_run_app(target: String) -> Result<(), String> {
    validate_app_target(&target)?;
    shell_open(&target)
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let target_h: HSTRING = target.into();
    // 返回值 >32 = 成功(SELL 错误码约定)
    let code = unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            &target_h,
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    if code.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("系统拒绝打开(代码 {})", code.0 as isize))
    }
}

#[cfg(not(windows))]
fn shell_open(_target: &str) -> Result<(), String> {
    Err("仅支持 Windows".into())
}

/// 媒体键:playpause/next/prev/stop(全局多媒体键,不针对特定窗口)
#[tauri::command]
pub fn media_control(action: String) -> Result<(), String> {
    let vk: u16 = match action.as_str() {
        "playpause" => 0xB3, // VK_MEDIA_PLAY_PAUSE
        "next" => 0xB0,      // VK_MEDIA_NEXT_TRACK
        "prev" => 0xB1,      // VK_MEDIA_PREV_TRACK
        "stop" => 0xB2,      // VK_MEDIA_STOP
        other => return Err(format!("未知媒体动作:{other}")),
    };
    tap_media_key(vk)
}

#[cfg(windows)]
fn tap_media_key(vk: u16) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };
    let base = KEYBDINPUT {
        wVk: VIRTUAL_KEY(vk),
        wScan: 0,
        dwFlags: KEYEVENTF_EXTENDEDKEY,
        time: 0,
        dwExtraInfo: 0,
    };
    let down = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: base },
    };
    let up = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                dwFlags: KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP,
                ..base
            },
        },
    };
    let sent = unsafe { SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32) };
    if sent == 2 {
        Ok(())
    } else {
        Err("系统拒绝了模拟按键".into())
    }
}

#[cfg(not(windows))]
fn tap_media_key(_vk: u16) -> Result<(), String> {
    Err("仅支持 Windows".into())
}

/// 设置主音量 0~100
#[cfg(windows)]
#[tauri::command]
pub fn set_volume(level: f64) -> Result<(), String> {
    if !(0.0..=100.0).contains(&level) {
        return Err("音量要在 0~100 之间".into());
    }
    with_endpoint_volume(|v| unsafe {
        v.SetMasterVolumeLevelScalar(level as f32, std::ptr::null())
    })
}

#[cfg(not(windows))]
#[tauri::command]
pub fn set_volume(level: f64) -> Result<(), String> {
    let _ = level;
    Err("仅支持 Windows".into())
}

/// 静音开关:不传 muted = 切到相反状态;传了 = 设到目标状态(工具适配器用后者)
#[cfg(windows)]
#[tauri::command]
pub fn toggle_mute(muted: Option<bool>) -> Result<(), String> {
    with_endpoint_volume(|v| unsafe {
        let cur = v.GetMute()?.as_bool();
        let want = muted.unwrap_or(!cur);
        v.SetMute(want, std::ptr::null())
    })
}

#[cfg(not(windows))]
#[tauri::command]
pub fn toggle_mute(muted: Option<bool>) -> Result<(), String> {
    let _ = muted;
    Err("仅支持 Windows".into())
}

#[cfg(windows)]
fn with_endpoint_volume<T>(
    f: impl FnOnce(
        &windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume,
    ) -> windows::core::Result<T>,
) -> Result<T, String> {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eMultimedia, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    unsafe {
        // 线程池线程可能已初始化 COM,重复初始化返回的错误码忽略(与 audio_capture 同款)
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .map_err(|e| e.to_string())?;
        let endpoint: IAudioEndpointVolume = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| e.to_string())?;
        f(&endpoint).map_err(|e| e.to_string())
    }
}

/// 窗口管理:minimize_others(最小化其余全部)/ minimize_app / focus_app(按进程名)
#[tauri::command]
pub fn window_action(action: String, target: Option<String>) -> Result<(), String> {
    match action.as_str() {
        "minimize_others" => {
            if target.is_some() {
                return Err("minimize_others 不需要目标".into());
            }
            minimize_others()
        }
        "minimize_app" | "focus_app" => {
            let needle = target
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("需要目标程序名")?
                .to_lowercase();
            let needles = [needle.clone(), format!("{needle}.exe")];
            window_for_target(&needles, action == "focus_app")
        }
        other => Err(format!("未知窗口动作:{other}")),
    }
}

#[cfg(windows)]
fn minimize_others() -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_MINIMIZE};
    let self_pid = std::process::id();
    let wins = visible_top_windows();
    let mut n = 0;
    unsafe {
        for (hwnd, pid) in wins {
            if pid == self_pid {
                continue;
            }
            if ShowWindow(hwnd, SW_MINIMIZE).as_bool() {
                n += 1;
            }
        }
    }
    if n == 0 {
        Err("没有找到可最小化的其他窗口".into())
    } else {
        Ok(())
    }
}

/// 可见/未 cloaked/非工具窗的顶层窗口(系统壳窗口在 target 匹配时自然命中不了进程名,
/// 不必单列黑名单;minimize_others 靠"跳过自己 pid"保住角色自身)
#[cfg(windows)]
fn visible_top_windows() -> Vec<(windows::Win32::Foundation::HWND, u32)> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongW, GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE,
        WS_EX_TOOLWINDOW,
    };
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = unsafe { &mut *(lparam.0 as *mut Vec<(HWND, u32)>) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }
            let mut cloaked: u32 = 0;
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as _,
                std::mem::size_of::<u32>() as _,
            )
            .is_ok()
                && cloaked != 0
            {
                return BOOL(1);
            }
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
            if ex & WS_EX_TOOLWINDOW.0 as i32 != 0 {
                return BOOL(1);
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            out.push((hwnd, pid));
        }
        BOOL(1)
    }
    let mut out: Vec<(HWND, u32)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

#[cfg(windows)]
fn window_for_target(needles: &[String], focus: bool) -> Result<(), String> {
    use sysinfo::ProcessesToUpdate;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetForegroundWindow, ShowWindow, SW_MINIMIZE, SW_RESTORE,
    };
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    for (hwnd, pid) in visible_top_windows() {
        let Some(proc_ref) = sys.process(sysinfo::Pid::from_u32(pid)) else {
            continue;
        };
        let name = proc_ref.name().to_string_lossy().to_lowercase();
        if !needles
            .iter()
            .any(|n| name == *n || name.starts_with(&format!("{n}.exe")))
        {
            continue;
        }
        unsafe {
            if focus {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                // 尽力而为:非前台进程调 SetForegroundWindow 可能被系统拒绝(焦点防抢夺),
                // 恢复窗口本身已经达成"找回来"的主要目的
                let _ = SetForegroundWindow(hwnd);
            } else {
                let _ = ShowWindow(hwnd, SW_MINIMIZE);
            }
        }
        return Ok(());
    }
    Err(format!("没有找到匹配「{}」的窗口", needles[0]))
}

#[cfg(not(windows))]
fn minimize_others() -> Result<(), String> {
    Err("仅支持 Windows".into())
}

#[cfg(not(windows))]
fn window_for_target(_needles: &[String], _focus: bool) -> Result<(), String> {
    Err("仅支持 Windows".into())
}

/// 系统通知(toast)。角色气泡是应用内通知;全屏看视频时(安静陪伴闭麦的同一闸门)
/// 高优提醒改走系统 toast,不打断用户当前应用
#[tauri::command]
pub fn notify_send(
    app: tauri::AppHandle,
    title: Option<String>,
    body: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    // chars().take 按 Unicode 字符截断,不会劈开多字节字符
    let title = title.map(|t| t.chars().take(60).collect::<String>());
    let body: String = body.trim().chars().take(160).collect();
    if body.is_empty() {
        return Err("通知内容为空".into());
    }
    let mut builder = app.notification().builder();
    if let Some(t) = &title {
        builder = builder.title(t);
    }
    builder
        .body(&body)
        .show()
        .map_err(|e| format!("系统通知失败:{e}"))
}
