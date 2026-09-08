// 应用/系统声音捕获:WASAPI 环回,录为 PCM16 WAV,供音色克隆取参考音频。
// 进程环回(按 pid)需 Windows 10 2004+;系统环回 = 默认渲染设备 + Capture 方向(wasapi 自动加 LOOPBACK 标志)。
// 全部命令对前端暴露;录音线程每 200ms 检查停止标志,超 120s 自动停止。

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{Manager, State};
use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, SessionState};

#[derive(Serialize, Clone)]
pub struct AudioSessionInfo {
    pub pid: u32,
    pub name: String,
}

#[derive(Default)]
pub struct CaptureState {
    job: Mutex<Option<CaptureJob>>,
}

struct CaptureJob {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<Result<PathBuf, String>>>,
}

/// 列出当前正在发声的程序(WASAPI 活动会话,pid + 进程名)
#[tauri::command]
pub fn list_audio_sessions() -> Result<Vec<AudioSessionInfo>, String> {
    wasapi::initialize_mta().ok();
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| e.to_string())?;
    let manager = device.get_iaudiosessionmanager().map_err(|e| e.to_string())?;
    let sessions = manager.get_audiosessionenumerator().map_err(|e| e.to_string())?;

    let sys = sysinfo::System::new_all();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let count = sessions.get_count().map_err(|e| e.to_string())?;
    for i in 0..count {
        let control = match sessions.get_session(i) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if control.get_state().unwrap_or(SessionState::Expired)
            != SessionState::Active
        {
            continue;
        }
        let pid = match control.get_process_id() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !seen.insert(pid) {
            continue;
        }
        let name = sys
            .process(sysinfo::Pid::from_u32(pid))
            .map(|pr| pr.name().to_string_lossy().to_string())
            .unwrap_or_else(|| format!("进程 {pid}"));
        out.push(AudioSessionInfo { pid, name });
    }
    Ok(out)
}

/// 开始录音:pid 传 Some 为按进程环回,None 为整个系统。返回确认。
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
    let handle = std::thread::spawn(move || capture_thread(stop_thread, path, pid));
    *guard = Some(CaptureJob {
        stop,
        handle: Some(handle),
    });
    Ok("recording".into())
}

/// 停止录音,回填 WAV 头,返回文件绝对路径
#[tauri::command]
pub fn stop_capture(state: State<CaptureState>) -> Result<String, String> {
    let mut guard = state.job.lock().map_err(|e| e.to_string())?;
    let job = guard.take().ok_or("没有进行中的录音")?;
    job.stop.store(true, Ordering::SeqCst);
    let path = job
        .handle
        .expect("job 存在则 handle 存在")
        .join()
        .map_err(|_| "录音线程崩溃".to_string())??;
    Ok(path.to_string_lossy().into_owned())
}

fn capture_thread(stop: Arc<AtomicBool>, path: PathBuf, pid: Option<u32>) -> Result<PathBuf, String> {
    wasapi::initialize_mta().ok();
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
        if stop.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(120) {
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
