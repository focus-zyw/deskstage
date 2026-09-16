// 能量 VAD + 说话状态机行为矩阵:确定性帧序列,零音频设备零时钟。
// 帧 = 30ms 恒定,时间全用帧数度量。覆盖:底噪自适应 / 起止迟滞 / pre-roll 回填 /
// 瞬态不触发 / 30s 强制截断 / PTT 闸门 / barge-in 默认关 / 高阈值触发 / 风暴闩锁与恢复。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let mod

before(async () => {
  mod = await import('../src/engine/vad.ts')
})


const FRAME = 480

/** 整帧恒定幅度 → RMS ≈ 该 dBFS */
function frame(db) {
  const amp = Math.round(32768 * 10 ** (db / 20))
  const f = new Int16Array(FRAME)
  if (amp > 0) f.fill(amp)
  return f
}

function makeTracker(over = {}) {
  const events = []
  const cfg = {
    mode: 'handsfree',
    sensitivityDb: 12,
    endSilenceMs: 800,
    autoInterrupt: false,
    interruptExtraDb: 6,
    ...over.cfg,
  }
  const tracker = mod.createVoiceTracker({
    mode: () => cfg.mode,
    sensitivityDb: () => cfg.sensitivityDb,
    endSilenceMs: () => cfg.endSilenceMs,
    autoInterrupt: () => cfg.autoInterrupt,
    interruptExtraDb: () => cfg.interruptExtraDb,
    onEvent: (e) => events.push(e),
    ...over.deps,
  })
  return { tracker, events, cfg }
}

function feedN(tracker, db, n) {
  for (let i = 0; i < n; i++) tracker.feed(frame(db))
}

test('静音学习底噪后,起止迟滞产出完整语句并裁尾部静音', () => {
  const { tracker, events } = makeTracker()
  feedN(tracker, -60, 40) // 安静 1.2s,底噪 ≈ -60,阈值 = -48
  assert.deepEqual(events, [])
  feedN(tracker, -40, 3) // 3 正帧 = 起声
  assert.equal(events.filter((e) => e.type === 'speech-start').length, 1)
  feedN(tracker, -40, 20)
  feedN(tracker, -60, 27) // 810ms 静音 ≥ 800ms → 句结束
  const ends = events.filter((e) => e.type === 'speech-end')
  assert.equal(ends.length, 1)
  const frames = ends[0].pcm.length / FRAME
  // pre-roll≈10 + 语音 23 + 尾部留 2 帧静音 ≈ 35;宽区间防边界抖动
  assert.ok(frames > 30 && frames < 42, `utterance 帧数 ${frames}`)
})

test('pre-roll 回填:起声前 300ms 音频保留在语句里', () => {
  const { tracker, events } = makeTracker()
  feedN(tracker, -60, 50)
  feedN(tracker, -40, 3) // 第 3 正帧起声,utterance = pre-roll 环(含 3 个触发帧,共 10)
  assert.ok(events.some((e) => e.type === 'speech-start'))
  feedN(tracker, -40, 5) // 继续说 5 帧
  tracker.flush()
  const end = events.find((e) => e.type === 'speech-end')
  assert.equal(end.pcm.length, 15 * FRAME, 'pre-roll 10 帧 + 后续 5 帧')
})

test('两帧瞬态(关门/敲桌)不触发起声', () => {
  const { tracker, events } = makeTracker()
  feedN(tracker, -60, 30)
  feedN(tracker, -40, 2)
  feedN(tracker, -60, 30)
  assert.deepEqual(events, [])
})

test('30s 强制截断:说话不放气口也会结算', () => {
  const { tracker, events } = makeTracker()
  feedN(tracker, -60, 40)
  feedN(tracker, -40, 1100) // 33s 连续说话
  assert.ok(events.some((e) => e.type === 'speech-end'), '强制截断出句')
  assert.ok(events.some((e) => e.type === 'speech-start'))
})

test('PTT 闸门:开闸起句、帧数如实、松键结算', () => {
  const { tracker, events } = makeTracker({ cfg: { mode: 'ptt' } })
  feedN(tracker, -60, 20) // 闸门未开:不收集
  tracker.setGate(true)
  assert.ok(events.some((e) => e.type === 'speech-start'))
  feedN(tracker, -40, 33)
  tracker.setGate(false)
  const ends = events.filter((e) => e.type === 'speech-end')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].pcm.length, 33 * FRAME)
})

test('idle 模式不产事件,只养底噪', () => {
  const { tracker, events } = makeTracker({ cfg: { mode: 'idle' } })
  feedN(tracker, -40, 50)
  assert.deepEqual(events, [])
})

test('barge-in 默认关:watch 期间大声也不打断(实验项)', () => {
  const { tracker, events } = makeTracker()
  feedN(tracker, -60, 40)
  tracker.setWatchBargeIn(true)
  feedN(tracker, -40, 40)
  assert.ok(!events.some((e) => e.type === 'barge-in'))
})

test('barge-in 打开:高阈值持续 13 帧触发,附触发前音频', () => {
  const { tracker, events } = makeTracker({ cfg: { autoInterrupt: true } })
  feedN(tracker, -60, 40) // 底噪 -60:起声阈值 -48,打断阈值 -42
  tracker.setWatchBargeIn(true)
  feedN(tracker, -40, 13) // -40 > -42,持续 13 帧
  const barges = events.filter((e) => e.type === 'barge-in')
  assert.equal(barges.length, 1)
  assert.equal(barges[0].pcm.length, 13 * FRAME)
  // watch 期间不采集用户话音
  assert.ok(!events.some((e) => e.type === 'speech-start'))
  // watch 期间底噪不被大声带跑
  assert.ok(tracker.noiseFloorDb() < -50)
})

test('风暴闩锁:10s 内 3 次短打断 → 退回仅按键,resetStorm 恢复', () => {
  const { tracker, events } = makeTracker({ cfg: { autoInterrupt: true } })
  feedN(tracker, -60, 40)
  tracker.setWatchBargeIn(true)
  // 三轮:13 帧大声(触发打断,<600ms 算短)+ 10 帧安静
  for (let i = 0; i < 3; i++) {
    feedN(tracker, -40, 13)
    feedN(tracker, -60, 10)
  }
  assert.equal(events.filter((e) => e.type === 'barge-in').length, 2)
  assert.equal(events.filter((e) => e.type === 'interrupt-storm').length, 1)
  feedN(tracker, -40, 13) // 闩锁中:不再打断
  assert.equal(events.filter((e) => e.type === 'barge-in').length, 2)
  tracker.resetStorm()
  feedN(tracker, -40, 13)
  assert.equal(events.filter((e) => e.type === 'barge-in').length, 3)
})
