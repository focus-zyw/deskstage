// 角色语音服务:供应商路由 + 两级缓存 + 通道仲裁 + 流式播放。
// 请求走 tauri-plugin-http(Rust 侧发,无 CORS),插件内部已把响应体做成 ReadableStream,
// 前端 getReader() 逐块喂给 AudioWorklet——首块到达即出声,不再整句下载完才播。
// 原则:语音失败永不影响演出 —— 所有错误静默降级为无语音,气泡照常走。
// 对外 API 与旧版一致(speak/prefetchVoice/stopSpeaking/cloneVoice/listCustomVoices),
// App.tsx、TranslationPanel 的 import 无需改动。
import { deliverySpeed, normalizeForSpeech, type Speaker } from '../../performer/dialogSchema'
import {
  getConfig,
  inTauri,
  registerVoiceIds,
  type AppConfig,
  type TtsProviderId,
} from '../../storage/configStore'
import { isLateNight } from '../timeAware'
import { CACHE_VERSION, diskGet, diskPut, hashOf, inflight, memGet, memPut } from './cache'
import { gptsovitsProvider } from './gptsovits'
import { localProvider } from './local'
import { minimaxProvider, MINIMAX_VOICES } from './minimax'
import { streamPlayer, type StreamSession } from './player'
import {
  SILICONFLOW_VOICES,
  siliconflowProvider,
} from './siliconflow'
import type { AudioStreamMeta, SynthRequest, TtsCredentials, TtsProvider, TtsStream } from './types'
import { pcmToWav } from './wav'
import { postProcessWav } from './speechPostProcessor'

export { cloneVoice, listCustomVoices } from './siliconflow'
export type { ClonedVoice } from './siliconflow'

/** 设置页可选的供应商(local 未接入,不列出) */
export const PROVIDER_OPTIONS: { id: TtsProviderId; label: string }[] = [
  { id: siliconflowProvider.id, label: siliconflowProvider.label },
  { id: minimaxProvider.id, label: minimaxProvider.label },
  { id: gptsovitsProvider.id, label: gptsovitsProvider.label },
]

export function providerById(id: TtsProviderId): TtsProvider {
  if (id === 'minimax') return minimaxProvider
  if (id === 'gptsovits') return gptsovitsProvider
  if (id === 'local') return localProvider
  return siliconflowProvider
}

// 启动即注册各供应商音色名单,configStore 清洗配置时据此校正非法音色名。
// 克隆音色(speech: 开头)是账号侧资源,清洗时单独放行,不进名单;
// gptsovits 不注册——它的音色表是用户配置的,清洗时按当次配置的表校正。
registerVoiceIds('siliconflow', [...SILICONFLOW_VOICES.map((v) => v.id), '__custom__'])
registerVoiceIds('minimax', MINIMAX_VOICES.map((v) => v.id))

// ---------- 通道仲裁(备忘提醒掐掉演出包袱句的历史问题) ----------

/** TTS 通道:低优先级不得打断高优先级在播;同级之间靠 epoch 抢占(后到者胜)。
 *  stream = 主播模式的弹幕回复(权重同演出);voice = 实时语音对话的回复
 *  (权重同 chat:语音回复本质是聊天回复,不得压过提醒/工具播报;
 *  句间排队由调用方按 ended 顺序喂,打断走 SpeechHandle.stop 而非全局停声) */
export type TtsChannel = 'chat' | 'performance' | 'utility' | 'proactive' | 'stream' | 'voice'

const CHANNEL_PRIORITY: Record<TtsChannel, number> = {
  chat: 0,
  voice: 0,
  performance: 1,
  stream: 1,
  utility: 2,
  proactive: 3,
}

let epoch = 0
/** 已结束(播完/被打断/失败/静音)的最大 epoch */
let endedEpoch = 0
/** 已真正出声(首帧音频输出)的最大 epoch */
let audibleEpoch = 0
const endWaiters = new Set<{ at: number; resolve: () => void }>()
const startWaiters = new Set<{ at: number; resolve: (v: 'audible' | 'silent') => void }>()

function markEnded(my: number): void {
  if (my > endedEpoch) endedEpoch = my
  flushWaiters()
}

function markAudible(my: number): void {
  if (my > audibleEpoch) audibleEpoch = my
  flushWaiters()
}

function flushWaiters(): void {
  for (const w of endWaiters) {
    // 被更新的句抢占(epoch 前移)或自身已结束,都算"这句完了"
    if (w.at <= endedEpoch || w.at < epoch) {
      endWaiters.delete(w)
      w.resolve()
    }
  }
  for (const s of startWaiters) {
    if (audibleEpoch >= s.at) {
      startWaiters.delete(s)
      s.resolve('audible')
    } else if (s.at <= endedEpoch || s.at < epoch) {
      // 这句无声收场(静音/失败/被抢占前没出声)
      startWaiters.delete(s)
      s.resolve('silent')
    }
  }
}

