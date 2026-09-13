// 麦克风采集:WASAPI 共享模式 Capture 方向,裸 PCM 经 Channel 流式推给前端。
//
// 为什么走 Rust 而不是 webview getUserMedia:WebView2 的媒体权限弹窗不可预授权、
// 拒绝后难恢复(tauri#14753/#5042),对本应用 WS_EX_NOACTIVATE 免激活形态不可接受;
// wasapi 已在依赖中,采集线程范式照 audio_capture.rs。
//
// 格式:系统 SRC 直出 16k/mono/i16(StreamMode::EventsShared{autoconvert} 让 audiodg
// 做重采样,不自研滤波器)。分帧(480样本/30ms)与 pre-roll 在前端 mic.ts/vad.ts 做,
// Rust 只保证字节流连续不丢。
//
// 所有权:单实例 + owner 仲裁——主窗语音会话可抢占设置窗的电平预览,反之拒绝;
// 同 owner 重入 = 换设备重启。Channel 断开(设置窗关闭/主窗重载)或设备失效
// (拔出/休眠/隐私开关)→ 线程自停并 emit('mic-ended',{owner,reason}),前端据此复位。
//
// 隐私:只进内存不落盘(ASR 的 wav 由前端临时构造,请求后即弃)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Emitter, State};
use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

/// 语音闭环统一采样率:VAD 分帧(480 样本 = 30ms)与云端 ASR 都吃 16k
pub const MIC_SAMPLE_RATE: usize = 16000;

#[derive(Serialize, Clone)]
pub struct MicDeviceInfo {
    pub id: String,
    pub name: String,
    pub default: bool,
}

/// 采集租约归属
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Owner {
    VoiceSession,
    SettingsPreview,
}

impl Owner {
    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "voice-session" => Ok(Self::VoiceSession),
            "settings-preview" => Ok(Self::SettingsPreview),
            other => Err(format!("未知的采集归属: {other}")),
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::VoiceSession => "voice-session",
            Self::SettingsPreview => "settings-preview",
        }
    }
}

struct MicJob {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
    owner: Owner,
}

#[derive(Default)]
pub struct MicState {
    job: Mutex<Option<MicJob>>,
}

/// 租约仲裁:voice-session 用途优先,可抢预览;预览撞会话 = 拒绝;
/// 同 owner 重入(换设备/换参数重启)放行。
fn admit(incoming: Owner, current: Option<Owner>) -> Result<(), String> {
    if current == Some(Owner::VoiceSession) && incoming == Owner::SettingsPreview {
        return Err("语音对话正在使用麦克风,预览暂不可用".into());
    }
    Ok(())
}

/// 列出可用麦克风(Capture 方向活动设备),标出系统默认。COM 枚举放阻塞线程池,
/// 避免卡住主事件循环(光标轮询会停摆)。
#[tauri::command]
pub async fn list_mic_devices() -> Result<Vec<MicDeviceInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _ = wasapi::initialize_mta();
        let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
        let default_id = enumerator
            .get_default_device(&Direction::Capture)
            .ok()
            .and_then(|d| d.get_id().ok())
            .unwrap_or_default();
        let collection = enumerator
            .get_device_collection(&Direction::Capture)
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for i in 0..collection.get_nbr_devices().map_err(|e| e.to_string())? {
            if let Ok(dev) = collection.get_device_at_index(i) {
                let id = dev.get_id().unwrap_or_default();
                if id.is_empty() {
                    continue;
                }
                let name = dev.get_friendlyname().unwrap_or_else(|_| "未知设备".into());
                out.push(MicDeviceInfo {
                    default: id == default_id,
                    id,
                    name,
                });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("任务调度失败:{e}"))?
}

/// 开始采集。owner 声明租约归属;device_id 缺省 = 系统默认麦克风。
/// 正常 mic_stop 不发事件(调用方自己知道);异常结束(设备失效/通道关闭)才
/// emit('mic-ended',{owner,reason})。返回确认字符串。
#[tauri::command]
pub fn mic_start(
    owner: String,
    device_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, MicState>,
    on_chunk: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let owner = Owner::parse(&owner)?;
    let mut guard = state.job.lock().map_err(|e| e.to_string())?;
    admit(owner, guard.as_ref().map(|j| j.owner))?;
    // 让位:旧线程拿到停止标志自行收尾;句柄后台 join,不阻塞命令
    if let Some(old) = guard.take() {
        old.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = old.handle {
            std::thread::spawn(move || {
                let _ = handle.join();
            });
        }
    }
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let app_thread = app.clone();
    let handle = std::thread::spawn(move || {
        let reason = capture_loop(&stop_thread, device_id.as_deref(), &on_chunk).err();
        // 只有异常结束才需要叫醒前端;reason = None 即 mic_stop 正常停
        if let Some(reason) = reason {
            let _ = app_thread.emit(
                "mic-ended",
                serde_json::json!({ "owner": owner.as_str(), "reason": reason }),
            );
        }
    });
    *guard = Some(MicJob {
        stop,
        handle: Some(handle),
        owner,
    });
    Ok("capturing".into())
}

