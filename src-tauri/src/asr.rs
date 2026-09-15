// 云端语音识别:硅基流动 /v1/audio/transcriptions(multipart,OpenAI 兼容)。
//
// 为什么是专用命令而非通用端点代理:代理只收 JSON 文本体且按 kind 从 config.json
// 解析 origin,音频表单塞不进;这里 origin 固定 https 白名单域名,密钥由 Rust 读
// 凭据库 asr:siliconflow(能力级,独立于 TTS 的 tts:voice——TTS 用 MiniMax 时
// ASR 仍可单独配置硅基),前端从头到尾接触不到密钥。
//
// 硬化照 endpoint_proxy:仅 POST、禁重定向、连接超时 15s、识别单次尝试 20s、
// 请求体上限 32MB(30s/16k/i16 的 wav 约 1MB,余量给超长句);错误文案不带密钥。
// v1 不做在途取消:识别通常 0.7~2s,打断靠前端代次丢弃迟到结果,单次尝试 20s,共 3 次。
//
// 连接测试(设置页)实测裁决(2026-09 排查「测试超时但识别成功」):
// · 旧测试上传 1s 静音打到 /transcriptions,两个致命伤:服务端已改为对静音回
//   「HTTP 500 空响应体」(原假设「静音 → 200 空文本」被服务端变更杀死);且推理
//   后端存在慢节点——多 A 记录轮换(实测见 139.196.x/47.102.x/47.103.x/101.132.x),
//   部分 backend 建连成功后对请求永不响应(真机 netstat:ESTABLISHED 挂满 10s),
//   单次 10s 测试大概率撞死,而识别(60s×2)总能 ride 过去——这正是「按钮超时但
//   录音识别成功」的完整解释;
// · 现测试改打 GET /v1/models:轻量 JSON 端点,不进推理后端、不耗配额,一次验证
//   服务可达 + 密钥有效(401/403 前置)+ 模型名在官方列表(还能抓出模型名笔误);
// · 一次性独立 Client(不复用长寿命共享池)+ 10s×3 次尝试(600ms 间隔):对抗
//   慢节点/陈旧连接,按钮最坏 ~31s 有界,健康时 0.1s 级。识别质量由「录音识别」把关。

use std::time::Duration;

use base64::Engine;
use serde::Serialize;

const ENDPOINT: &str = "https://api.siliconflow.cn/v1/audio/transcriptions";
/// 连接测试专用:轻量模型列表端点,不进推理后端(推理后端对静音拒/挂,见文件头裁决)
const MODELS_ENDPOINT: &str = "https://api.siliconflow.cn/v1/models";
const MAX_WAV_BYTES: usize = 32 * 1024 * 1024;
/// 连接 15s、总 60s:ASR 要上传整段音频(30s 语音约 1MB),慢上行下 20s 会把
/// 正常的识别压成"发送失败"。设置页连接测试另走 10s×3 次的快速策略。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 识别单次尝试预算 20s × 3 次(2026-09 实测:推理后端存在慢节点,同 utterance
/// 偶发挂起 30s+;短预算快刀斩掉挂起尝试,健康后端 1-3s 内必答,最坏 ~62s 有界)。
/// 长音频上传(30s 语音 ≈ 1MB)在常见上行下 20s 内充裕。
const TRANSCRIBE_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
const TRANSCRIBE_ATTEMPTS: usize = 3;
const CONNECTION_TEST_TIMEOUT: Duration = Duration::from_secs(10);
/// 连接对同一端点存在约半数的「黑洞」形态(多 A 记录后端或代理节点,实测同分钟内
/// 交替:挂起 >10s 与 0.2s 响应随机出现)——3 次尝试把单按钮失败率压到 ~12%,
/// 最坏 ~31s 有界;挂起的尝试反正等不到响应,超时快刀反而更快进入下一次。
const CONNECTION_TEST_ATTEMPTS: usize = 3;

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

/// 连接测试专用:一次性独立 Client。长寿命共享池里的陈旧 keep-alive/过期 DNS
/// 只会毒化"复用它"的第一跳——真机故障形态(共享池下按钮 10s 无响应,同刻
/// 独立进程同请求 0.2s 有响应)指向的就是它;测试每次新建,永不复用。
fn fresh_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("reqwest client 构建失败")
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
    let hint = if last.contains("timed out") {
        ";可能是代理/VPN 抖动或服务端排队(真实识别有 20s×3 次尝试,可稍后再试)".to_string()
    } else {
        String::new()
    };
    Err(format!("识别请求失败:{last}{hint}"))
}

