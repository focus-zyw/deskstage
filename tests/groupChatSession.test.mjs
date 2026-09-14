// 群聊会话(ChatSession → GroupChatRuntime)行为矩阵:假 Adapter + 受控 TTS 句柄。
// 覆盖(评审必补项):呈现/TTS 顺序按 roomSeq 一致 / 打断停 Worker+当前 TTS+待播(I8)/
// whenIdle 等 TTS 排空 / clarify 零模型调用且补充后只答一次 / legacy 引擎分派。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let mod
let createFakeActorAdapter

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  mod = await server.ssrLoadModule('/src/session/ChatSession.ts')
  const fake = await server.ssrLoadModule('/src/groupChat/adapters/fakeActor.ts')
  createFakeActorAdapter = fake.createFakeActorAdapter
})

after(async () => {
  await server?.close()
})

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function makeConfig(over = {}) {
  return {
    names: { a: '甲', b: '乙', c: '丙' },
    userProfile: { userName: '你' },
    characters: { C: { enabled: false } },
    model: 'test-model',
    groupChatActors: {
      engine: 'actors',
      A: { binding: { kind: 'api' }, autonomy: 'natural' },
      B: { binding: { kind: 'disabled' }, autonomy: 'natural' },
      C: { binding: { kind: 'disabled' }, autonomy: 'natural' },
    },
    ...over,
  }
}

function makeHost(over = {}) {
  const calls = {
    presentTurn: [],
    presentUser: [],
    clearUser: [],
    presentFallback: [],
    queueInterjection: [],
    onUserActive: 0,
    speechStart: 0,
  }
  const host = {
    names: () => ({ A: '甲', B: '乙', C: '丙' }),
    isPerforming: () => false,
    queueInterjection: (text, who) => calls.queueInterjection.push({ text, who }),
    presentTurn: (line) => calls.presentTurn.push(line),
    presentUser: (text, who) => calls.presentUser.push({ text, who }),
    clearUser: (text) => calls.clearUser.push(text),
    presentFallback: (line) => calls.presentFallback.push(line),
    onUserActive: () => {
      calls.onUserActive++
    },
    onTurnSpeechStart: () => {
      calls.speechStart++
    },
    ...over,
  }
  return { host, calls }
}

/** 受控 TTS:ended 由测试手动放行,stop() 语义 = 放行(与真实句柄一致) */
function makeTts(gates) {
  return {
    tts: {
      speakTracked: (who, text) => {
        const gate = deferred()
        gates.push({ who, text, gate })
        return { started: Promise.resolve('audible'), ended: gate.promise, stop: () => gate.resolve() }
      },
      prefetch: () => {},
    },
  }
}

const CLOCK = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  },
}

function makeSession(adapters, over = {}) {
  const { host, calls } = makeHost(over.host)
  const gates = []
  const engine = { prepareMemory: async () => ({ selected: [], candidates: [], queriedAt: 0, promptFacts: [], refs: [] }), ...makeTts(gates), ...over.engine }
  const session = mod.createChatSession(host, engine, {
    clock: CLOCK,
    config: async () => makeConfig(over.config),
    adapters,
    ...over.opts,
  })
  return { session, host, calls, gates }
}

const ALL_ON = {
  groupChatActors: {
    engine: 'actors',
    A: { binding: { kind: 'api' }, autonomy: 'natural' },
    B: { binding: { kind: 'api' }, autonomy: 'natural' },
    C: { binding: { kind: 'api' }, autonomy: 'natural' },
  },
}

test('自由群聊:并行应答,舞台呈现序与 TTS 序一致且都按 roomSeq', async () => {
  const adA = createFakeActorAdapter([{ speak: '甲-1' }, { listen: true }])
  const adB = createFakeActorAdapter([{ defer: true }, { listen: true }])
  const adC = createFakeActorAdapter([{ defer: true }, { listen: true }])
  const { session, calls, gates } = makeSession({ A: adA, B: adB, C: adC }, { config: ALL_ON })
  await session.send('你们仨聊会')
  await waitFor(() => calls.presentTurn.length >= 1)
  assert.deepEqual(calls.presentTurn.map((l) => l.text), ['甲-1'])
  // 呈现是串行的:甲播完(gate 放行)才轮到乙;乙的回复早已提交、在队列里等
  adB.resolveAt(0, { speak: '乙-2' })
  gates[0].gate.resolve()
  await waitFor(() => calls.presentTurn.length >= 2)
  adC.resolveAt(0, { speak: '丙-3' })
  gates[1].gate.resolve()
  await waitFor(() => calls.presentTurn.length >= 3)
  assert.deepEqual(
    calls.presentTurn.map((l) => `${l.speaker}:${l.text}`),
    ['A:甲-1', 'B:乙-2', 'C:丙-3'],
  )
  await waitFor(() => gates.length >= 3)
  assert.deepEqual(
    gates.map((g) => `${g.who}:${g.text}`),
    ['A:甲-1', 'B:乙-2', 'C:丙-3'],
    'TTS 序 = 舞台呈现序 = roomSeq 序',
  )
  gates[2].gate.resolve()
  await session.whenIdle()
})

