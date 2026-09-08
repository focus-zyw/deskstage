// 应用/系统声音捕获:WASAPI 环回,录为 PCM16 WAV,供音色克隆取参考音频。
// 进程环回(按 pid)需 Windows 10 2004+;系统环回 = 默认渲染设备 + Capture 方向(wasapi 自动加 LOOPBACK 标志)。
// 全部命令对前端暴露;录音线程每 200ms 检查停止标志,超 180s 自动停止。

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use std::collections::HashSet;

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use windows::Win32::Foundation::{HWND, LPARAM};use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible};
use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, SessionState};

#[derive(Serialize, Clone)]
pub struct AudioSessionInfo {
    pub pid: u32,
    pub name: String,
    /// 该进程此刻是否有活动声音会话(全量列表里用 🔊 标出)
    pub playing: bool,
}

#[derive(Default)]
pub struct CaptureState {
    job: Mutex<Option<CaptureJob>>,
}

struct CaptureJob {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<Result<PathBuf, String>>>,
}

/// 列出可选的录制目标:全部可见顶层窗口(标题+pid),标出此刻正在发声的。
/// 对齐 OBS"应用音频捕获"的体验——允许先选中还没播放声音的程序。
/// 枚举涉及 COM/全进程刷新,放阻塞线程池执行,避免卡住主事件循环(光标轮询会停摆)。
#[tauri::command]
pub async fn list_audio_sessions() -> Result<Vec<AudioSessionInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_audio_sessions_blocking)
        .await
        .map_err(|e| format!("任务调度失败:{e}"))?
}

fn list_audio_sessions_blocking() -> Result<Vec<AudioSessionInfo>, String> {
    // COM 已初始化(线程池线程常已带 MTA)时返回错误属正常,忽略;真失败会在后续 COM 调用处报出
    let _ = wasapi::initialize_mta();

    // 1. 正在发声的进程集合(WASAPI 活动会话)
    let mut playing_pids: HashSet<u32> = HashSet::new();
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| e.to_string())?;
    let manager = device.get_iaudiosessionmanager().map_err(|e| e.to_string())?;
    let sessions = manager.get_audiosessionenumerator().map_err(|e| e.to_string())?;
    let count = sessions.get_count().map_err(|e| e.to_string())?;
    for i in 0..count {
        let control = match sessions.get_session(i) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if control.get_state().unwrap_or(SessionState::Expired) == SessionState::Active {
            if let Ok(pid) = control.get_process_id() {
                playing_pids.insert(pid);
            }
        }
    }

    // 2. 枚举可见顶层窗口(标题 + pid)
    let mut wins: Vec<(u32, String)> = Vec::new();
    let lparam = LPARAM(&mut wins as *mut _ as isize);
    unsafe {
        EnumWindows(Some(collect_window), lparam).map_err(|e| e.to_string())?;
    }

    // 3. 按进程名去重(多窗口留一条),剔除系统组件;展示标题取第一个窗口
    //    代表 pid:该名下正在发声的窗口进程优先(环回含子进程树,能抓到浏览器的音频子进程)
    const SYSTEM_UI: &[&str] = &[
        "explorer.exe", "searchhost.exe", "startmenuexperiencehost.exe", "shellexperiencehost.exe",
        "applicationframehost.exe", "textinputhost.exe", "runtimebroker.exe", "lockapp.exe",
        "widgets.exe", "widgetservice.exe", "msedgewebview2.exe", "systemsettings.exe",
        "securityhealthsystray.exe", "securityhealthservice.exe", "sihost.exe", "ctfmon.exe",
        "svchost.exe", "csrss.exe", "dwm.exe", "winlogon.exe", "wininit.exe", "services.exe",
        "lsass.exe", "smss.exe", "fontdrvhost.exe", "dllhost.exe", "taskhostw.exe",
        "conhost.exe", "openconsole.exe", "audiodg.exe", "cmd.exe", "powershell.exe",
        "windows_terminal.exe", "werfault.exe", "wermgr.exe",
    ];

    let mut sys = sysinfo::System::new();
    // 只刷进程表,不要 new_all() 的磁盘/网络全量采集(枚举每次聚焦下拉都会跑)
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let self_pid = std::process::id();
    // key(进程名小写) -> (展示标题, 代表 pid, playing)
    let mut by_name: std::collections::HashMap<String, (String, u32, bool)> = std::collections::HashMap::new();
    for (pid, title) in wins {
        if pid == self_pid {
            continue;
        }
        let Some(proc_ref) = sys.process(sysinfo::Pid::from_u32(pid)) else {
            continue;
        };
        let proc_name = proc_ref.name().to_string_lossy().to_string();
        let key = proc_name.to_lowercase();
        if SYSTEM_UI.contains(&key.as_str()) || key.is_empty() {
            continue;
        }
        let playing = playing_pids.contains(&pid);
        let entry = by_name.entry(key).or_insert((String::new(), pid, false));
        if entry.0.is_empty() && !title.is_empty() {
            entry.0 = title;
        }
        if playing {
            entry.1 = pid; // 正在发声的窗口进程作为捕获目标
            entry.2 = true;
        }
    }

    let mut out: Vec<AudioSessionInfo> = by_name
        .into_iter()
        .map(|(key, (title, pid, playing))| {
            let name = if title.is_empty() { key } else { title };
            AudioSessionInfo { pid, name, playing }
        })
        .collect();
    out.sort_by(|a, b| b.playing.cmp(&a.playing).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// EnumWindows 回调:过滤可见/非 cloaked/有标题的顶层窗口,收集 (pid, 标题)
unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    let wins = &mut *(lparam.0 as *mut Vec<(u32, String)>);
    if !IsWindowVisible(hwnd).as_bool() {
        return windows::core::BOOL(1);
    }
    if GetWindowTextLengthW(hwnd) == 0 {
        return windows::core::BOOL(1);
    }
    let mut cloaked: u32 = 0;
    if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as _, std::mem::size_of::<u32>() as _).is_ok()
        && cloaked != 0
    {
        return windows::core::BOOL(1);
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let n = GetWindowTextLengthW(hwnd).min(120) as usize;
    let mut buf = [0u16; 128];
    GetWindowTextW(hwnd, &mut buf);
    wins.push((pid, String::from_utf16_lossy(&buf[..n])));
    windows::core::BOOL(1)
}

