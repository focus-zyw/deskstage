use mouse_position::mouse_position::Mouse;
use std::thread;
use std::time::Duration;
use tauri::Emitter;

mod asr;
mod audio_capture;
mod bili_http;
mod capture;
mod config_service;
mod endpoint_proxy;
mod env;
mod mic_capture;
mod ocr;
mod pointer_hook;
mod secrets;
mod video_save;
mod webchat;

// 光标轮询线程：以约 80Hz 读取全局光标位置，位置变化时推送给前端。
// 为什么轮询而不监听窗口鼠标事件：窗口开启鼠标穿透后收不到任何鼠标事件，
// 只能从系统层面取光标坐标，由前端换算到窗口内做命中判断。
fn spawn_cursor_poll(handle: tauri::AppHandle) {
    thread::spawn(move || {
        let mut last = (i32::MIN, i32::MIN);
        loop {
            if let Mouse::Position { x, y } = Mouse::get_mouse_position() {
                if (x, y) != last {
                    last = (x, y);
                    // payload 为 [x, y]，单位：屏幕物理像素
                    let _ = handle.emit("cursor-pos", (x, y));
                }
            }
            thread::sleep(Duration::from_millis(12));
        }
    });
}

// 看视频不被打扰:窗口默认 WS_EX_NOACTIVATE(点击不抢焦点,播放器不会因失焦暂停),
// 需要键盘输入的设置面板打开时临时关闭,关闭面板后恢复。
#[tauri::command]
fn set_noactivate(window: tauri::WebviewWindow, enable: bool) {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
            fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
        }
        const GWL_EXSTYLE: i32 = -20;
        const WS_EX_NOACTIVATE: isize = 0x0800_0000;
        if let Ok(hwnd) = window.hwnd() {
            let handle = hwnd.0 as isize;
            unsafe {
                let style = GetWindowLongPtrW(handle, GWL_EXSTYLE);
                let style = if enable {
                    style | WS_EX_NOACTIVATE
                } else {
                    style & !WS_EX_NOACTIVATE
                };
                SetWindowLongPtrW(handle, GWL_EXSTYLE, style);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (window, enable);
}

// 置顶看门狗:TOPMOST 位偶尔会被系统弄丢(休眠唤醒/分辨率切换/隐藏再显示/DWM 重排),
// 丢失后普通窗口就能盖住角色,而窗口免激活(WS_EX_NOACTIVATE)无法靠点击拉回,
// 只能被动被埋。低频巡检:TOPMOST 位还在时不动作(不压便签/PiP 等其他置顶工具的层序),
// 发现丢了才重新 SetWindowPos 拉回最上层(带 NOACTIVATE,不抢焦点)。
fn spawn_topmost_watchdog(handle: tauri::AppHandle) {
    #[cfg(windows)]
    thread::spawn(move || {
        use tauri::Manager;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
            SWP_NOSIZE, WS_EX_TOPMOST,
        };
        loop {
            thread::sleep(Duration::from_secs(3));
            let Some(win) = handle.get_webview_window("main") else {
                continue;
            };
            let Ok(hwnd) = win.hwnd() else {
                continue;
            };
            unsafe {
                let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                if ex & WS_EX_TOPMOST.0 as isize == 0 {
                    let _ = SetWindowPos(
                        hwnd,
                        Some(HWND_TOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
            }
        }
    });
    #[cfg(not(windows))]
    let _ = handle;
}

// CSP 违规上报(前端 cspMonitor 转发):CSP 收紧后靠这条通路在 dev 终端
// 立即看到被拦的资源,防"人工开页面漏掉延迟任务/回退路径"
#[tauri::command]
fn report_csp_violation(directive: String, blocked: String, source: String) {
    log::warn!("CSP 违规: directive={directive} blocked={blocked} source={source}");
}

// 整进程退出:设置窗是常驻第二 WebView,任何窗口单独 close() 都会让应用
// 变成"角色消失但进程还在"的孤儿态(真实事故);退出必须走这里
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例:双开会导致两个全屏穿透覆盖层 + 两份前端并发写同一批 json(内存锁互不可见)。
        // 二次启动时窗口常驻穿透、无从唤起,仅作静默退出
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        // 开机自启动:Windows 走 HKCU Run 注册表键;开关状态由前端按配置同步(默认关)
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(audio_capture::CaptureState::default())
        .manage(webchat::AskState::default())
        .manage(endpoint_proxy::ProxyState::default())
        .manage(mic_capture::MicState::default())
        .manage(config_service::ConfigState::default())
        .invoke_handler(tauri::generate_handler![
            set_noactivate,
            report_csp_violation,
            exit_app,
            pointer_hook::set_native_pointer_regions,
            audio_capture::list_audio_sessions,
            audio_capture::start_capture,
            audio_capture::stop_capture,
            mic_capture::list_mic_devices,
            mic_capture::mic_start,
            mic_capture::mic_stop,
            asr::asr_transcribe,
            capture::capture_screen,
            capture::capture_finish,
            capture::capture_save,
            capture::capture_cleanup,
            capture::set_capture_excluded,
            env::env_snapshot,
            webchat::webchat_ask,
            webchat::webchat_cancel,
            webchat::webchat_login,
            webchat::webchat_probe,
            webchat::webchat_main_visible,
            webchat::webchat_last_trace,
            ocr::ocr_clipboard,
            ocr::clipboard_image_base64,
            video_save::video_save_from_url,
            video_save::reveal_in_explorer,
            bili_http::bili_http_request,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            secrets::secrets_migrate_if_needed,
            config_service::config_get,
            config_service::config_set,
            config_service::data_get,
            config_service::data_set,
            config_service::data_get_with_revision,
            config_service::data_set_if_revision,
            endpoint_proxy::endpoint_request,
            endpoint_proxy::endpoint_cancel
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            spawn_cursor_poll(app.handle().clone());
            pointer_hook::spawn(app.handle().clone());
            spawn_topmost_watchdog(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // 退出时清掉专用 profile 的后台调试 Edge(线程里跑:powershell 枚举约 1s,别拖住退出)
            if let tauri::RunEvent::Exit = event {
                std::thread::spawn(webchat::kill_profile_edge);
            }
        });
}