/** 等待某句语音结束:播完/被新句抢占/停止 都会放行 */
function waitSpokenEnd(at: number): Promise<void> {
  return new Promise((resolve) => {
    endWaiters.add({ at, resolve })
    flushWaiters()
  })
}

/** 等待某句的首帧声音输出;无声收场则得 'silent' */
function waitAudible(at: number): Promise<'audible' | 'silent'> {
  return new Promise((resolve) => {
    startWaiters.add({ at, resolve })
    flushWaiters()
  })
}
let activeChannel: TtsChannel | null = null
let activeSession: StreamSession | null = null
let currentEl: HTMLAudioElement | null = null
/** 低优先级被打断/缺配置的提示只发一次,避免刷控制台 */
let warnedDemoted = false
const warnedSetup = new Set<string>()

function isBusy(): boolean {
  return !!activeSession || !!(currentEl && !currentEl.paused)
}

function clearActive(): void {
  activeSession?.stop()
  activeSession = null
  currentEl?.pause()
  currentEl = null
  activeChannel = null
}

// ---------- 单句合成描述 ----------

interface LineSpec {
  provider: TtsProvider
  creds: TtsCredentials
  voiceId: string
  speed: number
  delivery?: string
  text: string
  /** 缓存键:供应商|模型|音色|语速|语气|缓存版本|文本(gain 在播放端,不进键) */
  hash: string
}

async function resolveLine(
  cfg: AppConfig,
  speaker: Speaker,
  text: string,
  delivery?: string,
): Promise<LineSpec | null> {
  const v = cfg.voice
  const provider = providerById(v.provider)
  const setup = provider.missingSetup(cfg)
  if (setup) {
    if (!warnedSetup.has(setup)) {
      warnedSetup.add(setup)
      console.warn(`[tts] ${setup},本次无声`)
    }
    return null
  }
  const creds: TtsCredentials = {
    apiKey: provider.id === 'minimax' ? v.minimax.apiKey : v.apiKey,
    groupId: v.minimax.groupId,
    model: v.minimax.model,
    emotionHints: v.emotionHints,
    ...(provider.id === 'gptsovits'
      ? {
          gptsovits: {
            url: v.gptsovits.url,
            textLang: v.gptsovits.textLang,
            streamMode: v.gptsovits.streamMode,
            voices: v.gptsovits.voices,
          },
        }
      : {}),
  }
  const asg = v.assignments[provider.id]
  const voiceId = asg[speaker] || provider.defaultVoiceId?.(cfg) || provider.voices[0]?.id || ''
  const speed = deliverySpeed(delivery)
  // 朗读归一化在进哈希前做:缓存键与实际发给供应商的文本保持一致
  const speechText = normalizeForSpeech(text)
  const hash = await hashOf([
    provider.id,
    provider.modelId(cfg),
    voiceId,
    String(speed),
    delivery ?? 'normal',
    String(CACHE_VERSION),
    speechText,
  ])
  return { provider, creds, voiceId, speed, delivery, text: speechText, hash }
}

function requestOf(spec: LineSpec): SynthRequest {
  return {
    text: spec.text,
    voice: spec.voiceId,
    speed: spec.speed,
    delivery: spec.delivery,
    sampleRate: 44100,
  }
}

// ---------- 流式拉取 ----------

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** 单次读取的停滞保护:连接不断但数据不来时,读操作会永久挂起,
 *  拖住"在播"状态影响通道仲裁。超时抛错走静默降级 */
const READ_TIMEOUT_MS = 20_000

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer = 0
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('tts 流读取超时')), READ_TIMEOUT_MS)
    }),
  ]).finally(() => window.clearTimeout(timer))
}

/** 拉完整流;session 非空时边拉边播。返回完整 wav 字节(裸 PCM 会补上头)。
 *  my 传 epoch 快照,被新句顶掉(epoch 变了)返回 null 且不入缓存;传 null = 永不中断(预取) */