/// 开始录音:pid 传 Some 为按进程环回,None 为整个系统。返回确认。
/// 录音线程无论正常/异常结束都会向前端发 `capture-ended` 事件
/// (含 auto 标记:是否为 180s 上限自动停止),前端据此复位 UI 并取回文件。
#[tauri::command]
pub fn start_capture(
    pid: Option<u32>,
    app: tauri::AppHandle,
    state: State<CaptureState>,
) -> Result<String, String> {
    let mut guard = state.job.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("已有录音在进行".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("data")
        .join("voice-captures");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = dir.join(format!("capture_{ts}.wav"));

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let auto = Arc::new(AtomicBool::new(false));
    let auto_thread = auto.clone();
    let app_thread = app.clone();
    let handle = std::thread::spawn(move || {
        let result = capture_thread(stop_thread, auto_thread.clone(), path, pid);
        let payload = match &result {
            Ok(p) => serde_json::json!({
                "ok": true,
                "path": p.to_string_lossy(),
                "auto": auto_thread.load(Ordering::SeqCst),
            }),
            Err(e) => serde_json::json!({ "ok": false, "error": e, "auto": false }),
        };
        let _ = app_thread.emit("capture-ended", payload);
        result
    });
    *guard = Some(CaptureJob {
        stop,
        handle: Some(handle),
    });
    Ok("recording".into())
}

/// 停止录音,回填 WAV 头,返回文件绝对路径。
/// join 阻塞最长 ~200ms,放阻塞线程池,不卡命令线程。
#[tauri::command]
pub async fn stop_capture(state: tauri::State<'_, CaptureState>) -> Result<String, String> {
    let handle = {
        let mut guard = state.job.lock().map_err(|e| e.to_string())?;
        let job = guard.take().ok_or("没有进行中的录音")?;
        job.stop.store(true, Ordering::SeqCst);
        job.handle.ok_or("录音句柄丢失")? // start_capture 恒置 Some,此守卫仅为免 panic
    };
    let path = tauri::async_runtime::spawn_blocking(move || {
        handle.join().map_err(|_| "录音线程崩溃".to_string())
    })
    .await
    .map_err(|e| format!("任务调度失败:{e}"))??;
    Ok(path?.to_string_lossy().into_owned())
}

fn capture_thread(
    stop: Arc<AtomicBool>,
    auto: Arc<AtomicBool>,
    path: PathBuf,
    pid: Option<u32>,
) -> Result<PathBuf, String> {
    let _ = wasapi::initialize_mta();
    // 捕获格式:f32 48k 立体声(autoconvert 由 WASAPI 负责重采样),落盘转 PCM16
    let format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);
    let mut client = match pid {
        Some(pid) => AudioClient::new_application_loopback_client(pid, true)
            .map_err(|e| format!("打不开该程序的声音(可能没在播放):{e}"))?,
        None => {
            let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
            let device = enumerator
                .get_default_device(&Direction::Render)
                .map_err(|e| e.to_string())?;
            device.get_iaudioclient().map_err(|e| e.to_string())?
        }
    };
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };
    client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|e| e.to_string())?;
    let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    client.start_stream().map_err(|e| e.to_string())?;

    let mut file = File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(&wav_header(0)).map_err(|e| e.to_string())?;
    let mut written: u32 = 0;

    let started = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if started.elapsed() > Duration::from_secs(180) {
            auto.store(true, Ordering::SeqCst); // 触达上限自动停,前端据此取回文件并复位
            break;
        }
        let frames = capture
            .get_next_packet_size()
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        if frames > 0 {
            let mut queue = std::collections::VecDeque::new();
            capture
                .read_from_device_to_deque(&mut queue)
                .map_err(|e| e.to_string())?;
            let raw: Vec<u8> = queue.into_iter().collect();
            let converted = f32_stereo_to_i16(&raw);
            written += converted.len() as u32;
            file.write_all(&converted).map_err(|e| e.to_string())?;
        }
        // 等事件;静默期没有事件时超时属正常,继续轮询停止标志
        let _ = event.wait_for_event(200);
    }
    client.stop_stream().map_err(|e| e.to_string())?;

    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    file.write_all(&wav_header(written)).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    Ok(path)
}

/// f32 交错立体声 → i16 交错(克隆接口吃标准 PCM16)
fn f32_stereo_to_i16(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len() / 2);
    for chunk in src.chunks_exact(4) {
        let s = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// 44 字节标准 WAV 头(PCM16 双声道 48kHz)
fn wav_header(data_len: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes());
    h[22..24].copy_from_slice(&2u16.to_le_bytes());
    h[24..28].copy_from_slice(&48000u32.to_le_bytes());
    h[28..32].copy_from_slice(&192_000u32.to_le_bytes());
    h[32..34].copy_from_slice(&4u16.to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}
