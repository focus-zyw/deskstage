// 云端语音识别:硅基流动 /v1/audio/transcriptions(multipart,OpenAI 兼容)。
//
// 为什么是专用命令而非通用端点代理:代理只收 JSON 文本体且按 kind 从 config.json
// 解析 origin,音频表单塞不进;这里 origin 固定 https 白名单域名,密钥由 Rust 读
// 凭据库 asr:siliconflow(能力级,独立于 TTS 的 tts:voice——TTS 用 MiniMax 时
// ASR 仍可单独配置硅基),前端从头到尾接触不到密钥。
//
// 硬化照 endpoint_proxy:仅 POST、禁重定向、连接超时 10s、总超时 20s、
// 请求体上限 32MB(30s/16k/i16 的 wav 约 1MB,余量给超长句);错误文案不带密钥。
// v1 不做在途取消:识别通常 0.7~2s,打断靠前端代次丢弃迟到结果,请求最长 20s 自然结束。

use std::time::Duration;

use base64::Engine;
use serde::Serialize;

const ENDPOINT: &str = "https://api.siliconflow.cn/v1/audio/transcriptions";
const MAX_WAV_BYTES: usize = 32 * 1024 * 1024;
/// 连接 15s、总 60s:ASR 要上传整段音频(30s 语音约 1MB),慢上行下 20s 会把
/// 正常的识别压成"发送失败"。设置页连接测试另走 10s/不重试的快速策略。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECTION_TEST_TIMEOUT: Duration = Duration::from_secs(10);
const TRANSCRIBE_ATTEMPTS: usize = 2;
const CONNECTION_TEST_ATTEMPTS: usize = 1;

/// 错误链:reqwest 的 Display 只给顶层「error sending request」,真正原因
/// (DNS 失败 / 连接超时 / TLS 握手 / 连接被重置)藏在 source 链里。
/// 不带出来时用户与开发者都只能猜——诊断信息必须直达 UI。
fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        out.push_str(" <- ");
        out.push_str(&s.to_string());
        cur = s.source();
    }
    out
}

/// 发送一次,连接类失败(建连失败/超时,多为网络抖动或代理握手)自动重试一次。
/// 其余错误(HTTP 层、body 层)直接上抛;两次都失败的文案带完整 source 链。
async fn send_with_retry(
    build: impl Fn() -> reqwest::RequestBuilder,
    total_timeout: Duration,
    max_attempts: usize,
) -> Result<reqwest::Response, String> {
    let mut last = String::new();
    for attempt in 0..max_attempts.max(1) {
        match build().timeout(total_timeout).send().await {
            Ok(r) => return Ok(r),
            Err(e) => {
                let retryable = e.is_timeout() || e.is_connect();
                last = error_chain(&e);
                if attempt + 1 < max_attempts && retryable {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    continue;
                }
                break;
            }
        }
    }
    Err(format!("识别请求失败:{last}"))
}

#[derive(Serialize)]
pub struct AsrResult {
    pub text: String,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client 构建失败")
    })
}

/// 转写一段 wav(PCM16)。模型由前端传(设置里选,官方列表:SenseVoiceSmall /
/// TeleSpeechASR,或用户自填,连接测试验证)。返回识别文本(可能为空串 = 没听清)。
async fn transcribe_with_policy(
    wav_base64: String,
    model: String,
    total_timeout: Duration,
    max_attempts: usize,
) -> Result<AsrResult, String> {
    let key = crate::secrets::read_secret("asr:siliconflow")?
        .filter(|k| !k.trim().is_empty())
        .ok_or("未配置语音识别密钥(设置 → 角色语音 → 语音对话)")?;
    if model.trim().is_empty() || model.trim().len() > 200 {
        return Err("未配置识别模型".into());
    }
    let wav = base64::engine::general_purpose::STANDARD
        .decode(wav_base64.trim())
        .map_err(|e| format!("音频数据解码失败:{e}"))?;
    if wav.len() > MAX_WAV_BYTES {
        return Err("音频过长".into());
    }

    let model_name = model.trim().to_string();
    // 表单每次请求重建(reqwest 的 Form 不是 Clone):wav 仅在重试时才第二次克隆
    let build_form = || {
        let part = reqwest::multipart::Part::bytes(wav.clone())
            .file_name("utterance.wav")
            .mime_str("audio/wav")
            .expect("内置 mime 常量必然合法");
        reqwest::multipart::Form::new()
            .text("model", model_name.clone())
            .part("file", part)
    };

    let resp = send_with_retry(
        || {
            client()
                .post(ENDPOINT)
                .bearer_auth(&key)
                .multipart(build_form())
        },
        total_timeout,
        max_attempts,
    )
    .await?;

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    match status {
        200 => {
            let v: serde_json::Value =
                serde_json::from_str(&body).map_err(|e| format!("识别响应解析失败:{e}"))?;
            let text = v
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            Ok(AsrResult { text })
        }
        401 | 403 => Err("语音识别密钥无效".into()),
        429 => Err("识别请求太频繁,稍后再说".into()),
        _ => {
            let snippet: String = body.chars().take(160).collect();
            Err(format!("识别失败(HTTP {status}):{snippet}"))
        }
    }
}