async function drainStream(
  stream: TtsStream,
  meta: AudioStreamMeta,
  session: StreamSession | null,
  my: number | null,
): Promise<ArrayBuffer | null> {
  const reader = stream.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await readChunk(reader)
      if (done) break
      if (value) {
        parts.push(value)
        total += value.length
        // 背压:缓冲达高水位时 push 会等待 worklet 消费,HTTP 读取随之暂停,不丢采样
        if (session) await session.push(value)
      }
      if (my !== null && my !== epoch) {
        void reader.cancel().catch(() => {})
        session?.stop()
        return null
      }
    }
  } catch (err) {
    void reader.cancel().catch(() => {})
    throw err
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 仍有在途读取,交给 GC
    }
  }
  if (session) await session.finish() // 待发数据全部进入 worklet 后才发 finish
  const raw = concatBytes(parts, total)
  if (meta.format === 'wav') return raw.buffer as ArrayBuffer // concatBytes 新建,buffer 即完整 wav
  return pcmToWav(raw, meta.sampleRate, meta.channels, meta.bitsPerSample)
}

/** 统一后处理(裁首尾静音/响度归一/峰值限制)后写入两级缓存;返回处理后的 wav */
function processAndCache(hash: string, full: ArrayBuffer): ArrayBuffer {
  const { wav } = postProcessWav(full)
  memPut(hash, wav)
  void diskPut(hash, new Uint8Array(wav))
  return wav
}

/** 合成并缓存(不播放,预取/降级路径用);在飞去重 */
function ensureCached(spec: LineSpec): Promise<ArrayBuffer> {
  const hit = memGet(spec.hash)
  if (hit) return Promise.resolve(hit)
  const running = inflight.get(spec.hash)
  if (running) return running
  const task = (async () => {
    const disk = await diskGet(spec.hash) // 磁盘命中顺手进内存层
    if (disk) return disk
    const stream = await spec.provider.synthesizeStream(requestOf(spec), spec.creds)
    const full = await drainStream(stream, stream.meta, null, null)
    if (!full) throw new Error('流提前结束')
    return processAndCache(spec.hash, full)
  })()
  inflight.set(spec.hash, task)
  void task.catch(() => {}).then(() => {
    if (inflight.get(spec.hash) === task) inflight.delete(spec.hash)
  })
  return task
}

// ---------- 播放 ----------

/** 整段播放(worklet 不可用/缓存命中路径):wav 字节 → blobUrl → <audio> */
function playViaElement(bytes: ArrayBuffer, my: number, channel: TtsChannel, gainDb: number): void {
  if (my !== epoch) return
  clearActive()
  activeChannel = channel
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
  const audio = new Audio(url)
  audio.volume = Math.min(1, 10 ** (gainDb / 20)) // 深夜档降音量在播放端做
  currentEl = audio
  // 首帧声音真正开始播放(非仅 play() 调用成功)
  audio.addEventListener('playing', () => markAudible(my), { once: true })
  audio.onended = () => {
    URL.revokeObjectURL(url)
    markEnded(my)
    if (currentEl === audio) {
      currentEl = null
      activeChannel = null
    }
  }
  audio.play()
    .then(() => {
      // 播放起手后又来了新句,丢弃本次播放
      if (my !== epoch) audio.pause()
    })
    .catch((err) => {
      console.warn('[tts] play 被拒(自动播放策略?)', err)
      markEnded(my)
      if (currentEl === audio) {
        currentEl = null
        activeChannel = null
      }
    })
}

/** 真流式的运行条件:Tauri(plugin-http 流)+ AudioWorklet */
function streamingSupported(): boolean {
  return inTauri && typeof AudioWorkletNode !== 'undefined'
}

/** 说一句:停掉当前语音,起播这句。fire-and-forget,失败静默。
 *  channel 决定仲裁优先级(chat<performance<utility<proactive);勿扰时全静。
 *  返回领取的句序号(配合 speakTracked/waitSpokenEnd);-1 = 被更高优先级压制,本轮无声 */
