// ChatSession 行为矩阵(深模块验收,评审规格):内存 adapter 驱动,零网络零 DOM。
// 覆盖:LLM 失败→单句回落 / 取消后迟到响应不呈现 / 落盘成功但事实提取失败 /
// TTS 失败不影响文本 / 连续快发 busy 语义 / 演出中改走插话 / @解析与轮换 / groupAsk。
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
  mod = await server.ssrLoadModule('/src/session/ChatSession.ts')
})

after(async () => {
  await server?.close()
})

/** 轮询等待异步流程推进到某断言点(受理后 turnBatch 在数个 await 之后才发起) */
async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 5))
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
    ...over,
  }
  return { host, calls }
}

function makeEngine(over = {}) {
  const calls = {
    turnBatch: [],
    singleReply: [],
    recordTurn: [],
    factsExtract: [],
    factsMerge: [],
    tts: [],
  }
  const engine = {
    turnBatch: async (input) => {
      calls.turnBatch.push(input)
      if (over.turnBatch) return over.turnBatch(input)
      return [{ speaker: input.target, text: `回:${input.userText}`, action: 'talk' }]
    },
    singleReply: async (target, userText) => {
      calls.singleReply.push({ target, userText })
      return over.singleReply ? over.singleReply(target, userText) : `单:${userText}`
    },
    recordTurn: (who, text, meta) => calls.recordTurn.push({ who, text, meta }),
    historyWindow: () => [],
    prepareMemory: async () =>
      over.memory ?? { selected: [], candidates: [], queriedAt: 0, promptFacts: [], refs: [] },
    includeTrace: async () => false,
    facts: {
      known: async () => ['已知:喜欢 Rust'],
      extract: async (text, known) => {
        calls.factsExtract.push({ text, known })
        if (over.factsFail) throw new Error('提取失败')
        return []
      },
      merge: async (candidates) => calls.factsMerge.push(candidates),
    },
    tts: {
      speak: (who, text) => {
        calls.tts.push({ who, text })
        if (over.ttsFail) throw new Error('TTS 挂了')
      },
    },
    // 同步立即触发:测试零等待,节奏代码照常走到
    clock: {
      setTimeout: (fn) => {
        fn()
        return () => {}
      },
    },
  }
  return { engine, calls }
}

test('正常应答:TurnBatch 逐句呈现+落盘+TTS,结束后 busy 回落', async () => {
  const { host, calls } = makeHost()
  const { engine, calls: ecalls } = makeEngine()
  const session = mod.createChatSession(host, engine)
  const res = await session.send('你好呀')
  assert.equal(res, 'accepted')
  await session.whenIdle()
  assert.equal(session.getSnapshot().busy, false)
  assert.equal(calls.presentTurn.length, 1)
  assert.equal(calls.presentTurn[0].speaker, 'B') // 无 @ 首句在甲乙间轮换,先乙
  assert.equal(ecalls.tts.length, 1)
  assert.equal(ecalls.recordTurn.filter((r) => r.who === 'user').length, 1)
  assert.ok(ecalls.recordTurn.some((r) => r.text === '回:你好呀'))
  assert.ok(calls.presentUser[0].who) // 空闲路径聚焦
})

test('TurnBatch 失败静默回落单句应答', async () => {
  const { host, calls } = makeHost()
  const { engine, calls: ecalls } = makeEngine({
    turnBatch: () => Promise.reject(new Error('API 挂了')),
  })
  const session = mod.createChatSession(host, engine)
  await session.send('在吗')
  await session.whenIdle()
  assert.equal(calls.presentTurn.length, 1)
  assert.equal(calls.presentTurn[0].text, '单:在吗')
  assert.equal(ecalls.singleReply.length, 1)
})

test('取消后迟到响应不再呈现,busy 立即回落', async () => {
  const { host, calls } = makeHost()
  let resolveBatch
  const { engine, calls: ecalls } = makeEngine({
    turnBatch: () =>
      new Promise((r) => {
        resolveBatch = r
      }),
  })
  const session = mod.createChatSession(host, engine)
  const res = await session.send('慢问题')
  assert.equal(res, 'accepted')
  assert.equal(session.getSnapshot().busy, true)
  await waitFor(() => ecalls.turnBatch.length > 0) // 等 turnBatch 真正在飞
  session.cancel()
  assert.equal(session.getSnapshot().busy, false)
  resolveBatch([{ speaker: 'A', text: '迟到内容', action: 'talk' }])
  await session.whenIdle()
  await new Promise((r) => setTimeout(r, 20)) // 给迟到路径一个完整的调度机会
  assert.equal(calls.presentTurn.length, 0)
  assert.equal(session.getSnapshot().busy, false)
})

test('落盘成功但事实提取失败:静默不吞,无 unhandled rejection', async () => {
  const { host, calls } = makeHost()
  const { engine, calls: ecalls } = makeEngine({ factsFail: true })
  const session = mod.createChatSession(host, engine)
  await session.send('我叫小张')
  await session.whenIdle()
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(ecalls.recordTurn.length >= 2) // 用户句 + 应答句都落盘了
  assert.equal(ecalls.factsExtract.length, 1)
  assert.equal(calls.presentTurn.length, 1)
})

