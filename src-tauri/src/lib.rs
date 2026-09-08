use std::thread;
use std::time::Duration;
use mouse_position::mouse_position::Mouse;
use tauri::Emitter;

mod audio_capture;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .manage(audio_capture::CaptureState::default())
    .invoke_handler(tauri::generate_handler![
      set_noactivate,
      audio_capture::list_audio_sessions,
      audio_capture::start_capture,
      audio_capture::stop_capture
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
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
