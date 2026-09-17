use mouse_position::mouse_position::Mouse;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::Emitter;

mod asr;
mod audio_capture;
mod bili_http;
mod bridge;
mod capture;
mod config_service;
mod desktop_ops;
mod endpoint_proxy;
mod env;
mod local_asr;
mod local_embed_server;
mod mic_capture;
mod ocr;
mod pointer_hook;
mod secrets;
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
        .plugin(tauri_plugin_notification::init())
        .manage(audio_capture::CaptureState::default())
        .manage(Arc::new(webchat::WebchatHub::new(Arc::new(
            webchat::RealCdpOps::default(),
        ))))
        .manage(endpoint_proxy::ProxyState::default())
        .manage(mic_capture::MicState::default())
        .manage(config_service::ConfigState::default())
        // 影子大脑桥:release 下命令壳返回错误、监听器不存在(见 bridge.rs 模块注释)
        .manage(bridge::BridgeState::default())
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
            asr::asr_test_connection,
            capture::capture_screen,
            capture::capture_finish,
            capture::capture_save,
            capture::capture_cleanup,
            capture::set_capture_excluded,
            env::env_snapshot,
            webchat::webchat_ask,
            webchat::webchat_ask_conversation,
            webchat::webchat_release_conversation,
            webchat::webchat_cancel,
            webchat::webchat_login,
            webchat::webchat_probe,
            webchat::webchat_main_visible,
            webchat::webchat_take_trace,
            webchat::webchat_site_status,
            webchat::webchat_site_mode,
            webchat::webchat_site_reevaluate,
            ocr::ocr_clipboard,
            ocr::clipboard_image_base64,
            desktop_ops::desktop_files_list,
            desktop_ops::clipboard_read_text,
            desktop_ops::system_open,
            desktop_ops::system_run_app,
            desktop_ops::media_control,
            desktop_ops::set_volume,
            desktop_ops::toggle_mute,
            desktop_ops::window_action,
            desktop_ops::notify_send,
            local_asr::local_asr_status,
            local_asr::local_asr_download,
            local_asr::asr_transcribe_local,
            local_embed_server::local_embed_status,
            local_embed_server::local_embed_start,
            local_embed_server::local_embed_stop,
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
            endpoint_proxy::endpoint_cancel,
            bridge::bridge_start,
            bridge::bridge_stop,
            bridge::bridge_push_input,
            bridge::bridge_offer_request,
            bridge::bridge_speak_reply,
            bridge::bridge_status
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
            // 本地嵌入服务自拉起:冷记忆选了本地 llama.cpp 且托管模式为随应用启动(boot)
            // 才动手;异步进行不阻塞启动,失败只记日志(fail-open,经历记忆停用)
            tauri::async_runtime::spawn(local_embed_server::auto_start_if_configured(
                app.handle().clone(),
            ));
            // 会话闲置清扫兜底:定时关闭超时未用的网页会话标签页(正常路径由
            // webchat_release_conversation 关闭;这里只兜崩溃/中断残留)
            {
                use tauri::Manager;
                let hub = app.state::<Arc<webchat::WebchatHub>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_secs(webchat::HUB_SWEEP_SECS)).await;
                        hub.sweep_idle().await;
                    }
                });
            }
            // 线程记忆落盘:载入上次「会话键→站点线程URL」映射。App 重启清空进程
            // 内存,但 Edge 与站点侧线程都还在——不载入的话,重启后的第一条续聊会
            // 认领到入口残留页开新线程(豆包"续聊新建标签页"的顽固路径)
            {
                use tauri::Manager;
                let hub = app.state::<Arc<webchat::WebchatHub>>().inner().clone();
                let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
                tauri::async_runtime::block_on(
                    hub.load_thread_store(dir.join("webchat-threads.json")),
                );
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // 退出时清掉专用 profile 的后台调试 Edge(线程里跑:powershell 枚举约 1s,别拖住退出)
            if let tauri::RunEvent::Exit = event {
                // 托管的本地嵌入 llama-server 随应用退出(同步 kill,很快)
                local_embed_server::shutdown();
                std::thread::spawn(webchat::kill_profile_edge);
            }
        });
}