test('TTS 失败不影响文本呈现与落盘', async () => {
  const { host, calls } = makeHost()
  const { engine, calls: ecalls } = makeEngine({ ttsFail: true })
  const session = mod.createChatSession(host, engine)
  await session.send('说句话')
  await session.whenIdle()
  assert.equal(calls.presentTurn.length, 1)
  assert.ok(ecalls.recordTurn.some((r) => r.text === '回:说句话'))
})

test('连续快发:第一发受理,第二发 busy,空闲后恢复受理', async () => {
  let releaseBatch
  const { host } = makeHost()
  const { engine } = makeEngine({
    turnBatch: () =>
      new Promise((r) => {
        releaseBatch = r
      }),
  })
  const session = mod.createChatSession(host, engine)
  const first = await session.send('第一句')
  const second = await session.send('第二句')
  assert.equal(first, 'accepted')
  assert.equal(second, 'busy')
  await waitFor(() => typeof releaseBatch === 'function')
  releaseBatch([{ speaker: 'A', text: '答', action: 'talk' }])
  await session.whenIdle()
  assert.equal(await session.send('第三句'), 'accepted')
})

test('演出中:改走插话队列,不调 LLM,不聚焦角色', async () => {
  const { host, calls } = makeHost({ isPerforming: () => true })
  const { engine, calls: ecalls } = makeEngine()
  const session = mod.createChatSession(host, engine)
  const res = await session.send('插一句')
  assert.equal(res, 'accepted')
  assert.equal(calls.queueInterjection.length, 1)
  assert.equal(calls.queueInterjection[0].who, 'B')
  assert.equal(calls.presentUser[0].who, null) // 插话路径不聚焦
  assert.equal(ecalls.turnBatch.length, 0)
})

test('@解析:点名乙应答乙,groupAsk 关键词放开多句请求', async () => {
  const { host, calls } = makeHost()
  const { engine, calls: ecalls } = makeEngine()
  const session = mod.createChatSession(host, engine)
  await session.send('@乙 你怎么看')
  await session.whenIdle()
  assert.equal(calls.presentTurn[0].speaker, 'B')
  assert.equal(ecalls.turnBatch[0].groupAsk, false)
  await session.send('你们都说说看法')
  await session.whenIdle()
  assert.equal(ecalls.turnBatch[1].groupAsk, true)
})

test('@解析跟随设置里的角色名', async () => {
  const { host, calls } = makeHost({ names: () => ({ A: '阿呆', B: '阿瓜', C: '团子' }) })
  const { engine } = makeEngine()
  const session = mod.createChatSession(host, engine)
  await session.send('@阿瓜 讲一个')
  await session.whenIdle()
  assert.equal(calls.presentTurn[0].speaker, 'B')
})

test('空文本返回 empty;订阅者在 busy 翻转时收到通知', async () => {
  const { host } = makeHost()
  const { engine } = makeEngine()
  const session = mod.createChatSession(host, engine)
  assert.equal(await session.send('   '), 'empty')
  const events = []
  const un = session.subscribe(() => events.push(session.getSnapshot().busy))
  await session.send('通知我')
  await session.whenIdle()
  un()
  assert.deepEqual(events, [true, false])
})

// ---------- 语音路径(句级提交 / 流式提交点) ----------

/** 可控语音 TTS:started 恒 audible;ended 立即放行(instant)或手动放行 */
function makeTtsVoice(instant = true) {
  const calls = { speakTracked: [], stopped: 0, prefetch: [] }
  const pendings = []
  let released = false // finishAll 之后创建的句柄即时放行(回合收尾不该再被挂住)
  const engine = {
    tts: {
      speak: () => {},
      speakTracked: (who, text) => {
        calls.speakTracked.push({ who, text })
        let fire
        const ended = new Promise((r) => {
          fire = r
        })
        if (instant || released) fire()
        else pendings.push(fire)
        return { started: Promise.resolve('audible'), ended, stop: () => { calls.stopped++; fire() } }
      },
      prefetch: (who, text) => calls.prefetch.push({ who, text }),
    },
  }
  return { engine, calls, finishAll: () => { released = true; pendings.forEach((f) => f()) } }
}

test('语音路径:句级提交——播完才落盘', async () => {
  const { host, calls } = makeHost()
  const { engine, calls: ecalls } = makeEngine({
    turnBatch: async () => [
      { speaker: 'A', text: '第一句', action: 'talk' },
      { speaker: 'A', text: '第二句', action: 'talk' },
    ],
  })
  const tts = makeTtsVoice(false) // ended 手动放行
  const session = mod.createChatSession(host, { ...engine, ...tts.engine, streamTurn: undefined })
  await session.send('讲讲', { voice: true })
  await new Promise((r) => setTimeout(r, 20))
  // 两句都已开声,但还没播完:不应提交
  assert.equal(tts.calls.speakTracked.length, 1) // 第一句在播
  assert.deepEqual(tts.calls.prefetch, [{ who: 'A', text: '第二句' }]) // 第二句已预合成
  assert.ok(!ecalls.recordTurn.some((r) => r.text === '第一句'))
  tts.finishAll()
  await session.whenIdle()
  assert.ok(ecalls.recordTurn.some((r) => r.text === '第一句'))
  assert.ok(ecalls.recordTurn.some((r) => r.text === '第二句'))
  assert.equal(calls.presentTurn.length, 2)
})