#[derive(Serialize, Debug)]
pub struct AsrResult {
    pub text: String,
}

/// 校验输入并把请求发到端点,返回 (HTTP 状态, 响应体)——判读交给调用方
/// (真实识别与连接测试对同一批状态码语义不同,见两个 map 函数)。
async fn send_asr_request(
    client: &reqwest::Client,
    wav_base64: String,
    model: String,
    total_timeout: Duration,
    max_attempts: usize,
) -> Result<(u16, String), String> {
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
            client
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
    Ok((status, body))
}

/// 真实识别的判读:只有 200 带文本才算成功。
fn map_transcribe_response(status: u16, body: &str) -> Result<AsrResult, String> {
    match status {
        200 => {
            let v: serde_json::Value =
                serde_json::from_str(body).map_err(|e| format!("识别响应解析失败:{e}"))?;
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

/// 连接测试的判读:目标是「服务可达 + 密钥有效 + 模型名真实存在」。
/// 走 GET /v1/models(轻量 JSON 端点,不进推理后端):200 的模型列表里能找到
/// 配置的模型名 = 三者全过;200 但找不到 = 模型名笔误(旧静音测试抓不出这类错);
/// 401/403 = 密钥无效;429 限流 = 密钥已被接受,判可达。识别质量仍由
/// 「录音识别」按钮把关。
fn map_test_response(status: u16, body: &str, model: &str) -> Result<AsrResult, String> {
    match status {
        200 => {
            let listed = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| {
                    v.get("data").and_then(|d| d.as_array()).map(|arr| {
                        arr.iter()
                            .any(|m| m.get("id").and_then(|i| i.as_str()) == Some(model))
                    })
                });
            match listed {
                Some(true) => Ok(AsrResult {
                    text: String::new(),
                }),
                Some(false) => Err(format!(
                    "识别模型 {model} 不在硅基流动模型列表中,请在设置里核对模型名"
                )),
                None => Err("模型列表响应解析失败".into()),
            }
        }
        429 => Ok(AsrResult {
            text: String::new(),
        }),
        401 | 403 => Err("语音识别密钥无效".into()),
        _ => {
            let snippet: String = body.chars().take(160).collect();
            Err(format!("识别失败(HTTP {status}):{snippet}"))
        }
    }
}

/// 转写一段 wav(PCM16)。模型由前端传(设置里选,官方列表:SenseVoiceSmall /
/// TeleSpeechASR,或用户自填,连接测试验证)。返回识别文本(可能为空串 = 没听清)。
async fn transcribe_with_policy(
    wav_base64: String,
    model: String,
    total_timeout: Duration,
    max_attempts: usize,
) -> Result<AsrResult, String> {
    let (status, body) =
        send_asr_request(client(), wav_base64, model, total_timeout, max_attempts).await?;
    map_transcribe_response(status, &body)
}

#[tauri::command]
pub async fn asr_transcribe(wav_base64: String, model: String) -> Result<AsrResult, String> {
    transcribe_with_policy(
        wav_base64,
        model,
        TRANSCRIBE_ATTEMPT_TIMEOUT,
        TRANSCRIBE_ATTEMPTS,
    )
    .await
}

/// 设置页连接测试:验证 endpoint/key/model 三者。走 GET /v1/models(轻量 JSON,
/// 不进推理后端——2026-09 实测推理后端对静音样本会拒/会挂,且多 A 记录后端中
/// 有慢节点):一次性独立 Client 隔离共享池陈旧状态,10s×3 次尝试有界快速反馈。
#[tauri::command]
pub async fn asr_test_connection(model: String) -> Result<AsrResult, String> {
    let key = crate::secrets::read_secret("asr:siliconflow")?
        .filter(|k| !k.trim().is_empty())
        .ok_or("未配置语音识别密钥(设置 → 角色语音 → 语音对话)")?;
    if model.trim().is_empty() || model.trim().len() > 200 {
        return Err("未配置识别模型".into());
    }
    let client = fresh_client();
    let resp = send_with_retry(
        || client.get(MODELS_ENDPOINT).bearer_auth(&key),
        CONNECTION_TEST_TIMEOUT,
        CONNECTION_TEST_ATTEMPTS,
    )
    .await?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    map_test_response(status, &body, model.trim())
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
    fn connection_test_policy_is_short_with_three_attempts() {
        assert_eq!(CONNECTION_TEST_TIMEOUT, Duration::from_secs(10));
        assert_eq!(CONNECTION_TEST_ATTEMPTS, 3);
        assert!(CONNECTION_TEST_TIMEOUT < TRANSCRIBE_ATTEMPT_TIMEOUT);
    }

    #[test]
    fn test_response_mapping_models_list_and_rate_limit() {
        // 连接测试走 GET /v1/models:200 且列表含配置模型 = 全过;
        // 200 但找不到 = 模型名笔误(旧静音测试抓不出);429 = 密钥已被接受,判可达。
        let list =
            r#"{"data":[{"id":"FunAudioLLM/SenseVoiceSmall"},{"id":"deepseek-ai/DeepSeek-V3"}]}"#;
        assert!(map_test_response(200, list, "FunAudioLLM/SenseVoiceSmall").is_ok());
        let e = map_test_response(200, list, "SenseVoiceSmall").unwrap_err();
        assert!(e.contains("SenseVoiceSmall") && e.contains("模型列表"));
        assert!(map_test_response(429, "", "FunAudioLLM/SenseVoiceSmall").is_ok());
        assert!(map_test_response(401, "", "x")
            .unwrap_err()
            .contains("密钥"));
        let e = map_test_response(503, "unavailable", "x").unwrap_err();
        assert!(e.contains("503") && e.contains("unavailable"));
        // 响应不是预期 JSON → 明确报解析失败,不静默放行
        assert!(map_test_response(200, "not-json", "FunAudioLLM/SenseVoiceSmall").is_err());
    }

    #[test]
    fn transcribe_response_mapping_only_200_with_text_passes() {
        let ok = map_transcribe_response(200, r#"{"text":" 你好 "}"#).unwrap();
        assert_eq!(ok.text, "你好");
        assert!(map_transcribe_response(429, "")
            .unwrap_err()
            .contains("频繁"));
        assert!(map_transcribe_response(500, "")
            .unwrap_err()
            .contains("HTTP 500"));
        assert!(map_transcribe_response(401, "")
            .unwrap_err()
            .contains("密钥"));
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

    /// 真实链路计时探测:真密钥(凭据库读入内存,不打印)+ 1s 静音 WAV + 真模型,
    /// 与连接测试(asr_test_connection)完全同形。用于区分「传输层不通」与
    /// 「服务端对有效请求的处理延迟超过 10s 测试预算」——401 探测在排队前就被拒,
    /// 测不出后者。输出只有耗时/状态/文本长度,无任何敏感内容。
    /// 可用 ASR_PROBE_MODEL 覆盖模型;ASR_PROBE_TIMEOUT_MS 覆盖预算(默认 60s)。
    #[test]
    #[ignore = "真实请求冒烟(消耗一次识别配额);cargo test probe_real_request -- --ignored --nocapture"]
    fn probe_real_request() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let key = match crate::secrets::read_secret("asr:siliconflow") {
                Ok(Some(k)) if !k.trim().is_empty() => k,
                Ok(_) => {
                    println!("[probe-real] 未配置密钥,跳过");
                    return;
                }
                Err(e) => {
                    println!("[probe-real] 凭据库读取失败: {e}");
                    return;
                }
            };
            let model = std::env::var("ASR_PROBE_MODEL")
                .unwrap_or_else(|_| "FunAudioLLM/SenseVoiceSmall".into());
            let budget = std::env::var("ASR_PROBE_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .map(Duration::from_millis)
                .unwrap_or(Duration::from_secs(60));
            // 1s 静音 16k/mono/i16 —— 与前端连接测试同形
            let sample_rate = 16_000u32;
            let pcm = vec![0u8; sample_rate as usize * 2];
            let mut wav = vec![0u8; 44 + pcm.len()];
            wav[0..4].copy_from_slice(b"RIFF");
            wav[4..8].copy_from_slice(&((36 + pcm.len()) as u32).to_le_bytes());
            wav[8..12].copy_from_slice(b"WAVE");
            wav[12..16].copy_from_slice(b"fmt ");
            wav[16..20].copy_from_slice(&16u32.to_le_bytes());
            wav[20..22].copy_from_slice(&1u16.to_le_bytes());
            wav[22..24].copy_from_slice(&1u16.to_le_bytes());
            wav[24..28].copy_from_slice(&sample_rate.to_le_bytes());
            wav[28..32].copy_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate = 采样率×声道×2B
            wav[32..34].copy_from_slice(&2u16.to_le_bytes()); // wBlockAlign
            wav[34..36].copy_from_slice(&16u16.to_le_bytes()); // wBitsPerSample
            wav[40..44].copy_from_slice(&(pcm.len() as u32).to_le_bytes());
            wav[44..].copy_from_slice(&pcm);

            let part = reqwest::multipart::Part::bytes(wav)
                .file_name("utterance.wav")
                .mime_str("audio/wav")
                .expect("内置 mime 常量必然合法");
            let form = reqwest::multipart::Form::new()
                .text("model", model.clone())
                .part("file", part);
            let started = std::time::Instant::now();
            match client()
                .post(ENDPOINT)
                .bearer_auth(key.trim())
                .multipart(form)
                .timeout(budget)
                .send()
                .await
            {
                Ok(r) => {
                    let status = r.status().as_u16();
                    let body = r.text().await.unwrap_or_default();
                    let text_len = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| {
                            v.get("text").and_then(|t| t.as_str()).map(|s| s.trim().len())
                        })
                        .unwrap_or(0);
                    println!(
                        "[probe-real] model={model} -> HTTP {status},耗时 {:.2}s,返回文本长度 {text_len}(预算 {:?})",
                        started.elapsed().as_secs_f32(),
                        budget
                    );
                    if status != 200 {
                        // 错误响应体不含凭据,打印片段定位服务端拒绝原因
                        let snippet: String = body.chars().take(240).collect();
                        println!("[probe-real] 非 200 响应体片段: {snippet}");
                    }
                }
                Err(e) => println!(
                    "[probe-real] model={model} FAILED after {:.2}s(预算 {:?}): {}",
                    started.elapsed().as_secs_f32(),
                    budget,
                    error_chain(&e)
                ),
            }
        });
    }
}

#[cfg(test)]
mod transport_probe_command {
    use super::*;

    /// 端到端命令探测:直接调用 asr_test_connection(与设置页按钮同一条命令路径,
    /// 含 fresh_client + 模型列表判读)。预期 Ok(服务可达)。
    /// cargo test probe_test_connection -- --ignored --nocapture
    #[test]
    #[ignore = "真实请求冒烟;需已配置密钥"]
    fn probe_test_connection() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let started = std::time::Instant::now();
            match asr_test_connection("FunAudioLLM/SenseVoiceSmall".into()).await {
                Ok(_) => println!(
                    "[probe-cmd] asr_test_connection -> Ok(服务可达),耗时 {:.2}s",
                    started.elapsed().as_secs_f32()
                ),
                Err(e) => println!(
                    "[probe-cmd] asr_test_connection -> Err after {:.2}s: {e}",
                    started.elapsed().as_secs_f32()
                ),
            }
        });
    }
}

