// VoiceSession 行为矩阵(闭环编排验收):假麦克风/假 VAD/假 ASR/假聊天 + 内存租约,
// 零音频设备零网络。覆盖:PTT 起止→ASR→send / ASR 失败与没听清回落 / PTT 打断(speaking
// 中按下 = cancel+回听) / barge-in 事件打断 / stop 全清 / 麦克风断流→重试恢复 /
// 迟到 whenIdle 不覆盖打断后的 phase。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let mod

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  mod = await server.ssrLoadModule('/src/session/voiceSession.ts')
})

after(async () => server?.close())

const tick = () => new Promise((r) => setImmediate(r))

function makeWorld(over = {}) {
  const calls = {
    send: [],
    cancel: 0,
    enter: 0,
    exit: 0,
    prepare: 0,
    micStart: 0,
    micStop: 0,
    gates: [],
    watches: [],
  }
  const phases = []
  let latest = { phase: 'off', level: -120, note: '', stormLatched: false }
  let micOpts = null
  let trackerDeps = null
  let tdRef = null
  const tracker = {
    feed: () => {},
    // 与真实现同语义:松闸结算一句(真 VAD 的起止判定已在 vad.test.mjs 验证)
    setGate: (v) => {
      calls.gates.push(v)
      if (!v && tdRef) tdRef.onEvent({ type: 'speech-end', pcm: new Int16Array(480) })
    },
    setWatchBargeIn: (v) => calls.watches.push(v),
    flush: () => {},
    resetStorm: () => {},
    noiseFloorDb: () => -60,
  }
  let resolveIdle = () => {}
  const deps = {
    startMic: async (o) => {
      if (over.micError) throw new Error(over.micError)
      calls.micStart++
      micOpts = o
      return { stop: async () => calls.micStop++ }
    },
    createTracker: (td) => {
      trackerDeps = td
      tdRef = td
      return tracker
    },
    transcribe: over.transcribe ?? (async () => '你好呀'),
    loadConfig: async () =>
      over.cfg ?? {
        voiceChat: { mode: 'ptt', deviceId: '', vadSensitivityDb: 12, silenceMs: 800, autoInterrupt: false, interruptExtraDb: 6 },
        asr: { provider: 'siliconflow', model: 'FunAudioLLM/SenseVoiceSmall', apiKey: '' },
      },
    chat: {
      send: async (text, opts) => {
        calls.send.push({ text, opts })
        return over.sendResult ?? 'accepted'
      },
      cancel: () => calls.cancel++,
      whenIdle: () =>
        new Promise((r) => {
          resolveIdle = r
        }),
    },
    mode: {
      prepare: () => {
        calls.prepare++
        return over.prepareOk ?? true
      },
      enter: () => calls.enter++,
      exit: () => calls.exit++,
    },
    onPhase: (p) => phases.push(p),
    log: () => {},
  }
  const session = mod.createVoiceSession(deps, (s) => {
    latest = s
  })
  return { session, calls, phases, deps: () => deps, trackerDeps: () => trackerDeps, micOpts: () => micOpts, latest: () => latest, resolveIdle: () => resolveIdle() }
}

test('PTT 全链:开会话→按住收音→松开→识别→send(voice:true)→回答完回听', async () => {
  const w = makeWorld()
  await w.session.start('ptt')
  assert.equal(w.latest().phase, 'listening')
  assert.equal(w.calls.enter, 1)
  assert.equal(w.calls.micStart, 1)

  w.session.pttDown() // 按住:开闸
  assert.deepEqual(w.calls.gates, [true])
  w.session.pttUp() // 松开:结算一句
  assert.deepEqual(w.calls.gates, [true, false])
  await tick()
  await tick()
  assert.equal(w.latest().phase, 'thinking')
  // 诊断埋点后 opts 携带 diagAsr(耗时为运行时值,只验形状)
  assert.equal(w.calls.send.length, 1)
  assert.equal(w.calls.send[0].text, '你好呀')
  assert.equal(w.calls.send[0].opts.voice, true)
  assert.equal(w.calls.send[0].opts.diagAsr.chars, 3)

  w.resolveIdle() // 回答结束
  await tick()
  assert.equal(w.latest().phase, 'listening')
})

test('识别失败与没听清都回到收音并带提示,不进聊天', async () => {
  const w = makeWorld({ transcribe: async () => { throw new Error('密钥无效') } })
  await w.session.start('ptt')
  w.session.pttDown()
  w.session.pttUp()
  await tick()
  await tick()
  assert.equal(w.latest().phase, 'listening')
  assert.ok(w.latest().note.includes('识别失败'))
  assert.equal(w.calls.send.length, 0)

  const w2 = makeWorld({ transcribe: async () => '  ' })
  await w2.session.start('ptt')
  w2.session.pttDown()
  w2.session.pttUp()
  await tick()
  await tick()
  assert.equal(w2.latest().phase, 'listening')
  assert.ok(w2.latest().note.includes('没听清'))
  assert.equal(w2.calls.send.length, 0)
})