test('语音路径:打断——在播句不落盘,句柄级停声', async () => {
  const { host } = makeHost()
  const { engine, calls: ecalls } = makeEngine({
    turnBatch: async () => [{ speaker: 'A', text: '会被打断的句子', action: 'talk' }],
  })
  const tts = makeTtsVoice(false)
  const session = mod.createChatSession(host, { ...engine, ...tts.engine, streamTurn: undefined })
  await session.send('说话', { voice: true })
  await new Promise((r) => setTimeout(r, 20))
  session.cancel()
  await session.whenIdle()
  assert.equal(tts.calls.stopped, 1, 'cancel 应句柄级停声')
  assert.ok(!ecalls.recordTurn.some((r) => r.text === '会被打断的句子'), '打断句不提交')
  assert.equal(session.getSnapshot().busy, false)
})

test('语音路径·流式:首句前失败 → 整段回落 turnBatch(无轻提示)', async () => {
  const { host, calls } = makeHost()
  const { engine, calls: ecalls } = makeEngine()
  const tts = makeTtsVoice(true)
  const session = mod.createChatSession(host, {
    ...engine,
    ...tts.engine,
    // 生成器形状是流式依赖的契约;首句产出前即抛错,故无 yield
    // oxlint-disable-next-line require-yield
    streamTurn: async function* () {
      throw new Error('网络炸了')
    },
  })
  await session.send('来一段', { voice: true })
  await session.whenIdle()
  assert.equal(calls.presentTurn.length, 1)
  assert.equal(calls.presentTurn[0].text, '回:来一段')
  assert.equal(calls.presentFallback.length, 0)
  assert.equal(ecalls.turnBatch.length, 1)
})

test('语音路径·流式:已有句后失败 → 保留已完成句 + 轻提示,不重生成', async () => {
  const { host, calls } = makeHost()
  const { engine, calls: ecalls } = makeEngine()
  const tts = makeTtsVoice(true)
  const session = mod.createChatSession(host, {
    ...engine,
    ...tts.engine,
    streamTurn: async function* (input) {
      yield { speaker: input.target, text: '前半句', action: 'talk' }
      throw new Error('中途断了')
    },
  })
  await session.send('继续', { voice: true })
  await session.whenIdle()
  assert.equal(ecalls.turnBatch.length, 0, '不整段重生成')
  assert.ok(ecalls.recordTurn.some((r) => r.text === '前半句'), '已完成句照常提交')
  assert.equal(calls.presentFallback.length, 1, '只补一句轻提示')
  assert.equal(calls.presentTurn.length, 1)
})

test('记忆不变量:present 的 refs = record 的 refs = 传给生成的 promptFacts(同源派生)', async () => {
  const { host, calls } = makeHost()
  const ctx = {
    selected: [
      { id: 'm1', text: '用户喜欢川菜', source: 'passive', score: 0.8, effectiveStatus: 'active' },
      { id: 'm2', text: '用户住在北京', source: 'passive', score: 0.6, effectiveStatus: 'active' },
    ],
    candidates: [],
    queriedAt: 1,
    promptFacts: ['用户喜欢川菜', '用户住在北京'],
    refs: [
      { id: 'm1', source: 'passive' },
      { id: 'm2', source: 'passive' },
    ],
  }
  const { engine, calls: ecalls } = makeEngine({ memory: ctx })
  const session = mod.createChatSession(host, engine)
  const res = await session.send('随便聊聊')
  assert.equal(res, 'accepted')
  await waitFor(() => calls.presentTurn.length > 0)
  await session.whenIdle()

  // ① 传给生成函数的就是这份上下文(引用相等,非复制)
  assert.equal(ecalls.turnBatch[0].memory, ctx)
  // ② 首句呈现携带 refs;record 的回复首条携带同一组 refs
  assert.deepEqual(calls.presentTurn[0].memoryRefs, ctx.refs)
  const userRec = ecalls.recordTurn.find((r) => r.who === 'user')
  const replyRecs = ecalls.recordTurn.filter((r) => r.who !== 'user')
  assert.ok(userRec.meta?.entryId, '用户轮有稳定 id')
  assert.equal(replyRecs[0].meta?.parentTurnId, userRec.meta.entryId, '回复回链用户轮')
  assert.deepEqual(replyRecs[0].meta?.memoryRefs, ctx.refs)
  // ③ 结构性:refs 与 promptFacts 由同一 selected 派生(改 ctx 即同步变化)
  assert.equal(ctx.promptFacts.length, ctx.refs.length)
})