#[cfg(test)]
mod transport_probe_transcribe {
    use super::*;

    /// 真实识别命令探测:非静音音频(白噪声)走 asr_transcribe 命令路径——
    /// 与语音对话完全同一条路(60s 预算 ×2 次尝试)。用于测量语音「正在想」里
    /// ASR 段的真实延迟/挂起率。输出只有耗时与文本长度,无敏感内容。
    #[test]
    #[ignore = "真实请求冒烟;需已配置密钥"]
    fn probe_transcribe_command() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let sample_rate = 16_000u32;
            let mut pcm = vec![0i16; sample_rate as usize];
            // 伪随机噪声模拟「有声音」:纯静音会被服务端 500 拒绝
            let mut seed: u32 = 0x12345678;
            for (i, v) in pcm.iter_mut().enumerate() {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                *v = ((seed >> 16) as i16) / 8;
                let _ = i;
            }
            let mut bytes = vec![0u8; 0];
            bytes.extend_from_slice(bytemuck_cast(&pcm));
            let mut wav = vec![0u8; 44 + bytes.len()];
            wav[0..4].copy_from_slice(b"RIFF");
            wav[4..8].copy_from_slice(&((36 + bytes.len()) as u32).to_le_bytes());
            wav[8..12].copy_from_slice(b"WAVE");
            wav[12..16].copy_from_slice(b"fmt ");
            wav[16..20].copy_from_slice(&16u32.to_le_bytes());
            wav[20..22].copy_from_slice(&1u16.to_le_bytes());
            wav[22..24].copy_from_slice(&1u16.to_le_bytes());
            wav[24..28].copy_from_slice(&sample_rate.to_le_bytes());
            wav[28..32].copy_from_slice(&(sample_rate * 2).to_le_bytes());
            wav[32..34].copy_from_slice(&2u16.to_le_bytes());
            wav[34..36].copy_from_slice(&16u16.to_le_bytes());
            wav[36..40].copy_from_slice(b"data");
            wav[40..44].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
            wav[44..].copy_from_slice(&bytes);
            let b64 = base64::engine::general_purpose::STANDARD.encode(&wav);
            let started = std::time::Instant::now();
            match asr_transcribe(b64, "FunAudioLLM/SenseVoiceSmall".into()).await {
                Ok(r) => println!(
                    "[probe-asr] asr_transcribe -> Ok,耗时 {:.2}s,文本长度 {}",
                    started.elapsed().as_secs_f32(),
                    r.text.len()
                ),
                Err(e) => println!(
                    "[probe-asr] asr_transcribe -> Err after {:.2}s: {e}",
                    started.elapsed().as_secs_f32()
                ),
            }
        });
    }

    fn bytemuck_cast(v: &[i16]) -> &[u8] {
        unsafe { std::slice::from_raw_parts(v.as_ptr().cast(), std::mem::size_of_val(v)) }
    }
}

