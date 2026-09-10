// 语音后处理:对合成完成的完整 WAV 统一收整,让缓存里每句音量一致、首尾干净。
// 处理顺序:裁首尾静音(保留 ~100ms 头 / ~150ms 尾,剩余静音 ≤250ms)
//   → 10ms 淡入淡出(防爆点)→ 按有效语音 RMS 归一响度(目标 -22dBFS,增益 ±8dB)
//   → 峰值限制(-2dBFS,超限整体回落防削波)。
// 输入输出都是完整 wav(ArrayBuffer);裁剪与响度指标同时用于回归测试。

import { parseWavFront, pcmToWav } from './wav'

export const POST = {
  keepHeadMs: 100,
  keepTailMs: 150,
  maxLeadSilenceMs: 250,
  maxTailSilenceMs: 250,
  fadeMs: 10,
  windowMs: 10, // 静音判定窗口
  silenceDb: -45, // 窗口 RMS 低于此值视为静音
  targetRmsDb: -22,
  rmsToleranceDb: 1.5,
  maxGainDb: 8,
  peakLimitDb: -2,
} as const

export interface PostMetrics {
  /** 裁剪后剩余的首/尾静音时长(ms) */
  headSilenceMs: number
  tailSilenceMs: number
  /** 有效语音(裁剪区内的活跃段)RMS 与峰值,dBFS */
  rmsDb: number
  peakDb: number
  /** 实际施加的增益(dB,含峰值回落) */
  gainDb: number
  durationMsIn: number
  durationMsOut: number
}

const dbfs = (rms: number): number => (rms <= 0 ? -Infinity : 20 * Math.log10(rms / 32767))

/** 10ms 窗 RMS(dBFS)序列;尾部不足一窗按短窗计 */
function windowRmsDb(samples: Int16Array, windowLen: number): number[] {
  const out: number[] = []
  for (let start = 0; start < samples.length; start += windowLen) {
    const end = Math.min(samples.length, start + windowLen)
    let acc = 0
    for (let i = start; i < end; i++) acc += samples[i] * samples[i]
    const rms = Math.sqrt(acc / (end - start))
    out.push(dbfs(rms) === -Infinity ? -120 : dbfs(rms))
  }
  return out
}

/** 完整 wav → 解析出的 PCM 采样(16bit;其他位深原样报错走降级) */
function wavToSamples(wav: ArrayBuffer): { samples: Int16Array; sampleRate: number; channels: number } | null {
  const parsed = parseWavFront(new Uint8Array(wav))
  if (!parsed || parsed.bitsPerSample !== 16) return null
  const bytes = new Uint8Array(wav).subarray(parsed.pcmOffset)
  const usable = bytes.length - (bytes.length % 2)
  const out = new Int16Array(usable / 2)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, usable)
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true)
  return { samples: out, sampleRate: parsed.sampleRate, channels: parsed.channels }
}

/**
 * 后处理入口。输入完整 wav,输出处理后的完整 wav 与指标。
 * 全静音/解析失败等极端输入原样返回(不做任何改动,避免把坏数据放大成爆音)。
 */
