// 本地离线语音识别:sherpa-onnx(SenseVoiceSmall int8 ONNX)进程内推理。
//
// 为什么:2026-09 实测云端(硅基流动免费 SenseVoiceSmall)推理要 30-40s/条,且存在
// 慢节点挂起与静音判 500 的服务端变更(见 asr.rs 文件头)。本地化后:短音频亚秒级、
// 完全离线、无配额,语音不出门。
//
// 模型文件(首次使用时下载一次,缓存在 appdata/models/sensevoice/):
//   model.int8.onnx(228MB)+ tokens.txt(308KB)
// 下载源按序尝试:hf-mirror.com(国内可达)→ huggingface.co(海外)。
// 识别器为进程内单例(onnx 会话首次加载 1-3s,常驻);推理是 CPU 纯计算,
// 全部放 spawn_blocking,不卡主事件循环的光标轮询。

use base64::Engine;
use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

const MODEL_DIR_NAME: &str = "sensevoice";
const MODEL_FILE: &str = "model.int8.onnx";
const TOKENS_FILE: &str = "tokens.txt";
/// 模型最小体积(字节):低于此视为下载不完整
const MODEL_MIN_BYTES: u64 = 100 * 1024 * 1024;
/// 下载源按序尝试:镜像(国内可达)→ 主站(海外)
const SOURCES: &[&str] = &["https://hf-mirror.com", "https://huggingface.co"];
const REPO: &str = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
/// 模型文件语义校验:tokens 首行必含此 token
const TOKENS_SENTINEL: &str = "<unk>";

fn model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models")
        .join(MODEL_DIR_NAME))
}

fn file_bytes(p: &PathBuf) -> Option<u64> {
    std::fs::metadata(p).ok().map(|m| m.len())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalAsrStatus {
    /// 模型目录(设置页展示用)
    pub model_dir: String,
    pub model_ready: bool,
    pub tokens_ready: bool,
    /// 三者齐备 = 本地识别可用
    pub ready: bool,
    pub downloading: bool,
    /// 当前下载进度(正在下载时才有值):0~1
    pub progress: Option<f32>,
    /// 正在下载的文件名
    pub downloading_file: Option<String>,
}

static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static PROGRESS: OnceLock<Mutex<(Option<f32>, Option<String>)>> = OnceLock::new();

fn progress_cell() -> &'static Mutex<(Option<f32>, Option<String>)> {
    PROGRESS.get_or_init(|| Mutex::new((None, None)))
}

#[tauri::command]
pub fn local_asr_status(app: tauri::AppHandle) -> Result<LocalAsrStatus, String> {
    let dir = model_dir(&app)?;
    let model = file_bytes(&dir.join(MODEL_FILE)).unwrap_or(0);
    let tokens = file_bytes(&dir.join(TOKENS_FILE)).unwrap_or(0);
    let (progress, downloading_file) = {
        let guard = progress_cell().lock().map_err(|e| e.to_string())?;
        (guard.0, guard.1.clone())
    };
    Ok(LocalAsrStatus {
        model_dir: dir.to_string_lossy().into_owned(),
        model_ready: model >= MODEL_MIN_BYTES,
        tokens_ready: tokens > 1024,
        ready: model >= MODEL_MIN_BYTES && tokens > 1024,
        downloading: DOWNLOADING.load(Ordering::SeqCst),
        progress,
        downloading_file,
    })
}

/// 下载本地模型(两文件,镜像优先)。并发调用去重;进度经 `local-asr-progress`
/// 事件广播 {file, received, total},完成以 local_asr_status().ready 为准。
#[tauri::command]
pub async fn local_asr_download(app: tauri::AppHandle) -> Result<(), String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("已有下载在进行".into());
    }
    let result = download_models(app).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    {
        let mut guard = progress_cell().lock().map_err(|e| e.to_string())?;
        *guard = (None, None);
    }
    result
}

async fn download_models(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    let dir = model_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建模型目录失败:{e}"))?;
    let files = [(TOKENS_FILE, 1024u64), (MODEL_FILE, MODEL_MIN_BYTES)];
    for (name, min_bytes) in files {
        let target = dir.join(name);
        if file_bytes(&target).unwrap_or(0) >= min_bytes {
            continue;
        }
        download_one(&app, &dir, name, min_bytes).await?;
        let _ = app.emit(
            "local-asr-progress",
            serde_json::json!({ "file": name, "done": true }),
        );
    }
    Ok(())
}

