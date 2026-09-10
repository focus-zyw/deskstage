// AudioWorklet 环形缓冲播放器 + 主线程背压泵。
// 链路:HTTP 分片 → 主线程转换/起播门(攒 250ms)→ 高低水位投递
//   (worklet 在途 ≥1.5s 暂停投递,等消费回报后继续;环形缓冲 2s 永不满)
//   → worklet 播放。任何环节都不丢采样;
// finish 在全部待发数据进入 worklet 后才发出;drained = finished 且缓冲播空。
// 首帧真实输出时回一条 started(供 UI 与声音同步);worklet 代码内联经 Blob URL 加载,
// 避免打包资源路径问题。无 worklet 的环境由服务层降级为整段 <audio>,这里只管增量路径。
import type { AudioStreamMeta } from './types'
import { parseWavFront } from './wav'

/** worklet:单声道环形缓冲。主线程 postMessage 推 Float32 块(背压协议保证永不溢出);
 *  首帧输出回 started,每 4096 帧(约 90ms@44.1k)回一次 played 消费进度,
 *  finish 且播空后回 drained——三者都带会话 id,防止旧会话消息串扰 */
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
    this.played = 0
    this.reported = 0
    this.reportedStart = false
    this.port.onmessage = (e) => {
      const d = e.data || {}
      if (d.type === 'enqueue' && d.data) {
        const ch = d.data
        for (let i = 0; i < ch.length; i++) {
          this.ring[this.write] = ch[i]
          this.write = (this.write + 1) % this.cap
        }
        this.filled += ch.length
      } else if (d.type === 'finish') {
        this.finished = true
      } else if (d.type === 'clear') {
        this.read = 0; this.write = 0; this.filled = 0; this.finished = false
      } else if (d.type === 'init') {
        this.id = d.id || 0
        this.read = 0; this.write = 0; this.filled = 0; this.finished = false
        this.played = 0; this.reported = 0; this.reportedStart = false
      }
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0][0]
    let playedNow = 0
    for (let i = 0; i < out.length; i++) {
      if (this.filled > 0) {
        out[i] = this.ring[this.read]
        this.read = (this.read + 1) % this.cap
        this.filled--
        playedNow++
      } else {
        out[i] = 0
      }
    }
    this.played += playedNow
    if (playedNow > 0 && !this.reportedStart) {
      this.reportedStart = true
      this.port.postMessage({ type: 'started', id: this.id })
    }
    if (this.played - this.reported >= 4096) {
      this.reported = this.played
      this.port.postMessage({ type: 'status', id: this.id, played: this.played })
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

/** 起播前主线程缓冲秒数:太小(≤0.15)时网络突发会造成早期欠载噼啪声,
 *  0.25s 在首声延迟与播放平滑之间取平衡 */
const START_LATENCY_S = 0.25

/** worklet 在途帧高水位(秒):达到即暂停投递等消费回报。低于环形缓冲容量(2s),
 *  因此任何时刻都不会溢出丢采样 */
const HIGH_WATER_S = 1.5

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
  /** 推入一段原始音频字节(wav 流自动剥头;pcm 流按 meta 直接解读)。
   *  有背压:在途达到高水位时等待 worklet 消费,绝不丢采样 */
  push(chunk: Uint8Array): Promise<void>
  /** 源流结束:待发数据全部进入 worklet 后才发 finish;缓冲播完后触发 onEnded */
  finish(): Promise<void>
  /** 立即停止并丢弃未播数据(用户取消/抢占) */
  stop(): void
}

