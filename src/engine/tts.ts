// 角色语音:硅基流动 CosyVoice2 合成 + 两级缓存(内存 blobUrl → 磁盘 mp3)+ 预合成。
// 请求走 tauri-plugin-http(Rust 侧发,无 CORS;capabilities 里放行了 api.siliconflow.cn)。
// 原则:语音失败永不影响演出 —— 所有错误静默降级为无语音,气泡照常走。
import { fetch } from '@tauri-apps/plugin-http'
import { readTextFile, writeTextFile, exists, mkdir, readDir, remove, stat } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { deliverySpeed } from '../performer/dialogSchema'
import { getConfig, inTauri, registerVoiceIds } from '../storage/configStore'
import type { Speaker } from '../performer/player'

const TTS_URL = 'https://api.siliconflow.cn/v1/audio/speech'
const TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B'
const CLONE_URL = 'https://api.siliconflow.cn/v1/uploads/audio/voice'

/** 音色清单(实测有效的 CosyVoice2 内置音色,2026-09 逐个探测确认),label 显示在设置下拉 */
export const VOICES: { id: string; label: string }[] = [
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

/** 合成一句,返回 mp3 二进制。失败抛错由调用方静默 */
async function synth(text: string, voice: string, apiKey: string, speed = 1): Promise<ArrayBuffer> {
  const resp = await fetch(TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: text,
      voice: fullVoice(voice),
      response_format: 'mp3',
      sample_rate: 44100,
      stream: true,
      speed,
      gain: 0,
    }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`tts http ${resp.status}: ${body.slice(0, 200)}`)
  }
  return resp.arrayBuffer()
}

// ---------- 音色克隆 ----------

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

// 启动即注册音色名单,configStore 清洗配置时据此校正非法音色名。
// 自定义克隆音色(speech: 开头)是账号侧资源,单独放行不参与内置名单校正
registerVoiceIds([...VOICES.map((v) => v.id), '__custom__'])

let dirPromise: Promise<string> | null = null

/** 磁盘缓存文件数上限(每条 mp3 约几十~两百 KB,超限按 mtime 淘汰最旧) */
const MAX_CACHE_FILES = 500

/** 启动后静默清理一次:文件数超限删最旧,防缓存目录无界膨胀 */
async function pruneCacheDir(dir: string): Promise<void> {
  try {
    const entries = await readDir(dir)
    const files: string[] = []
    for (const e of entries) {
      if (e.isFile && e.name?.endsWith('.mp3.txt')) files.push(await join(dir, e.name))
    }
    if (files.length <= MAX_CACHE_FILES) return
    const withTime = await Promise.all(
      files.map(async (f) => ({ f, t: (await stat(f)).mtime?.getTime() ?? 0 })),
    )
    const excess = withTime.sort((a, b) => a.t - b.t).slice(0, files.length - MAX_CACHE_FILES)
    for (const { f } of excess) await remove(f).catch(() => {})
  } catch {
    // 清理失败不影响合成主流程
  }
}

/** appData/data/audio-cache 目录(懒创建) */
function cacheDir(): Promise<string> {
  if (!dirPromise) {
    dirPromise = (async () => {
      const base = await appDataDir()
      const dir = await join(base, 'data', 'audio-cache')
      if (!(await exists(dir))) await mkdir(dir, { recursive: true })
      void pruneCacheDir(dir)
      return dir
    })()
  }
  return dirPromise
}

/** hash(文本+音色) → blobUrl;上限 200 条,满了从头清(演出语音重复率低,够用) */
const memory = new Map<string, string>()
/** 在飞合成去重:同一 hash 只发一次请求 */
const inflight = new Map<string, Promise<string>>()

async function hashOf(text: string, voice: string, speed = 1): Promise<string> {
  const data = new TextEncoder().encode(`${voice}|${speed}|${text}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function remember(hash: string, bytes: ArrayBuffer): string {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
  memory.set(hash, url)
  if (memory.size > 200) {
    const oldest = memory.keys().next().value
    if (oldest !== undefined) {
      const u = memory.get(oldest)
      memory.delete(oldest)
      if (u) URL.revokeObjectURL(u)
    }
  }
  return url
}

/** 确保该句已合成并缓存,返回 blobUrl。失败抛错由调用方静默 */
async function ensure(text: string, voice: string, apiKey: string, speed = 1): Promise<string> {
  const hash = await hashOf(text, voice, speed)
  const hit = memory.get(hash)
  if (hit) return hit

  const existing = inflight.get(hash)
  if (existing) return existing

  const task = (async () => {
    if (!inTauri) {
      // 浏览器预览:无文件系统,只用内存缓存
      return remember(hash, await synth(text, voice, apiKey, speed))
    }
    const file = await join(await cacheDir(), `${hash}.mp3.txt`)
    if (await exists(file)) {
      // 磁盘命中:mp3 以 base64 文本落盘(规避插件二进制读取接口差异),读回还原
      const bin = atob(await readTextFile(file))
      const bytes = new ArrayBuffer(bin.length)
      const arr = new Uint8Array(bytes)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      return remember(hash, bytes)
    }
    const buf = await synth(text, voice, apiKey, speed)
    // base64 落盘
    const u8 = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
    }
    await writeTextFile(file, btoa(s))
    return remember(hash, buf)
  })()
  inflight.set(hash, task)
  try {
    return await task
  } finally {
    inflight.delete(hash)
  }
}

// ---------- 播放 ----------

let current: HTMLAudioElement | null = null
/** 当前语音的序号:新 speak 递增,过期完成的播放直接丢弃 */
let epoch = 0

/** 缺 key 只提示一次,避免每句台词都刷 */
let warnedNoKey = false

/** 说一句:停掉当前语音,起播这句。fire-and-forget,失败静默 */
export function speak(speaker: Speaker, text: string, delivery?: string): void {
  // 进函数即领序号:若先发的句子合成慢,完成时序号已落后,不会反向覆盖新句
  const my = ++epoch
  void (async () => {
    try {
      const cfg = await getConfig()
      if (!cfg.voice.enabled) return
      if (!cfg.voice.apiKey.trim()) {
        if (!warnedNoKey) {
          warnedNoKey = true
          console.warn('[tts] 未配置语音 API Key(设置 → 角色语音),本次无声')
        }
        return
      }
      const voice = cfg.voice[speaker]
      const url = await ensure(text, voice, cfg.voice.apiKey, deliverySpeed(delivery))
      // 等待合成期间来了新句/停止指令 → 不起播
      if (my !== epoch) return
      current?.pause()
      const audio = new Audio(url)
      current = audio
      audio.onended = () => {
        if (current === audio) current = null
      }
      try {
        await audio.play()
      } catch (err) {
        console.warn('[tts] play 被拒(自动播放策略?)', err)
        return
      }
      // 播放起手后又来了新句,丢弃本次播放
      if (my !== epoch) audio.pause()
    } catch (e) {
      console.warn('[tts] 语音合成/播放失败(静默降级)', e)
    }
  })()
}

/** 只合成不播放:预合成下一句,开播即有声 */
export function prefetchVoice(speaker: Speaker, text: string, delivery?: string): void {
  void (async () => {
    try {
      const cfg = await getConfig()
      if (!cfg.voice.enabled || !cfg.voice.apiKey.trim()) return
      await ensure(text, cfg.voice[speaker], cfg.voice.apiKey, deliverySpeed(delivery))
    } catch {
      // 静默
    }
  })()
}

/** 停止当前语音(演出停止/切换时) */
export function stopSpeaking(): void {
  epoch++
  current?.pause()
  current = null
}
