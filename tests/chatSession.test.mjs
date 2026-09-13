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
    recordTurn: (who, text) => calls.recordTurn.push({ who, text }),
    historyWindow: () => [],
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
  const { engine } = makeEngine({
    turnBatch: () =>
      new Promise((r) => {
        resolveBatch = r
      }),
  })
  const session = mod.createChatSession(host, engine)
  const res = await session.send('慢问题')
  assert.equal(res, 'accepted')
  assert.equal(session.getSnapshot().busy, true)
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
  assert.equal(calls.presentTurn[0].speaker, 'B')
  await session.whenIdle()
  assert.equal(ecalls.turnBatch[0].groupAsk, false)
  await session.send('你们都说说看法')
  assert.equal(ecalls.turnBatch[1].groupAsk, true)
})

test('@解析跟随设置里的角色名', async () => {
  const { host, calls } = makeHost({ names: () => ({ A: '阿呆', B: '阿瓜', C: '团子' }) })
  const { engine } = makeEngine()
  const session = mod.createChatSession(host, engine)
  await session.send('@阿瓜 讲一个')
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
