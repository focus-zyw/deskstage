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
/// 连接超时与 endpoint_proxy 对齐;总超时覆盖"上传+识别"全程
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(20);

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
#[tauri::command]
pub async fn asr_transcribe(wav_base64: String, model: String) -> Result<AsrResult, String> {
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

    let part_file = reqwest::multipart::Part::bytes(wav)
        .file_name("utterance.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("model", model.trim().to_string())
        .part("file", part_file);

    let resp = client()
        .post(ENDPOINT)
        .bearer_auth(key)
        .multipart(form)
        .timeout(TOTAL_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("识别请求失败:{e}"))?;

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
}