async fn download_one(
    app: &tauri::AppHandle,
    dir: &PathBuf,
    name: &str,
    min_bytes: u64,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;
    let mut last_err = String::new();
    for src in SOURCES {
        let url = format!("{src}/{REPO}/resolve/main/{name}");
        let resp = match reqwest::get(&url).await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                last_err = format!("{src} -> HTTP {}", r.status());
                continue;
            }
            Err(e) => {
                last_err = format!("{src} -> {e}");
                continue;
            }
        };
        let total = resp.content_length().unwrap_or(0);
        let tmp = dir.join(format!("{name}.part"));
        let file = std::fs::File::create(&tmp).map_err(|e| format!("写文件失败:{e}"))?;
        let mut writer = std::io::BufWriter::new(file);
        let mut stream = resp.bytes_stream();
        let mut received: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        loop {
            match stream.next().await {
                Some(Ok(chunk)) => {
                    use std::io::Write;
                    if let Err(e) = writer.write_all(&chunk) {
                        let _ = std::fs::remove_file(&tmp);
                        return Err(format!("写文件失败:{e}"));
                    }
                    received += chunk.len() as u64;
                    // 进度节流:每 500ms 广播一次,不刷屏
                    if last_emit.elapsed().as_millis() >= 500 {
                        last_emit = std::time::Instant::now();
                        let frac = if total > 0 {
                            Some(received as f32 / total as f32)
                        } else {
                            None
                        };
                        if let Ok(mut guard) = progress_cell().lock() {
                            *guard = (frac, Some(name.into()));
                        }
                        let _ = app.emit(
                            "local-asr-progress",
                            serde_json::json!({ "file": name, "received": received, "total": total }),
                        );
                    }
                }
                Some(Err(e)) => {
                    let _ = std::fs::remove_file(&tmp);
                    last_err = format!("{src} -> 下载中断:{e}");
                    break;
                }
                None => {
                    use std::io::Write;
                    let _ = writer.flush();
                    if received >= min_bytes {
                        let final_path = dir.join(name);
                        std::fs::rename(&tmp, &final_path).map_err(|e| format!("改名失败:{e}"))?;
                        return Ok(());
                    }
                    let _ = std::fs::remove_file(&tmp);
                    last_err = format!("{src} -> 下载不完整({received} 字节)");
                    break;
                }
            }
        }
    }
    Err(format!("所有下载源均失败,最后一个错误:{last_err}"))
}

// ---------- 推理 ----------

struct LocalRecognizer {
    inner: Mutex<sherpa_rs::sense_voice::SenseVoiceRecognizer>,
}

fn recognizer(app: &tauri::AppHandle) -> Result<&'static LocalRecognizer, String> {
    static RECOGNIZER: OnceLock<Result<LocalRecognizer, String>> = OnceLock::new();
    RECOGNIZER
        .get_or_init(|| {
            let dir = model_dir(app)?;
            let model = dir.join(MODEL_FILE);
            let tokens = dir.join(TOKENS_FILE);
            if file_bytes(&model).unwrap_or(0) < MODEL_MIN_BYTES
                || file_bytes(&tokens).unwrap_or(0) < 1024
            {
                return Err("本地识别模型未下载(设置 → 角色语音 → 模型文件)".into());
            }
            // tokens 语义校验:半截文件会缺哨兵 token,当场拒绝(免得加载阶段才报模糊错误)
            if let Ok(mut f) = std::fs::File::open(&tokens) {
                let mut head = String::new();
                let ok = f.read_to_string(&mut head).is_ok() && head.contains(TOKENS_SENTINEL);
                if !ok {
                    return Err("tokens 文件损坏,请删除后重新下载本地模型".into());
                }
            }
            let config = sherpa_rs::sense_voice::SenseVoiceConfig {
                model: model.to_string_lossy().into_owned(),
                tokens: tokens.to_string_lossy().into_owned(),
                language: "auto".into(),
                use_itn: true,
                num_threads: Some(2),
                ..Default::default()
            };
            let inner = sherpa_rs::sense_voice::SenseVoiceRecognizer::new(config)
                .map_err(|e| format!("本地识别模型加载失败:{e}"))?;
            Ok(LocalRecognizer {
                inner: Mutex::new(inner),
            })
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// 语音对话/录音识别共用的本地识别入口(与云端 asr_transcribe 同形:wav base64 进,文本出)。
#[tauri::command]
pub async fn asr_transcribe_local(
    app: tauri::AppHandle,
    wav_base64: String,
) -> Result<crate::asr::AsrResult, String> {
    let wav = base64::engine::general_purpose::STANDARD
        .decode(wav_base64.trim())
        .map_err(|e| format!("音频数据解码失败:{e}"))?;
    let samples = wav_to_f32(&wav)?;
    tauri::async_runtime::spawn_blocking(move || {
        let recognizer = recognizer(&app)?;
        let mut guard = recognizer.inner.lock().map_err(|e| e.to_string())?;
        let result = guard.transcribe(16_000, &samples);
        Ok(crate::asr::AsrResult {
            text: result.text.trim().to_string(),
        })
    })
    .await
    .map_err(|e| format!("任务调度失败:{e}"))?
}

/// 我们自己 pcmToWav 产出的 44 字节头 PCM16 单声道 WAV → f32 采样。失败即报,
/// 不猜偏移——格式唯一来源是本应用的 pcmToWav。
fn wav_to_f32(wav: &[u8]) -> Result<Vec<f32>, String> {
    if wav.len() < 48 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" || &wav[36..40] != b"data"
    {
        return Err("音频格式不支持(非标准 PCM WAV)".into());
    }
    let data_len = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize;
    let end = (44 + data_len).min(wav.len());
    let mut out = Vec::with_capacity((end - 44) / 2);
    for chunk in wav[44..end].chunks_exact(2) {
        let v = i16::from_le_bytes([chunk[0], chunk[1]]);
        out.push(v as f32 / 32768.0);
    }
    if out.is_empty() {
        return Err("音频为空".into());
    }
    Ok(out)
}