/** 会话序号:worklet 节点跨会话复用,消息靠 id 区分归属 */
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

  /** 开一场播放。失败抛错由服务层降级为整段 <audio> 路径。
   *  onFirstOut = 首帧声音真正输出(worklet 首次消费到数据) */
  async session(
    meta: AudioStreamMeta,
    gainDb: number,
    onEnded: () => void,
    onFirstOut: () => void,
  ): Promise<StreamSession> {
    const node = await this.ensureRuntime(meta.sampleRate, gainDb)
    const id = ++SESSION_SEQ
    this.active = true

    // wav 头解析:首块(可能跨多个网络分片)攒够后剥头,余量直接当 PCM
    let front: Uint8Array | null = meta.format === 'wav' ? new Uint8Array(0) : null
    let layout: { channels: number } | null = meta.format === 'wav' ? null : { channels: meta.channels }
    let started = false // 起播门已开(主线程攒够 START_LATENCY,开始向 worklet 投递)
    let sourceDone = false
    let stopped = false
    let receivedFrames = 0
    let accepted = 0 // 已投递进 worklet 的帧数
    let playedReported = 0 // worklet 最近回报的已播帧数
    let releaseWait: (() => void) | null = null
    const rate = meta.sampleRate
    const highWater = Math.round(HIGH_WATER_S * rate)
    const fadeTotal = Math.round(0.01 * rate) // 起播 10ms 线性淡入,抹掉编码器首帧瞬态
    let fadeInLeft = fadeTotal
    // Int16 采样跨分片对齐:网络分片长度不保证偶数,奇数尾字节必须留给下一分片,
    // 否则丢半采样 + 后续全部错位一字节,听感为持续电流噪声
    let carry: Uint8Array | null = null
    /** 待投递队列:起播门未开/水位已满时在此排队 */
    const queue: Float32Array[] = []

    const waitConsumed = () =>
      new Promise<void>((resolve) => {
        releaseWait = resolve
      })

    node.port.postMessage({ type: 'clear' })
    node.port.postMessage({ type: 'init', id })
    node.port.onmessage = (e) => {
      const d = e.data as { type?: string; id?: number; played?: number }
      if (!d || d.id !== id) return // 旧会话的迟到消息
      if (d.type === 'status') {
        playedReported = d.played ?? playedReported
        const w = releaseWait
        releaseWait = null
        w?.()
      } else if (d.type === 'started') {
        onFirstOut()
      } else if (d.type === 'drained') {
        this.active = false
        onEnded()
      }
    }

    /** 投递循环:清空队列;水位满则等消费回报。起播门未开时整体不出手 */
    const feedLoop = async (): Promise<void> => {
      if (stopped) return
      if (!started && !sourceDone && receivedFrames < START_LATENCY_S * rate) return
      started = true
      while (queue.length > 0) {
        if (stopped) return
        if (accepted - playedReported >= highWater) {
          await waitConsumed()
          continue
        }
        const f = queue.shift()!
        node.port.postMessage({ type: 'enqueue', data: f }, [f.buffer])
        accepted += f.length
      }
    }

    // 串行化所有投递任务,保证 push/finish 的先后语义
    let tail: Promise<void> = Promise.resolve()
    const chain = (task: () => Promise<void>): Promise<void> => {
      tail = tail.then(task, task)
      return tail
    }

    return {
      push: (chunk: Uint8Array): Promise<void> => {
        if (stopped) return Promise.resolve() // 被顶掉后旧流残余分片,直接丢
        try {
          if (front) {
            const merged = new Uint8Array(front.length + chunk.length)
            merged.set(front, 0)
            merged.set(chunk, front.length)
            const parsed = parseWavFront(merged)
            if (!parsed) {
              // 头还没攒够,继续等;64KB 仍解析不出说明对方根本没按 wav 返回,报错走降级
              if (merged.length > 65536) throw new Error('tts 流不是 wav 格式')
              front = merged
              return Promise.resolve()
            }
            if (parsed.sampleRate !== rate) {
              console.warn(`[tts] wav 头采样率 ${parsed.sampleRate} 与预期 ${rate} 不符,按头播放`)
            }
            front = null
            layout = { channels: parsed.channels }
            chunk = merged.subarray(parsed.pcmOffset)
            if (chunk.length === 0) return Promise.resolve()
          }
          // 采样对齐:接上上片落下的尾字节;本片若又是奇数,留尾字节给下片
          let bytes = chunk
          if (carry) {
            const merged = new Uint8Array(carry.length + bytes.length)
            merged.set(carry, 0)
            merged.set(bytes, carry.length)
            bytes = merged
            carry = null
          }
          if (bytes.length % 2 !== 0) {
            carry = bytes.slice(bytes.length - 1)
            bytes = bytes.subarray(0, bytes.length - 1)
          }
          if (bytes.length > 0) {
            const f32 = int16ToFloat32(bytes, layout!.channels)
            if (fadeInLeft > 0) {
              const n = Math.min(f32.length, fadeInLeft)
              for (let i = 0; i < n; i++) f32[i] *= (fadeTotal - fadeInLeft + i) / fadeTotal
              fadeInLeft -= n
            }
            receivedFrames += f32.length
            queue.push(f32)
          }
        } catch (err) {
          return Promise.reject(err)
        }
        return chain(feedLoop)
      },
      finish: (): Promise<void> => {
        if (stopped) return Promise.resolve()
        sourceDone = true
        return chain(async () => {
          await feedLoop() // 起播门放行 + 清空队列:全部待发数据进入 worklet
          if (stopped) return
          node.port.postMessage({ type: 'finish' })
        })
      },
      stop: () => {
        if (stopped) return
        stopped = true
        queue.length = 0
        node.port.postMessage({ type: 'clear' })
        const w = releaseWait // 放行可能卡在水位等待的投递循环,让其退出
        releaseWait = null
        w?.()
        this.active = false
      },
    }
  }
}

export const streamPlayer = new AudioStreamPlayer()
