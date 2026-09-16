// 语音后处理回归:裁剪/响度/峰值指标 + 14 句合成语料的处理前后对照。
// 语料为确定性伪随机合成 wav(可复现);真实人声回归可在 app 内对比缓存重放。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let postProcessWav
let parseWavFront
let pcmToWav
let POST

before(async () => {
  ;({ postProcessWav } = await import('../src/engine/tts/speechPostProcessor.ts'))
  ;({ POST } = await import('../src/engine/tts/speechPostProcessor.ts'))
  ;({ parseWavFront, pcmToWav } = await import('../src/engine/tts/wav.ts'))
})


const SR = 44100

/** 合成一段"语音"wav:头部静音 + 伪随机噪声拟语音 + 尾部静音。
 *  rmsDb 控制语音段响度,hotMs 在语音中段加入接近满幅的峰值 */
function mkSpeechWav({ headMs = 0, speechMs = 1000, tailMs = 0, rmsDb = -22, hotMs = 0 }) {
  const n = (ms) => Math.round((ms / 1000) * SR)
  const pcm = new Int16Array(n(headMs) + n(speechMs) + n(tailMs))
  // 线性同余伪随机,确定性可复现
  let seed = 0x2f6e2b1
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const rms = 32767 * 10 ** (rmsDb / 20) * Math.sqrt(3) // 均匀噪声 RMS 比峰值标称低 √3,补偿
  const speechStart = n(headMs)
  for (let i = 0; i < n(speechMs); i++) {
    let v = (rand() * 2 - 1) * rms
    if (hotMs > 0 && i >= n(speechMs) / 2 && i < n(speechMs) / 2 + n(hotMs)) {
      v = Math.sin((i / SR) * 2 * Math.PI * 440) * 32767 * 0.95 // 接近满幅的正弦峰
    }
    pcm[speechStart + i] = Math.max(-32768, Math.min(32767, Math.round(v)))
  }
  return pcmToWav(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), SR, 1, 16)
}

/** 独立测量:按 10ms 窗找首尾静音与活跃段 RMS/峰值(与实现分开写,互为对照) */
function measure(wav) {
  const parsed = parseWavFront(new Uint8Array(wav))
  const bytes = new Uint8Array(wav).subarray(parsed.pcmOffset)
  const pcm = new Int16Array(Math.floor(bytes.length / 2))
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8)
  const win = Math.round((10 / 1000) * parsed.sampleRate)
  const db = (arr) => {
    let acc = 0
    for (const v of arr) acc += v * v
    const rms = Math.sqrt(acc / arr.length)
    return rms <= 0 ? -120 : 20 * Math.log10(rms / 32767)
  }
  const windows = []
  for (let s = 0; s < pcm.length; s += win) windows.push(db(pcm.slice(s, s + win)))
  const first = windows.findIndex((d) => d > POST.silenceDb)
  let last = -1
  for (let i = windows.length - 1; i >= 0; i--) {
    if (windows[i] > POST.silenceDb) {
      last = i
      break
    }
  }
  const winMs = (win / parsed.sampleRate) * 1000
  const headSilenceMs = first < 0 ? Math.round((pcm.length / parsed.sampleRate) * 1000) : Math.round(first * winMs)
  const tailSilenceMs = last < 0 ? Math.round((pcm.length / parsed.sampleRate) * 1000) : Math.round((windows.length - 1 - last) * winMs)
  const a0 = Math.max(0, first) * win
  const a1 = (last + 1) * win
  const peakLin = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  return {
    headSilenceMs,
    tailSilenceMs,
    rmsDb: a1 > a0 ? db(pcm.slice(a0, a1)) : -120,
    peakDb: peakLin > 0 ? 20 * Math.log10(peakLin / 32767) : -120,
    durationMs: Math.round((pcm.length / parsed.sampleRate) * 1000),
  }
}

test('首尾静音被裁到目标范围内(头≤250ms,尾≤250ms)', () => {
  const { wav } = postProcessWav(mkSpeechWav({ headMs: 500, speechMs: 1200, tailMs: 600, rmsDb: -22 }))
  const m = measure(wav)
  assert.ok(m.headSilenceMs <= POST.maxLeadSilenceMs, `head ${m.headSilenceMs}ms`)
  assert.ok(m.tailSilenceMs <= POST.maxTailSilenceMs, `tail ${m.tailSilenceMs}ms`)
})

test('响度归一到 -22dBFS ±1.5dB,峰值不超 -2dBFS', () => {
  const { wav } = postProcessWav(mkSpeechWav({ headMs: 80, speechMs: 1000, tailMs: 80, rmsDb: -26 }))
  const m = measure(wav)
  assert.ok(Math.abs(m.rmsDb - POST.targetRmsDb) <= POST.rmsToleranceDb, `rms ${m.rmsDb}dB`)
  assert.ok(m.peakDb <= POST.peakLimitDb, `peak ${m.peakDb}dB`)
})

test('过热输入:峰值被限制,不发生削波', () => {
  const { wav } = postProcessWav(mkSpeechWav({ headMs: 50, speechMs: 800, tailMs: 50, rmsDb: -12, hotMs: 100 }))
  const m = measure(wav)
  assert.ok(m.peakDb <= POST.peakLimitDb, `peak ${m.peakDb}dB`)
})

test('14 句回归语料:处理后全部达标,时长收敛,响度一致', () => {
  const rows = []
  for (let i = 0; i < 14; i++) {
    const inWav = mkSpeechWav({
      headMs: (i * 37) % 400,
      speechMs: 900 + ((i * 173) % 1500),
      tailMs: (i * 53) % 450,
      rmsDb: -30 + (i % 7), // -30 ~ -24:需要正增益归一的典型 TTS 输出
    })
    const before = measure(inWav)
    const { wav, metrics } = postProcessWav(inWav)
    const afterM = measure(wav)
    assert.ok(afterM.headSilenceMs <= POST.maxLeadSilenceMs, `#${i} head`)
    assert.ok(afterM.tailSilenceMs <= POST.maxTailSilenceMs, `#${i} tail`)
    assert.ok(Math.abs(afterM.rmsDb - POST.targetRmsDb) <= POST.rmsToleranceDb, `#${i} rms ${afterM.rmsDb}`)
    assert.ok(afterM.peakDb <= POST.peakLimitDb, `#${i} peak ${afterM.peakDb}`)
    // 处理后时长应短于等于原时长(裁掉了多余静音),且与指标一致
    assert.ok(afterM.durationMs <= before.durationMs + 1, `#${i} duration grew`)
    assert.equal(afterM.durationMs, metrics.durationMsOut, `#${i} 指标与实测不一致`)
    rows.push({
      i,
      durIn: before.durationMs,
      durOut: afterM.durationMs,
      rmsIn: Math.round(before.rmsDb * 10) / 10,
      rmsOut: afterM.rmsDb,
    })
  }
  // 全语料处理后响度一致(±1.5dB 内)
  const outs = rows.map((r) => r.rmsOut)
  assert.ok(Math.max(...outs) - Math.min(...outs) <= 2 * POST.rmsToleranceDb, JSON.stringify(rows))
})
