// AudioWorklet 环形缓冲播放器:音频块到达即入队,首段攒够 ~180ms 起播——
// 首块到达即出声,不等整句下载完。worklet 代码内联为字符串经 Blob URL 加载,
// 避免打包资源路径问题。无 worklet 的环境由服务层降级为整段 <audio>,这里只管增量路径。
import type { AudioStreamMeta } from './types'
import { parseWavFront } from './wav'

/** worklet:单声道环形缓冲。主线程 postMessage 推 Float32 块;
 *  会话经 init 带 id 戳(节点跨会话复用,旧会话迟到的 drained 不得误伤新会话);
 *  finish 且播空后回一条带 id 的 drained,主线程据此触发 onEnded */
const WORKLET_SRC = `
class PcmRingPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.cap = sampleRate * 2
    this.ring = new Float32Array(this.cap)
    this.read = 0
    this.write = 0
    this.filled = 0
    this.finished = false
    this.id = 0
    this.port.onmessage = (e) => {
      const d = e.data || {}
      if (d.type === 'enqueue' && d.data) {
        const ch = d.data
        for (let i = 0; i < ch.length && this.filled < this.cap; i++) {
          this.ring[this.write] = ch[i]
          this.write = (this.write + 1) % this.cap
          this.filled++
        }
      } else if (d.type === 'finish') {
        this.finished = true
      } else if (d.type === 'clear') {
        this.read = 0; this.write = 0; this.filled = 0; this.finished = false
      } else if (d.type === 'init') {
        this.id = d.id || 0
        this.read = 0; this.write = 0; this.filled = 0; this.finished = false
      }
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0][0]
    for (let i = 0; i < out.length; i++) {
      if (this.filled > 0) {
        out[i] = this.ring[this.read]
        this.read = (this.read + 1) % this.cap
        this.filled--
      } else {
        out[i] = 0
      }
    }
    if (this.finished && this.filled === 0) {
      this.finished = false
      this.port.postMessage({ type: 'drained', id: this.id })
    }
    return true
  }
}
registerProcessor('pcm-ring-player', PcmRingPlayer)
`

/** 起播前缓冲秒数:吸收网络抖动,又不明显拖慢首声 */
const START_LATENCY_S = 0.18

/** Int16LE 字节 → Float32 单声道(多声道时平均下混) */
function int16ToFloat32(bytes: Uint8Array, channels: number): Float32Array {
  const samples = Math.floor(bytes.length / 2)
  const frames = channels > 1 ? Math.floor(samples / channels) : samples
  const out = new Float32Array(frames)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < frames; i++) {
    if (channels > 1) {
      let acc = 0
      for (let c = 0; c < channels; c++) acc += dv.getInt16((i * channels + c) * 2, true)
      out[i] = acc / channels / 32768
    } else {
      out[i] = dv.getInt16(i * 2, true) / 32768
    }
  }
  return out
}

export interface StreamSession {
  /** 推入一段原始音频字节(wav 流自动剥头;pcm 流按 meta 直接解读);stop 后为 no-op */
  push(chunk: Uint8Array): void
  /** 源流结束:缓冲播完后触发 onEnded */
  finish(): void
  /** 立即停止并丢弃未播数据(新句抢占/演出停止) */
  stop(): void
}

/** 会话序号:worklet 节点复用,drained 消息靠 id 区分归属 */
let SESSION_SEQ = 0

class AudioStreamPlayer {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private gain: GainNode | null = null
  private active = false

  /** 仲裁用:是否有一段语音在播(或缓冲待播) */
  isPlaying(): boolean {
    return this.active
  }

  /** 懒建/按采样率重建播放管线(供应商采样率不同,如硅基流动 44100 / MiniMax 32000) */
  private async ensureRuntime(sampleRate: number, gainDb: number): Promise<AudioWorkletNode> {
    if (this.ctx && this.ctx.sampleRate !== sampleRate) {
      await this.ctx.close().catch(() => {})
      this.ctx = null
      this.node = null
      this.gain = null
    }
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate })
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
      try {
        await this.ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
    }
    if (!this.node) {
      this.node = new AudioWorkletNode(this.ctx, 'pcm-ring-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      this.node.connect(this.gain!)
    }
    this.gain!.gain.value = 10 ** (gainDb / 20)
    await this.ctx.resume().catch(() => {})
    return this.node
  }

  /** 开一场播放。失败抛错由服务层降级为整段 <audio> 路径 */
  async session(
    meta: AudioStreamMeta,
    gainDb: number,
    onEnded: () => void,
  ): Promise<StreamSession> {
    const node = await this.ensureRuntime(meta.sampleRate, gainDb)
    const id = ++SESSION_SEQ
    this.active = true

    // wav 头解析:首块(可能跨多个网络分片)攒够后剥头,余量直接当 PCM
    let front: Uint8Array | null = meta.format === 'wav' ? new Uint8Array(0) : null
    let layout: { channels: number } | null = meta.format === 'wav' ? null : { channels: meta.channels }
    let started = false
    let sourceDone = false
    let stopped = false
    let receivedFrames = 0
    const pending: Float32Array[] = []
    const rate = meta.sampleRate

    const feed = (f32: Float32Array) => {
      if (!started) pending.push(f32)
      else node.port.postMessage({ type: 'enqueue', data: f32 }, [f32.buffer])
    }
    const startIfReady = () => {
      if (started || (!sourceDone && receivedFrames < START_LATENCY_S * rate)) return
      started = true
      for (const f of pending) node.port.postMessage({ type: 'enqueue', data: f }, [f.buffer])
      pending.length = 0
    }
    node.port.postMessage({ type: 'clear' })
    node.port.postMessage({ type: 'init', id })
    node.port.onmessage = (e) => {
      const d = e.data as { type?: string; id?: number }
      if (d?.type === 'drained' && d.id === id) {
        this.active = false
        onEnded()
      }
    }

    return {
      push: (chunk: Uint8Array) => {
        if (stopped) return // 被顶掉后旧流残余分片,直接丢
        if (front) {
          const merged = new Uint8Array(front.length + chunk.length)
          merged.set(front, 0)
          merged.set(chunk, front.length)
          const parsed = parseWavFront(merged)
          if (!parsed) {
            // 头还没攒够,继续等;64KB 仍解析不出说明对方根本没按 wav 返回,报错走降级
            if (merged.length > 65536) throw new Error('tts 流不是 wav 格式')
            front = merged
            return
          }
          if (parsed.sampleRate !== rate) {
            console.warn(`[tts] wav 头采样率 ${parsed.sampleRate} 与预期 ${rate} 不符,按头播放`)
          }
          front = null
          layout = { channels: parsed.channels }
          chunk = merged.subarray(parsed.pcmOffset)
          if (chunk.length === 0) return
        }
        const f32 = int16ToFloat32(chunk, layout!.channels)
        receivedFrames += f32.length
        feed(f32)
        startIfReady()
      },
      finish: () => {
        if (stopped) return
        sourceDone = true
        // 极短句/空流:直接转 started 把余量全部入队,worklet 播空(或本来为空)后回 drained
        if (!started) {
          started = true
          for (const f of pending) node.port.postMessage({ type: 'enqueue', data: f }, [f.buffer])
          pending.length = 0
        }
        node.port.postMessage({ type: 'finish' })
      },
      stop: () => {
        if (stopped) return
        stopped = true
        node.port.postMessage({ type: 'clear' })
        this.active = false
      },
    }
  }
}

export const streamPlayer = new AudioStreamPlayer()