test('PTT 打断:回答中按下 = cancel + 回到收音 + 直接开闸', async () => {
  const w = makeWorld()
  await w.session.start('ptt')
  w.session.pttDown()
  w.session.pttUp()
  await tick()
  await tick()
  w.session.notifyTurnSpeechStart() // 首句出声
  assert.equal(w.latest().phase, 'speaking')

  w.session.pttDown() // 用户抢话
  assert.equal(w.calls.cancel, 1)
  assert.equal(w.latest().phase, 'listening')
  assert.deepEqual(w.calls.gates.slice(-1), [true]) // 打断后立即收这句

  // 迟到的 whenIdle 不得覆盖打断后的状态
  w.resolveIdle()
  await tick()
  assert.equal(w.latest().phase, 'listening')
})

test('自动 barge-in 事件(实验项):speaking 中触发 = cancel + 回听', async () => {
  const w = makeWorld()
  await w.session.start('hands-free')
  w.trackerDeps().onEvent({ type: 'speech-end', pcm: new Int16Array(480) })
  await tick()
  await tick()
  assert.equal(w.latest().phase, 'thinking')
  w.session.notifyTurnSpeechStart()
  assert.equal(w.latest().phase, 'speaking')
  w.trackerDeps().onEvent({ type: 'barge-in', pcm: new Int16Array(0) })
  assert.equal(w.calls.cancel, 1)
  assert.equal(w.latest().phase, 'listening')
})

test('stop:全清(停麦/退出排他/取消在飞/phase off)', async () => {
  const w = makeWorld()
  await w.session.start('ptt')
  w.session.pttDown()
  w.session.pttUp()
  await tick()
  await w.session.stop()
  assert.equal(w.latest().phase, 'off')
  assert.equal(w.calls.micStop, 1)
  assert.equal(w.calls.exit, 1)
  assert.equal(w.calls.cancel, 1)
})

test('麦克风断流 → mic-lost + 提示;再按 PTT 重试恢复', async () => {
  const w = makeWorld()
  await w.session.start('ptt')
  w.micOpts().onEnded('设备已拔出')
  assert.equal(w.latest().phase, 'mic-lost')
  assert.ok(w.latest().note.includes('麦克风断开'))

  w.session.pttDown() // 重试
  await tick()
  await tick()
  assert.equal(w.latest().phase, 'listening')
  assert.equal(w.calls.micStart, 2)
})

test('prepare 拒绝(框选中)不进入;启动失败进 mic-lost 并带隐私指引', async () => {
  const w = makeWorld({ prepareOk: false })
  await w.session.start('ptt')
  assert.equal(w.latest().phase, 'off')
  assert.equal(w.calls.enter, 0)

  const w2 = makeWorld({ micError: '初始化麦克风失败' })
  await w2.session.start('ptt')
  assert.equal(w2.latest().phase, 'mic-lost')
  assert.ok(w2.latest().note.includes('隐私'))
})

test('免按键模式:speech-end 直接触发转写并发送', async () => {
  const w = makeWorld({
    cfg: {
      voiceChat: { mode: 'hands-free', deviceId: '', vadSensitivityDb: 14, silenceMs: 700, autoInterrupt: true, interruptExtraDb: 6 },
      asr: { provider: 'siliconflow', model: 'm', apiKey: '' },
    },
  })
  await w.session.start('hands-free')
  // 真 VAD 的起止判定已在 vad.test.mjs 验证,这里直接喂事件
  w.trackerDeps().onEvent({ type: 'speech-end', pcm: new Int16Array(480) })
  await tick()
  await tick()
  assert.equal(w.latest().phase, 'thinking')
  // 诊断埋点后 opts 携带 diagAsr(耗时为运行时值,只验形状)
  assert.equal(w.calls.send.length, 1)
  assert.equal(w.calls.send[0].text, '你好呀')
  assert.equal(w.calls.send[0].opts.voice, true)
  assert.deepEqual(
    { voice: w.calls.send[0].opts.voice, asrShape: typeof w.calls.send[0].opts.diagAsr },
    { voice: true, asrShape: 'object' },
  )
  assert.equal(typeof w.calls.send[0].opts.diagAsr.ms, 'number')
  assert.equal(w.calls.send[0].opts.diagAsr.chars, 3)
  assert.equal(w.latest().stormLatched, false)
})

test('风暴闩锁事件:置位快照并带提示;autoInterrupt 关闭后 tracker 收到 false', async () => {
  let seen = null
  const w = makeWorld()
  await w.session.start('hands-free')
  // 从 createTracker 拿到的 deps 现查 autoInterrupt
  seen = w.trackerDeps()
  w.trackerDeps().onEvent({ type: 'interrupt-storm' })
  assert.equal(w.latest().stormLatched, true)
  assert.ok(w.latest().note.includes('仅按键可打断'))
  assert.equal(seen.autoInterrupt(), false, '闩锁后 autoInterrupt 应为 false')
})

test('barge-in 侦听接线:进入 speaking 开 watch,回到收音即关', async () => {
  const w = makeWorld()
  await w.session.start('hands-free')
  assert.deepEqual(w.calls.watches, [false]) // listening:不侦听
  w.trackerDeps().onEvent({ type: 'speech-end', pcm: new Int16Array(480) })
  await tick()
  await tick()
  w.session.notifyTurnSpeechStart() // thinking → speaking
  assert.equal(w.calls.watches.at(-1), true)
  w.trackerDeps().onEvent({ type: 'barge-in', pcm: new Int16Array(0) })
  assert.equal(w.latest().phase, 'listening')
  assert.equal(w.calls.watches.at(-1), false)
})