test('打断(I8):在飞 Worker 作废、当前 TTS 停声、取消后不再上屏', async () => {
  const adA = createFakeActorAdapter([{ speak: '甲第一句' }, { listen: true }])
  const adB = createFakeActorAdapter([{ defer: true }, { listen: true }])
  const { session, calls, gates } = makeSession({ A: adA, B: adB }, {
    config: makeConfig({ groupChatActors: {
      engine: 'actors',
      A: { binding: { kind: 'api' }, autonomy: 'natural' },
      B: { binding: { kind: 'api' }, autonomy: 'natural' },
      C: { binding: { kind: 'disabled' }, autonomy: 'natural' },
    } }),
  })
  await session.send('甲说话')
  await waitFor(() => calls.presentTurn.length >= 1)
  assert.equal(calls.presentTurn[0].text, '甲第一句')
  assert.equal(session.getSnapshot().busy, true, 'TTS 未播完 = 未静止')
  // cancel:当前句停声(gate 放行)、队列清空、在飞乙作废
  assert.equal(gates.length, 1)
  session.cancel()
  await waitFor(() => session.getSnapshot().busy === false)
  const presented = calls.presentTurn.length
  assert.equal(presented, 1, '取消后无新上屏')
  // 被打断的乙迟到提交:全员暂停态下按 listen 收尾,不再呈现
  adB.resolveAt(0, { speak: '乙迟到的插话' })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(calls.presentTurn.length, 1, '停止后迟到回复不上屏')
})

test('whenIdle 等 TTS 排空:播放中不得完成(voiceSession 依赖的语义)', async () => {
  const adA = createFakeActorAdapter([{ speak: '慢慢说' }, { listen: true }])
  const { session, gates } = makeSession({ A: adA })
  let idleDone = false
  await session.send('说句话')
  void session.whenIdle().then(() => {
    idleDone = true
  })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(idleDone, false, 'TTS 在播,whenIdle 不得完成')
  for (const g of gates) g.gate.resolve()
  await waitFor(() => idleDone)
})

test('clarify 短路:零模型调用;用户补充后新批次一次读完只答一次', async () => {
  let toolsCalls = 0
  const adA = createFakeActorAdapter([{ speak: '甲的回答' }])
  const { session, calls, gates } = makeSession(
    { A: adA },
    {
      engine: {
        tools: async () => {
          toolsCalls += 1
          return toolsCalls === 1 ? { clarify: '你先说说你想问什么?' } : {}
        },
      },
    },
  )
  await session.send('甲,那个事')
  await waitFor(() => calls.presentTurn.length >= 1)
  assert.equal(calls.presentTurn[0].speaker, 'A', 'clarify 由主回应人直接发')
  assert.equal(calls.presentTurn[0].text, '你先说说你想问什么?')
  assert.equal(adA.calls.length, 0, 'clarify 不得触发任何 Actor 调用')
  gates.forEach((g) => g.gate.resolve()) // 放行 clarify 的语音,队列继续
  // 用户补充:新批次包含 原问题 → 补充(A 不收自己的 clarify,属正常过滤),一次读完
  await session.send('我问的是排班表')
  await waitFor(() => adA.calls.length >= 1)
  const prompt = adA.calls[0].req.prompt
  assert.ok(prompt.includes('我问的是排班表'), '批次包含用户补充')
  await waitFor(() => calls.presentTurn.some((l) => l.text === '甲的回答'))
  assert.equal(calls.presentTurn.filter((l) => l.text === '甲的回答').length, 1, '原问题只被回答一次')
  gates.forEach((g) => g.gate.resolve())
  await session.whenIdle()
})

test('engine=legacy 分派:保留旧 busy 语义(回退开关)', async () => {
  const legacyFake = {
    send: async () => 'busy',
    cancel: () => {},
    getSnapshot: () => ({ busy: true }),
    subscribe: () => () => {},
    whenIdle: async () => {},
  }
  const { host } = makeHost()
  const session = mod.createChatSession(
    host,
    {},
    {
      legacy: legacyFake,
      config: async () =>
        makeConfig({
          groupChatActors: {
            engine: 'legacy',
            A: { binding: { kind: 'api' }, autonomy: 'natural' },
            B: { binding: { kind: 'api' }, autonomy: 'natural' },
            C: { binding: { kind: 'disabled' }, autonomy: 'natural' },
          },
        }),
    },
  )
  const res = await session.send('你好')
  assert.equal(res, 'busy')
  assert.equal(session.getSnapshot().busy, true)
})
