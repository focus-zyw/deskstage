// 硅基流动 CosyVoice2(默认供应商):wav 流式合成 + 自然语言情感指令 + 音色克隆。
// 请求走 tauri-plugin-http(Rust 侧发,无 CORS;capabilities 里放行了 api.siliconflow.cn)。
import { fetch } from '@tauri-apps/plugin-http'
import { deliveryInstruction } from '../../performer/dialogSchema'
import type { AppConfig } from '../../storage/configStore'
import type { SynthRequest, TtsCredentials, TtsProvider, TtsStream, VoiceOption } from './types'

const TTS_URL = 'https://api.siliconflow.cn/v1/audio/speech'
const TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B'
const CLONE_URL = 'https://api.siliconflow.cn/v1/uploads/audio/voice'
const SAMPLE_RATE = 44100

/** 音色清单(实测有效的 CosyVoice2 内置音色,2026-09 逐个探测确认),label 显示在设置下拉 */
export const SILICONFLOW_VOICES: VoiceOption[] = [
  { id: 'bella', label: 'Bella · 女声明快' },
  { id: 'claire', label: 'Claire · 女声柔和' },
  { id: 'anna', label: 'Anna · 女声' },
  { id: 'alex', label: 'Alex · 男声沉稳' },
  { id: 'benjamin', label: 'Benjamin · 男声磁性' },
  { id: 'charles', label: 'Charles · 男声健谈' },
  { id: 'david', label: 'David · 男声欢乐' },
]

/** 合成用的完整 voice 参数:内置音色拼 模型:名,自定义音色已是 speech: 开头的 uri */
function fullVoice(voice: string): string {
  return voice.startsWith('speech:') ? voice : `${TTS_MODEL}:${voice}`
}

export const siliconflowProvider: TtsProvider = {
  id: 'siliconflow',
  label: '硅基流动 · CosyVoice2',
  voices: SILICONFLOW_VOICES,
  modelId: () => TTS_MODEL,
  missingSetup: (cfg: AppConfig) => (cfg.voice.apiKey.trim() ? null : '未配置硅基流动 API Key(设置 → 角色语音)'),
  async synthesizeStream(req: SynthRequest, creds: TtsCredentials): Promise<TtsStream> {
    // 情感指令经 <|endofprompt|> 注入(可开关):标记前是语气指令,模型只取风格不朗读;
    // 直接把指令拼在台词前面会被整句念出来
    const instruction = creds.emotionHints ? deliveryInstruction(req.delivery) : ''
    const resp = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: instruction ? `${instruction}<|endofprompt|>${req.text}` : req.text,
        voice: fullVoice(req.voice),
        response_format: 'wav',
        sample_rate: SAMPLE_RATE,
        stream: true,
        speed: req.speed,
      }),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`tts http ${resp.status}: ${body.slice(0, 200)}`)
    }
    if (!resp.body) throw new Error('tts 无响应流')
    return {
      meta: { format: 'wav', sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16 },
      body: resp.body,
    }
  },
}

// ---------- 音色克隆(硅基流动独有) ----------

export interface ClonedVoice {
  /** speech:xxx:xxx:xxx 形式的 uri,可直接当 voice 用 */
  uri: string
  name: string
}

/** 上传参考音频克隆音色(10~20 秒清晰人声,text 必须是音频里说的话)。
 *  成功后该音色出现在 listCustomVoices 里,可像内置音色一样使用 */
export async function cloneVoice(
  apiKey: string,
  audio: Blob,
  filename: string,
  customName: string,
  text: string,
): Promise<ClonedVoice> {
  const form = new FormData()
  form.set('model', TTS_MODEL)
  form.set('customName', customName)
  form.set('text', text)
  form.set('file', audio, filename)
  const resp = await fetch(CLONE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  const bodyText = await resp.text().catch(() => '')
  if (!resp.ok) throw new Error(`克隆失败 HTTP ${resp.status}: ${bodyText.slice(0, 200)}`)
  const data = JSON.parse(bodyText) as { uri?: string }
  if (!data.uri) throw new Error('克隆响应缺少 uri')
  return { uri: data.uri, name: customName }
}

/** 列出账号下的自定义克隆音色 */
export async function listCustomVoices(apiKey: string): Promise<ClonedVoice[]> {
  const resp = await fetch('https://api.siliconflow.cn/v1/audio/voice/list', {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!resp.ok) throw new Error(`voice list HTTP ${resp.status}`)
  const data = (await resp.json()) as { result?: { uri?: string; name?: string }[] }
  return (data.result ?? [])
    .filter((v) => v.uri && v.name)
    .map((v) => ({ uri: v.uri!, name: v.name! }))
}
