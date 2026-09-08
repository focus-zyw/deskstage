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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .manage(audio_capture::CaptureState::default())
    .invoke_handler(tauri::generate_handler![
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