export function postProcessWav(wav: ArrayBuffer): { wav: ArrayBuffer; metrics: PostMetrics } {
  const parsed = wavToSamples(wav)
  const durationMsIn = (parsed ? parsed.samples.length : 0) / ((parsed?.sampleRate ?? 44100) / 1000)
  const base = {
    headSilenceMs: 0,
    tailSilenceMs: 0,
    rmsDb: -120,
    peakDb: -120,
    gainDb: 0,
    durationMsIn,
    durationMsOut: durationMsIn,
  }
  if (!parsed || parsed.samples.length === 0) return { wav, metrics: base }

  const { samples, sampleRate, channels } = parsed
  const frame = Math.max(1, Math.round((sampleRate / 1000) * POST.windowMs))
  const windows = windowRmsDb(samples, frame)

  // 首尾静音判定:首个/最后一个活跃窗口
  let firstActive = windows.findIndex((db) => db > POST.silenceDb)
  if (firstActive < 0) firstActive = -1 // 全静音
  let lastActive = -1
  for (let i = windows.length - 1; i >= 0; i--) {
    if (windows[i] > POST.silenceDb) {
      lastActive = i
      break
    }
  }

  const headKeepFrames = Math.round((POST.keepHeadMs / 1000) * sampleRate)
  const tailKeepFrames = Math.round((POST.keepTailMs / 1000) * sampleRate)

  let head = 0
  let tail = samples.length
  if (firstActive >= 0 && lastActive >= firstActive) {
    const onset = firstActive * frame
    const offsetEnd = Math.min(samples.length, (lastActive + 1) * frame)
    head = Math.max(0, onset - headKeepFrames) // 裁到 onset 前 ~100ms,剩余首静音 ≤250ms
    tail = Math.min(samples.length, offsetEnd + tailKeepFrames) // 保留 ~150ms 尾
  }
  const trimmed = samples.subarray(head, tail)
  const durationMsOut = Math.round((trimmed.length / sampleRate) * 1000)

  // 有效语音 RMS:活跃段(不含保留的头尾静音)。窗口序号是原始坐标,需减去裁掉的头部
  const activeStart = firstActive >= 0 ? Math.max(0, firstActive * frame - head) : 0
  const activeEnd = lastActive >= 0 ? Math.min(trimmed.length, Math.max(0, (lastActive + 1) * frame - head)) : 0
  const activeLen = Math.max(0, activeEnd - activeStart)
  let acc = 0
  for (let i = activeStart; i < activeEnd; i++) acc += trimmed[i] * trimmed[i]
  const rms = activeLen > 0 ? Math.sqrt(acc / activeLen) : 0
  const rmsDb = activeLen > 0 ? dbfs(rms) : -120

  // 增益:目标 -22dBFS,钳位 ±8dB;全静音不加增益
  let gainDb = 0
  if (activeLen > 0 && Number.isFinite(rmsDb)) {
    gainDb = Math.min(POST.maxGainDb, Math.max(-POST.maxGainDb, POST.targetRmsDb - rmsDb))
  }
  const gain = 10 ** (gainDb / 20)

  // 应用增益 + 10ms 淡入淡出 + 峰值限制(-2dBFS 超限整体回落)
  const fadeFrames = Math.round((POST.fadeMs / 1000) * sampleRate)
  const out = new Float32Array(trimmed.length)
  let peak = 0
  for (let i = 0; i < trimmed.length; i++) {
    let v = trimmed[i] * gain
    if (i < fadeFrames) {
      v *= (i + 1) / fadeFrames // 淡入
    } else if (trimmed.length - i <= fadeFrames) {
      v *= (trimmed.length - i) / fadeFrames // 淡出
    }
    out[i] = v
    const abs = Math.abs(v)
    if (abs > peak) peak = abs
  }
  const peakDb = peak > 0 ? 20 * Math.log10(peak / 32767) : -120
  let outGain = 1
  if (peakDb > POST.peakLimitDb) outGain = 10 ** ((POST.peakLimitDb - peakDb) / 20)

  const outPcm = new Int16Array(trimmed.length)
  for (let i = 0; i < trimmed.length; i++) {
    const v = Math.round(out[i] * outGain)
    outPcm[i] = Math.max(-32768, Math.min(32767, v))
  }

  const metrics: PostMetrics = {
    headSilenceMs: Math.round((head / sampleRate) * 1000),
    tailSilenceMs: Math.round(((samples.length - tail) / sampleRate) * 1000),
    rmsDb: Math.round((rmsDb + gainDb + 20 * Math.log10(outGain)) * 10) / 10,
    peakDb: Math.round(Math.min(peakDb, POST.peakLimitDb) * 10) / 10,
    gainDb: Math.round((gainDb + 20 * Math.log10(outGain)) * 10) / 10,
    durationMsIn: Math.round((samples.length / sampleRate) * 1000),
    durationMsOut,
  }
  // pcmToWav 按字节写入:Int16Array 需转成字节视图,否则采样值会被当字节写成垃圾
  return { wav: pcmToWav(new Uint8Array(outPcm.buffer, outPcm.byteOffset, outPcm.byteLength), sampleRate, channels, 16), metrics }
}
