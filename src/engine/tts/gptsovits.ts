// GPT-SoVITS(api_v2.py)本地自建供应商:音色由参考音频决定,配置里维护「参考音色表」。
// 流式契约:streaming_mode=1/2/3 时响应 = 44 字节 RIFF 头(数据长度占位 0)+ 逐段裸 Int16LE PCM。
// 本层攒出头后剥掉,按头的真实采样率以 pcm 元信息交付(采样率随模型版本 32k/24k 变且
// 不在 HTTP 头里,声明错会变调);详见 openWavStream。无情感指令通道,语气差异仅由语速表达。
import { fetch } from '@tauri-apps/plugin-http'
import { parseWavFront } from './wav'
import type { AppConfig } from '../../storage/configStore'
import type { SynthRequest, TtsCredentials, TtsProvider, TtsStream, VoiceOption } from './types'

/** 首块 wav 头的读取超时:服务进程在但不响应时不无限挂起 speak() */
const HEADER_TIMEOUT_MS = 20_000

/** speed_factor 服务端合法区间;语速档(deadpan 0.96 / excited 1.06 等)全在区间内 */
function clampSpeed(speed: number): number {
  return Math.min(1.65, Math.max(0.6, speed))
}

/** 配置指纹(同步 djb2):音色表/档位被编辑即整体换缓存键,旧合成结果自然失效 */
function configFingerprint(cfg: AppConfig): string {
  const s = JSON.stringify(cfg.voice.gptsovits)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer = 0
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('gpt-sovits wav 头读取超时')), HEADER_TIMEOUT_MS)
    }),
  ]).finally(() => window.clearTimeout(timer))
}

/** 攒够 wav 头再交棒:采样率/声道/位深按头声明(随模型版本 32k/24k 变)。
 *  头在本层剥掉、以 pcm 元信息交付——播放器按裸 PCM 直喂(若仍声明 wav,
 *  它会在纯 PCM 里二次找头,64KB 后报"不是 wav 格式"整句降级);
 *  缓存路径也由 pcmToWav 补上规范头,服务端占位(data 长度 0)的头不会进缓存 */
async function openWavStream(src: ReadableStream<Uint8Array>): Promise<TtsStream> {
  const reader = src.getReader()
  try {
    let buf = new Uint8Array(0)
    for (;;) {
      const { done, value } = await readWithTimeout(reader)
      if (done) throw new Error('gpt-sovits 流提前结束(未收到 wav 头)')
      const merged = new Uint8Array(buf.length + value.length)
      merged.set(buf)
      merged.set(value, buf.length)
      buf = merged
      const parsed = parseWavFront(buf)
      if (parsed) {
        return {
          meta: {
            format: 'pcm',
            sampleRate: parsed.sampleRate,
            channels: parsed.channels,
            bitsPerSample: parsed.bitsPerSample,
          },
          body: reemitAfter(reader, buf, parsed.pcmOffset),
        }
      }
      if (buf.length > 65536) throw new Error('gpt-sovits 流不是 wav 格式')
    }
  } catch (err) {
    void reader.cancel().catch(() => {})
    throw err
  }
}

/** 头解析完,把「已读余额 + 后续分片」重组装成干净的字节流 */
function reemitAfter(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: Uint8Array,
  pcmOffset: number,
): ReadableStream<Uint8Array> {
  let head = pcmOffset
  return new ReadableStream({
    async pull(controller) {
      if (head < buffered.length) {
        controller.enqueue(buffered.subarray(head))
        head = buffered.length
        return
      }
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel() {
      return reader.cancel().catch(() => {})
    },
  })
}

export const gptsovitsProvider: TtsProvider = {
  id: 'gptsovits',
  label: 'GPT-SoVITS · 本地自建',
  // 音色表是用户配置的,无法静态列出;设置页单独渲染,分配下拉直接读配置
  voices: [] as VoiceOption[],
  modelId: (cfg: AppConfig) => `gpt-sovits:${configFingerprint(cfg)}`,
  defaultVoiceId: (cfg: AppConfig) => cfg.voice.gptsovits.voices[0]?.id ?? '',
  missingSetup: (cfg: AppConfig) => {
    if (!cfg.voice.gptsovits.url.trim()) return '未配置 GPT-SoVITS 服务器地址(设置 → 角色语音)'
    if (cfg.voice.gptsovits.voices.length === 0) return '未配置 GPT-SoVITS 参考音色(设置 → 角色语音)'
    const ids = new Set(cfg.voice.gptsovits.voices.map((v) => v.id))
    const asg = cfg.voice.assignments.gptsovits
    if ((asg.A && !ids.has(asg.A)) || (asg.B && !ids.has(asg.B)) || (asg.C && !ids.has(asg.C))) {
      return '角色音色指向的 GPT-SoVITS 参考音色已被删除,请重新分配(设置 → 角色语音)'
    }
    return null
  },
  async synthesizeStream(req: SynthRequest, creds: TtsCredentials): Promise<TtsStream> {
    const gpt = creds.gptsovits
    const def = gpt?.voices.find((v) => v.id === req.voice)
    if (!gpt || !def) throw new Error('gpt-sovits 音色不存在(参考音色表里找不到)')
    const base = gpt.url.trim().replace(/\/+$/, '')
    const resp = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: req.text,
        text_lang: gpt.textLang || 'auto',
        ref_audio_path: def.refAudioPath,
        prompt_text: def.promptText,
        prompt_lang: def.promptLang || 'zh',
        text_split_method: 'cut5',
        media_type: 'wav',
        streaming_mode: gpt.streamMode,
        speed_factor: clampSpeed(req.speed),
      }),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`gpt-sovits http ${resp.status}: ${body.slice(0, 200)}`)
    }
    if (!resp.body) throw new Error('gpt-sovits 无响应流')
    return openWavStream(resp.body)
  },
}
