// MiniMax Speech 2.8(高表现力可选):情绪参数/语气控制,流式返回 hex 分片。
// 价格约为硅基流动的数倍,定位"重要台词/试听"的高表现力模式;失败静默降级由服务层兜底。
// 接口细节以官方 t2a_v2 文档为准(voice_id 清单可在文档增删)。
import { fetch } from '@tauri-apps/plugin-http'
import type { AppConfig } from '../../storage/configStore'
import type { SynthRequest, TtsCredentials, TtsProvider, TtsStream, VoiceOption } from './types'

const STREAM_URL = 'https://api.minimaxi.com/v1/t2a_v2/predict_stream'
const SAMPLE_RATE = 32000

export const MINIMAX_VOICES: VoiceOption[] = [
  { id: 'female-shaonv', label: '少女 · 清亮' },
  { id: 'female-yujie', label: '御姐 · 干练' },
  { id: 'female-chengshu', label: '成熟 · 知性' },
  { id: 'female-tianmei', label: '甜美 · 女声' },
  { id: 'male-qn-qingse', label: '青涩 · 男声' },
  { id: 'male-qn-jingying', label: '精英 · 男声' },
  { id: 'male-qn-badao', label: '霸道 · 男声' },
]

/** 语气 → MiniMax emotion 枚举(官方取值不含 excited;其余语气仅靠语速表达) */
function emotionOf(delivery?: string): string | undefined {
  if (delivery === 'deadpan') return 'neutral'
  if (delivery === 'excited') return 'happy'
  return undefined
}

/** SSE 行流 → PCM 字节流:每行 data:{"data":{"audio":"<hex>"}} ,解码为二进制 */
function hexToPcmStream(src: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buf = ''
  return new ReadableStream({
    async start(controller) {
      const reader = src.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const obj = JSON.parse(payload) as { data?: { audio?: string } }
              const hex = obj.data?.audio
              if (hex) controller.enqueue(hexToBytes(hex))
            } catch {
              // 单行坏数据跳过,不影响其余分片
            }
          }
        }
      } finally {
        controller.close()
      }
    },
    cancel() {
      return src.cancel()
    },
  })
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const minimaxProvider: TtsProvider = {
  id: 'minimax',
  label: 'MiniMax · Speech 2.8',
  voices: MINIMAX_VOICES,
  modelId: (cfg: AppConfig) => cfg.voice.minimax.model,
  missingSetup: (cfg: AppConfig) => {
    if (!cfg.voice.minimax.apiKey.trim()) return '未配置 MiniMax API Key'
    if (!cfg.voice.minimax.groupId.trim()) return '未配置 MiniMax GroupId'
    return null
  },
  async synthesizeStream(req: SynthRequest, creds: TtsCredentials): Promise<TtsStream> {
    const emotion = creds.emotionHints ? emotionOf(req.delivery) : undefined
    const url = `${STREAM_URL}?GroupId=${encodeURIComponent(creds.groupId ?? '')}`
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: creds.model || 'speech-2.8-turbo',
        text: req.text,
        stream: true,
        voice_setting: {
          voice_id: req.voice,
          speed: Math.min(2, Math.max(0.5, req.speed)),
          vol: 1,
          pitch: 0,
          ...(emotion ? { emotion } : {}),
        },
        audio_setting: { sample_rate: SAMPLE_RATE, format: 'pcm', channel: 1 },
      }),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`minimax http ${resp.status}: ${body.slice(0, 200)}`)
    }
    if (!resp.body) throw new Error('minimax 无响应流')
    return {
      meta: { format: 'pcm', sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16 },
      body: hexToPcmStream(resp.body),
    }
  },
}