#[cfg(test)]
mod transport_probe_local {
    use super::*;

    /// 本地离线识别端到端探测:asr_transcribe_local(与语音对话同一条命令路径)。
    /// 需先下载模型(设置页或调用 local_asr_download)。
    #[test]
    #[ignore = "本地模型冒烟;需已下载 SenseVoice 模型文件"]
    fn probe_local_transcribe() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // 用 tauri AppHandle 拿 appdata 路径在测试环境不可用(无 app);
            // 直接按生产同款目录约定定位:appdata/models/sensevoice
            let home = std::env::var("USERPROFILE").unwrap_or_default();
            let dir = std::path::PathBuf::from(home.clone())
                .join("AppData/Roaming/dev.virtualcharacter.app/models/sensevoice");
            let model = dir.join("model.int8.onnx");
            let tokens = dir.join("tokens.txt");
            if !model.exists() || !tokens.exists() {
                println!("[probe-local] 模型文件不存在,跳过({})", dir.display());
                return;
            }
            // 推理内核直接构造(绕过 AppHandle;模型目录相同)
            let config = sherpa_rs::sense_voice::SenseVoiceConfig {
                model: model.to_string_lossy().into_owned(),
                tokens: tokens.to_string_lossy().into_owned(),
                language: "auto".into(),
                use_itn: true,
                num_threads: Some(2),
                ..Default::default()
            };
            let started = std::time::Instant::now();
            let mut recognizer = match sherpa_rs::sense_voice::SenseVoiceRecognizer::new(config) {
                Ok(r) => r,
                Err(e) => {
                    println!(
                        "[probe-local] 模型加载失败 after {:.2}s: {e}",
                        started.elapsed().as_secs_f32()
                    );
                    return;
                }
            };
            println!(
                "[probe-local] 模型加载耗时 {:.2}s",
                started.elapsed().as_secs_f32()
            );
            // 1s 16k 正弦波(有内容,非静音)
            let samples: Vec<f32> = (0..16_000)
                .map(|i| (((i as f32) * 440.0 * std::f32::consts::TAU / 16_000.0).sin()) * 0.3)
                .collect();
            let t1 = std::time::Instant::now();
            let result = recognizer.transcribe(16_000, &samples);
            println!(
                "[probe-local] 推理耗时 {:.2}s,文本 = {:?}",
                t1.elapsed().as_secs_f32(),
                result.text
            );
        });
    }
}
