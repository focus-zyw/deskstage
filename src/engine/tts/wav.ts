// WAV 工具:从流式首块解析 RIFF 布局(剥离头部得到裸 PCM);把裸 PCM 包成完整 wav,
// 供磁盘缓存自包含、以及无 worklet 时 <audio> 直接播放。

export interface WavLayout {
  /** data 块内 PCM 的起始偏移 */
  pcmOffset: number
  sampleRate: number
  channels: number
  bitsPerSample: number
}

/** 解析 wav 头(容忍 fmt 前有 LIST 等附加块)。首块不足 44 字节返回 null,调用方继续攒 */
export function parseWavFront(front: Uint8Array): WavLayout | null {
  if (front.length < 44) return null
  const dv = new DataView(front.buffer, front.byteOffset, front.byteLength)
  if (dv.getUint32(0, false) !== 0x52494646 /* 'RIFF' */) return null
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null
  let pos = 12
  while (pos + 8 <= front.length) {
    const id = dv.getUint32(pos, false)
    const size = dv.getUint32(pos + 4, true)
    if (id === 0x666d7420 /* 'fmt ' */) {
      fmt = {
        channels: dv.getUint16(pos + 10, true),
        sampleRate: dv.getUint32(pos + 12, true),
        bits: dv.getUint16(pos + 22, true),
      }
    }
    if (id === 0x64617461 /* 'data' */) {
      if (!fmt) return null
      return { pcmOffset: pos + 8, sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits }
    }
    pos += 8 + size + (size % 2) // 块按 2 字节对齐
  }
  return null
}

/** 裸 PCM(Int16LE)→ 完整 wav 字节 */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): ArrayBuffer {
  const header = new ArrayBuffer(44)
  const dv = new DataView(header)
  const tag = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i))
  }
  const bytesPerSample = bitsPerSample >> 3
  tag(0, 'RIFF')
  dv.setUint32(4, 36 + pcm.length, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, channels, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * channels * bytesPerSample, true)
  dv.setUint16(32, channels * bytesPerSample, true)
  dv.setUint16(34, bitsPerSample, true)
  tag(36, 'data')
  dv.setUint32(40, pcm.length, true)
  const out = new Uint8Array(44 + pcm.length)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, 44)
  return out.buffer
}
