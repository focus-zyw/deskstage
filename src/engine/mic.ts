// 麦克风客户端:Rust 侧 WASAPI 采集的 16k/mono/i16 裸 PCM 流经 Channel 到这里。
// 职责只有三件:启停(owner 仲裁在 Rust)、连续分帧(任意长度字节块 → 480 样本帧,
// 跨包不丢不重)、电平(rms→dBFS)。语音判定在 vad.ts,本模块不做任何 VAD 逻辑。
//
// 为什么 Rust 采集而不用 webview getUserMedia:WebView2 的媒体权限弹窗不可预授权、
// 拒绝后难恢复(tauri#14753/#5042),对免激活桌面形态不可接受;
// 采集侧(src-tauri/src/mic_capture.rs)与所有权语义见 docs/实时语音对话设计方案.md。
// 导入期无副作用,可被单测加载(分帧器是纯函数)。
import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { inTauri } from '../storage/configStore'

export const MIC_SAMPLE_RATE = 16000
/** VAD 标准帧长:480 样本 = 30ms。迟滞参数(起/止帧数)只在帧长恒定时才有意义 */
export const FRAME_SAMPLES = 480

export type MicOwner = 'voice-session' | 'settings-preview'

export interface MicDevice {
  id: string
  name: string
  default: boolean
}

export interface MicSession {
  /** 幂等;正常停止不触发 onEnded */
  stop(): Promise<void>
}

export interface MicStartOptions {
  owner: MicOwner
  /** 缺省 = 系统默认麦克风 */
  deviceId?: string
  onFrame(pcm: Int16Array): void
  /** Rust 侧异常结束(设备拔出/休眠/隐私开关/通道断开);正常 stop 不回调 */
  onEnded?(reason: string): void
}

export function listMics(): Promise<MicDevice[]> {
  return invoke<MicDevice[]>('list_mic_devices')
}

/** 帧电平,dBFS(满幅 0dB);静音/空帧钳到 -120 作为安全下界 */
export function rmsDbfs(pcm: Int16Array): number {
  if (pcm.length === 0) return -120
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768
    sum += v * v
  }
  const rms = Math.sqrt(sum / pcm.length)
  return rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120
}

/** Channel 载荷 → 字节:与 endpointProxy 的归一化同款(Raw 二进制的文档形态是
 *  ArrayBuffer,数组/base64 是序列化兜底) */
function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (Array.isArray(raw)) return new Uint8Array(raw as number[])
  if (typeof raw === 'string') {
    const bin = atob(raw)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array(0)
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** 连续分帧器:Rust 推来的字节块长度任意(WASAPI 包大小决定),这里维持余数缓存,
 *  稳定切出 FRAME_SAMPLES 样本的小端 Int16 帧。没有它,90ms 的"起声"参数会被
 *  包边界量化成 ±300ms,迟滞窗口失去意义。会话结束时不冲刷:不足一帧的余数丢弃。 */
export function createPcmFramer(onFrame: (pcm: Int16Array) => void): {
  push(bytes: Uint8Array): void
} {
  let rest: Uint8Array = new Uint8Array(0)
  const frameBytes = FRAME_SAMPLES * 2
  return {
    push(bytes) {
      if (bytes.length === 0) return
      const all = rest.length > 0 ? concatBytes(rest, bytes) : bytes
      const frames = Math.floor(all.length / frameBytes)
      for (let f = 0; f < frames; f++) {
        const pcm = new Int16Array(FRAME_SAMPLES)
        const view = new DataView(all.buffer, all.byteOffset + f * frameBytes, frameBytes)
        for (let i = 0; i < FRAME_SAMPLES; i++) pcm[i] = view.getInt16(i * 2, true)
        onFrame(pcm)
      }
      rest = all.slice(frames * frameBytes)
    },
  }
}

// ---------- 会话 ----------

let unlistenEnded: (() => void) | null = null
const endedHandlers = new Map<MicOwner, (reason: string) => void>()

async function ensureEndedListener(): Promise<void> {
  if (unlistenEnded || !inTauri) return
  unlistenEnded = await listen<{ owner: string; reason: string }>('mic-ended', (e) => {
    endedHandlers.get(e.payload.owner as MicOwner)?.(e.payload.reason)
  })
}

/** 开始采集并订阅 30ms 帧。同一时刻同一 owner 只有一路(mic_start 重复调用 =
 *  Rust 侧换设备重启);'voice-session' 持有时设置窗的 'settings-preview' 启动会被拒绝。 */
export async function startMic(opts: MicStartOptions): Promise<MicSession> {
  await ensureEndedListener()
  const framer = createPcmFramer(opts.onFrame)
  const channel = new Channel<unknown>()
  channel.onmessage = (raw) => framer.push(toBytes(raw))
  await invoke('mic_start', {
    owner: opts.owner,
    deviceId: opts.deviceId ?? null,
    onChunk: channel,
  })
  const onEnded = (reason: string) => opts.onEnded?.(reason)
  endedHandlers.set(opts.owner, onEnded)
  return {
    stop: async () => {
      if (endedHandlers.get(opts.owner) === onEnded) endedHandlers.delete(opts.owner)
      // Rust 侧幂等;invoke 失败(会话已自行结束)不向外抛
      await invoke('mic_stop').catch(() => {})
    },
  }
}