/// 停止采集(幂等语义:没有进行中的采集也返回 Ok,方便前端复位路径统一调用)。
#[tauri::command]
pub async fn mic_stop(state: State<'_, MicState>) -> Result<(), String> {
    let handle = {
        let mut guard = state.job.lock().map_err(|e| e.to_string())?;
        match guard.take() {
            None => return Ok(()),
            Some(job) => {
                job.stop.store(true, Ordering::SeqCst);
                job.handle
            }
        }
    };
    if let Some(handle) = handle {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = handle.join();
        })
        .await
        .map_err(|e| format!("任务调度失败:{e}"))?;
    }
    Ok(())
}

/// 采集线程主体:事件驱动,Err = 异常结束原因
fn capture_loop(
    stop: &AtomicBool,
    device_id: Option<&str>,
    channel: &Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let _ = wasapi::initialize_mta();
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = match device_id {
        Some(id) => find_device(&enumerator, id)?,
        None => enumerator
            .get_default_device(&Direction::Capture)
            .map_err(|e| format!("打不开默认麦克风(检查系统隐私开关):{e}"))?,
    };
    let mut client = device.get_iaudioclient().map_err(|e| e.to_string())?;
    let format = WaveFormat::new(16, 16, &SampleType::Int, MIC_SAMPLE_RATE, 1, None);
    client
        .initialize_client(
            &format,
            &Direction::Capture,
            &StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: 0,
            },
        )
        .map_err(|e| format!("初始化麦克风失败:{e}"))?;
    let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    client.start_stream().map_err(|e| e.to_string())?;

    let result = loop {
        if stop.load(Ordering::SeqCst) {
            break Ok(());
        }
        match capture.get_next_packet_size() {
            Ok(Some(frames)) if frames > 0 => {
                let mut queue = std::collections::VecDeque::new();
                if let Err(e) = capture.read_from_device_to_deque(&mut queue) {
                    break Err(format!("读取麦克风数据失败:{e}"));
                }
                let raw: Vec<u8> = queue.into_iter().collect();
                if raw.is_empty() {
                    continue;
                }
                // 通道断开 = 无人消费,自停回收(设置窗关闭/主窗重载)
                if channel.send(InvokeResponseBody::Raw(raw)).is_err() {
                    break Err("通道已关闭".into());
                }
            }
            Ok(_) => {}
            Err(e) => break Err(format!("麦克风事件失败:{e}")),
        }
        // 静默期无事件属正常,超时后回查停止标志
        let _ = event.wait_for_event(200);
    };
    let _ = client.stop_stream();
    result
}

fn find_device(enumerator: &DeviceEnumerator, id: &str) -> Result<wasapi::Device, String> {
    let collection = enumerator
        .get_device_collection(&Direction::Capture)
        .map_err(|e| e.to_string())?;
    for i in 0..collection.get_nbr_devices().map_err(|e| e.to_string())? {
        if let Ok(dev) = collection.get_device_at_index(i) {
            if dev.get_id().map_err(|e| e.to_string())? == id {
                return Ok(dev);
            }
        }
    }
    Err("找不到指定的麦克风设备".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_arbitration_gives_voice_session_priority() {
        // 空闲:谁都能拿
        assert!(admit(Owner::VoiceSession, None).is_ok());
        assert!(admit(Owner::SettingsPreview, None).is_ok());
        // 会话持有:预览被拒
        assert!(admit(Owner::SettingsPreview, Some(Owner::VoiceSession)).is_err());
        // 会话持有:会话重入(换设备)放行
        assert!(admit(Owner::VoiceSession, Some(Owner::VoiceSession)).is_ok());
        // 预览持有:双方都放行(会话抢占/预览重启)
        assert!(admit(Owner::VoiceSession, Some(Owner::SettingsPreview)).is_ok());
        assert!(admit(Owner::SettingsPreview, Some(Owner::SettingsPreview)).is_ok());
        // 非法归属名
        assert!(Owner::parse("hacker").is_err());
        assert_eq!(Owner::parse("voice-session").unwrap(), Owner::VoiceSession);
    }
}