export function speak(speaker: Speaker, text: string, delivery?: string, channel: TtsChannel = 'chat'): number {
  // 低优先级不打断高优先级在播:直接丢弃本次请求(不改 epoch,不惊动当前语音)
  if (isBusy() && activeChannel && CHANNEL_PRIORITY[channel] < CHANNEL_PRIORITY[activeChannel]) {
    if (!warnedDemoted) {
      warnedDemoted = true
      console.warn(`[tts] ${channel} 请求被在播的 ${activeChannel} 压制,本次无声`)
    }
    return -1
  }
  // 进函数即领序号:若先发的句子合成慢,完成时序号已落后,不会反向覆盖新句
  const my = ++epoch
  flushWaiters()
  void (async () => {
    try {
      const cfg = await getConfig()
      if (cfg.dnd) {
        markEnded(my)
        return // 勿扰:全静(提醒走常驻卡片兜底)
      }
      if (!cfg.voice.enabled) {
        markEnded(my)
        return
      }
      const spec = await resolveLine(cfg, speaker, text, delivery)
      if (!spec || my !== epoch) {
        markEnded(my)
        return
      }
      const gainDb = isLateNight() ? -8 : 0

      // 缓存命中 / 预取在途:整段 wav 直接播,零流式开销(演出逐句主要走这里)
      const running = inflight.get(spec.hash)
      const cached = memGet(spec.hash) ?? (running ? undefined : await diskGet(spec.hash))
      if (cached) {
        playViaElement(cached, my, channel, gainDb)
        return
      }
      if (running) {
        playViaElement(await running, my, channel, gainDb)
        return
      }

      if (!streamingSupported()) {
        playViaElement(await ensureCached(spec), my, channel, gainDb)
        return
      }
      const t0 = Date.now()
      let stream: TtsStream
      try {
        stream = await spec.provider.synthesizeStream(requestOf(spec), spec.creds)
      } catch (e) {
        console.warn('[tts] 流式合成失败,降级整段', e)
        playViaElement(await ensureCached(spec), my, channel, gainDb)
        return
      }
      if (import.meta.env.DEV) console.info(`[tts] 流式首包 ${Date.now() - t0}ms(整句缓存未命中时首声随首包到达)`)
      if (my !== epoch) {
        void stream.body.cancel().catch(() => {})
        return
      }
      // 起播前一刻才掐上一句:首块到达即无缝接上
      clearActive()
      activeChannel = channel
      let sess: StreamSession | null = null
      try {
        sess = await streamPlayer.session(
          stream.meta,
          gainDb,
          () => {
            markEnded(my)
            if (sess && activeSession === sess && epoch === my) {
              activeSession = null
              activeChannel = null
            }
          },
          () => markAudible(my), // worklet 首帧真实输出
        )
      } catch (e) {
        console.warn('[tts] 流式播放初始化失败,降级整段', e)
        playViaElement(await ensureCached(spec), my, channel, gainDb)
        return
      }
      activeSession = sess
      let full: ArrayBuffer | null = null
      try {
        full = await drainStream(stream, stream.meta, sess, my)
      } catch (e) {
        console.warn('[tts] 流式播放中断(静默降级)', e)
        sess.stop()
        markEnded(my)
      }
      if (full) processAndCache(spec.hash, full)
      else if (activeSession === sess) {
        // 中断收尾:被顶掉时通道已归新 speak;异常中断时把"在播"状态归还
        activeSession = null
        markEnded(my)
        if (epoch === my) activeChannel = null
      }
    } catch (e) {
      console.warn('[tts] 语音合成/播放失败(静默降级)', e)
      markEnded(my)
    }
  })()
  return my
}

/** 只合成不播放:预合成下一句,开播即有声 */
export function prefetchVoice(speaker: Speaker, text: string, delivery?: string): void {
  void (async () => {
    try {
      const cfg = await getConfig()
      if (cfg.dnd) return
      if (!cfg.voice.enabled) return
      const spec = await resolveLine(cfg, speaker, text, delivery)
      if (!spec) return
      await ensureCached(spec)
    } catch {
      // 静默
    }
  })()
}

/** 停止当前语音(演出停止/切换时) */
export function stopSpeaking(): void {
  epoch++
  flushWaiters()
  clearActive()
}

/** 一句语音的生命周期句柄 */
export interface SpeechHandle {
  /** 首帧声音真正输出 → 'audible';本句无声收场(静音/失败/被抢占) → 'silent' */
  started: Promise<'audible' | 'silent'>
  /** 语音结束(播完/被打断/停止/失败),都会放行 */
  ended: Promise<void>
  /** 取消本句(仅当仍是当前句时生效):首声超时用,杜绝迟到语音突然插入 */
  stop(): void
}

/** 说一句并拿到完整生命周期句柄。返回 null = 被更高优先级压制,本轮无声。
 *  演出播放器用它做语音驱动的台词推进:气泡随首帧声音上屏,闭嘴随语音结束 */
export function speakTracked(speaker: Speaker, text: string, delivery?: string, channel: TtsChannel = 'chat'): SpeechHandle | null {
  const my = speak(speaker, text, delivery, channel)
  if (my < 0) return null
  return {
    started: waitAudible(my),
    ended: waitSpokenEnd(my),
    stop: () => {
      if (epoch === my) stopSpeaking()
    },
  }
}

/** 设置页试听:固定台词走完整链路(含情感指令),channel=utility,可与切换供应商配合做同台词 A/B */
export function previewSample(): void {
  speak('A', '哇,这一版效果好多了,就该这么改!', 'excited', 'utility')
}