#[tauri::command]
pub async fn asr_transcribe(wav_base64: String, model: String) -> Result<AsrResult, String> {
    transcribe_with_policy(wav_base64, model, TOTAL_TIMEOUT, TRANSCRIBE_ATTEMPTS).await
}

/// 设置页只验证 endpoint/key/model 是否可用:短超时且不重试,避免按钮跨越两个
/// 60 秒窗口。传入静音 WAV 是为了走与真实识别相同的 multipart/API 校验路径；
/// 返回文本没有质量含义,前端不会把空串展示成“识别成功”。
#[tauri::command]
pub async fn asr_test_connection(wav_base64: String, model: String) -> Result<AsrResult, String> {
    transcribe_with_policy(
        wav_base64,
        model,
        CONNECTION_TEST_TIMEOUT,
        CONNECTION_TEST_ATTEMPTS,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_model_and_unreadable_base64() {
        // 密钥未配置/模型为空都应在发请求前被拦;真机凭据差异不影响断言
        // (密钥不存在时先报密钥错,存在时才轮到模型错——两条错误都来自本命令)
        let rt = tokio::runtime::Runtime::new().unwrap();
        let r = rt.block_on(asr_transcribe("".into(), "".into()));
        let msg = match r {
            Err(m) => m,
            Ok(_) => panic!("空输入应当被拒绝"),
        };
        assert!(
            msg.contains("密钥") || msg.contains("模型"),
            "意外错误: {msg}"
        );
    }

    #[test]
    fn connection_test_policy_is_short_and_never_retries() {
        assert_eq!(CONNECTION_TEST_TIMEOUT, Duration::from_secs(10));
        assert_eq!(CONNECTION_TEST_ATTEMPTS, 1);
        assert!(CONNECTION_TEST_TIMEOUT < TOTAL_TIMEOUT);
        assert!(CONNECTION_TEST_ATTEMPTS < TRANSCRIBE_ATTEMPTS);
    }
}

#[cfg(test)]
mod transport_probe {
    use super::*;

    /// 真机网络探测:同 client() 配置下,纯 TLS 与 multipart 两条通路各打一次。
    /// GET 预期 404、POST 带假 key 预期 401 —— 都拿到 HTTP 状态即传输层正常。
    #[test]
    #[ignore = "真机网络冒烟;本机 cargo test -- --ignored --nocapture 运行"]
    fn probe_transport() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            match client().get("https://api.siliconflow.cn/").send().await {
                Ok(r) => println!("[probe] plain GET -> HTTP {}", r.status().as_u16()),
                Err(e) => println!("[probe] plain GET FAILED: {}", error_chain(&e)),
            }
            let part = reqwest::multipart::Part::bytes(vec![0u8; 64]).file_name("probe.wav");
            let form = reqwest::multipart::Form::new()
                .text("model", "probe")
                .part("file", part);
            match client()
                .post(ENDPOINT)
                .bearer_auth("sk-probe-invalid-key")
                .multipart(form)
                .send()
                .await
            {
                Ok(r) => println!("[probe] multipart POST -> HTTP {}", r.status().as_u16()),
                Err(e) => println!("[probe] multipart POST FAILED: {}", error_chain(&e)),
            }
        });
    }
}
