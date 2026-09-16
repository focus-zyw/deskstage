// ContextLifecycleManager 回归(真实 warmStore + 假 chatlog/压缩/Mem0,零网络):
// 位置边界与阈值 / 增量摘要链(previousSummary 传递与覆盖)/ 会话间隙闭合冻结 /
// restricted 消息与摘要的双重处置 / fail-open 重试 / 前积压放弃 / sweep 冲刷。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let lifecycleMod
let warm

before(async () => {
  const values = new Map()
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
  lifecycleMod = await import('../src/context/lifecycle.ts')
  warm = await import('../src/storage/warmStore.ts')
})

const BASE = 1_800_000_000_000
const GAP = 30 * 60_000

/** 组装被测实例:记录压缩调用,Memo0 调用可断言 */
function harness(logList, over = {}) {
  const state = {
    compactCalls: [],
    mem0Calls: [],
    compactResult: '滚动摘要S',
    compactError: null,
  }
  const life = lifecycleMod.createContextLifecycle({
    listTurns: async () => logList(),
    compact: async (input) => {
      state.compactCalls.push(input)
      if (state.compactError) throw state.compactError
      return typeof state.compactResult === 'function' ? state.compactResult(input) : state.compactResult
    },
    addExperienceTurns: async (turns) => {
      state.mem0Calls.push(turns)
      return true
    },
    now: () => BASE + 999_999_999,
    ...over,
  })
  return { life, state }
}

const entry = (n, ts = BASE + n * 1000, text = `消息${n}`) => ({
  id: `t${n}`,
  who: n % 3 === 0 ? 'user' : 'A',
  text,
  ts,
})

test('位置边界:最新 10 条保持原文,pending 够 8 条触发一次压缩并全部折叠', async () => {
  await warm.resetWarm()
  const entries = Array.from({ length: 18 }, (_, i) => entry(i))
  const { life, state } = harness(() => entries)
  await life.observeTurn({ id: 't18', who: 'user', text: '新消息', ts: BASE + 18_000 })
  assert.equal(state.compactCalls.length, 1)
  assert.equal(state.compactCalls[0].turns.length, 8) // 18 - 10 = 8
  assert.deepEqual(state.compactCalls[0].previousSummary, '')
  const session = await warm.currentSession()
  assert.equal(session.foldedTurnIds.length, 8)
  assert.equal(session.rollingSummary, '滚动摘要S')
  // mem0 收到同一批(who/text/ts 齐全)
  assert.equal(state.mem0Calls.at(-1).length, 8)
  assert.ok(state.mem0Calls.at(-1)[0].ts > 0)
})

test('pending 不足阈值:不触发压缩', async () => {
  await warm.resetWarm()
  const entries = Array.from({ length: 17 }, (_, i) => entry(i)) // pending 7
  const { life, state } = harness(() => entries)
  await life.observeTurn({ id: 't17', who: 'user', text: '新消息', ts: BASE + 17_000 })
  assert.equal(state.compactCalls.length, 0)
})

test('增量摘要链:第二次压缩收到第一次的结果,rollingSummary 覆盖累进', async () => {
  await warm.resetWarm()
  const entries = Array.from({ length: 18 }, (_, i) => entry(i))
  const { life, state } = harness(() => entries)
  state.compactResult = (input) => `S<-${input.previousSummary || '空'}`
  await life.observeTurn({ id: 't18', who: 'user', text: '新消息', ts: BASE + 18_000 })
  // 再滑出 8 条:窗口往前推,新 pending 出现
  entries.push(...Array.from({ length: 10 }, (_, i) => entry(18 + i, BASE + 18_000 + i * 1000)))
  await life.observeTurn({ id: 't28', who: 'user', text: '再聊', ts: BASE + 28_000 })
  assert.equal(state.compactCalls.length, 2)
  assert.equal(state.compactCalls[1].previousSummary, 'S<-空')
  const session = await warm.currentSession()
  assert.equal(session.rollingSummary, 'S<-S<-空')
})

test('会话间隙:间隔超 30 分钟先冻结再开新会话,集摘要进 episodes', async () => {
  await warm.resetWarm()
  const entries = Array.from({ length: 18 }, (_, i) => entry(i))
  const { life, state } = harness(() => entries)
  state.compactResult = '会话内容摘要'
  await life.observeTurn({ id: 't18', who: 'user', text: '新消息', ts: BASE + 18_000 })
  // 31 分钟后的下一条:触发闭合
  await life.observeTurn({ id: 'g1', who: 'user', text: '隔天再聊', ts: BASE + 18_000 + GAP + 60_000 })
  assert.equal((await warm.listEpisodes()).length, 1)
  assert.equal((await warm.listEpisodes())[0].summary, '会话内容摘要')
  assert.equal(state.compactCalls.length, 1) // 旧消息不再被折进新会话(全局账本防重)
  const fresh = await warm.currentSession()
  assert.notEqual(fresh.id, null)
  assert.equal(fresh.rollingSummary, '')
  assert.equal(fresh.foldedTurnIds.length, 0)
})

test('restricted 消息:不进压缩输入,但折叠位照常推进;Mem0 也收不到', async () => {
  await warm.resetWarm()
  const entries = Array.from({ length: 18 }, (_, i) => entry(i, BASE + i * 1000, i === 3 ? '我对芒果过敏服药中' : `消息${i}`))
  const { life, state } = harness(() => entries)
  await life.observeTurn({ id: 't18', who: 'user', text: '新消息', ts: BASE + 18_000 })
  assert.ok(!state.compactCalls[0].turns.some((t) => /过敏/.test(t.text)))
  assert.ok(!state.mem0Calls.at(-1).some((t) => /过敏/.test(t.text)))
  const session = await warm.currentSession()
  assert.equal(session.foldedTurnIds.length, 8) // 折叠位含被过滤的消息
})

test('摘要含 restricted:丢弃新摘要保留旧的,折叠位照常推进(遗忘)', async () => {
  await warm.resetWarm()
  const entries = Array.from({ length: 18 }, (_, i) => entry(i))
  const { life, state } = harness(() => entries)
  state.compactResult = '用户提到过敏药的事'
  await life.observeTurn({ id: 't18', who: 'user', text: '新消息', ts: BASE + 18_000 })
  const session = await warm.currentSession()
  assert.equal(session.rollingSummary, '') // 新摘要被丢弃
  assert.equal(session.foldedTurnIds.length, 8)
})

test('压缩失败 fail-open:pending 原样保留,下次重试成功', async () => {
  await warm.resetWarm()
  const entries = Array.from({ length: 18 }, (_, i) => entry(i))
  const { life, state } = harness(() => entries)
  state.compactError = new Error('模型超时')
  await life.observeTurn({ id: 't18', who: 'user', text: '新消息', ts: BASE + 18_000 })
  assert.equal(state.compactCalls.length, 1)
  let session = await warm.currentSession()
  assert.equal(session.foldedTurnIds.length, 0) // 未折叠 ⇒ 待重试
  state.compactError = null
  await life.observeTurn({ id: 't19', who: 'user', text: '再来', ts: BASE + 19_000 })
  session = await warm.currentSession()
  assert.ok(session.foldedTurnIds.length >= 8)
})

test('前积压超 40 条:最旧的直接放弃,不进摘要', async () => {
  await warm.resetWarm()
  const entries = Array.from({ length: 55 }, (_, i) => entry(i))
  const { life, state } = harness(() => entries)
  await life.observeTurn({ id: 't55', who: 'user', text: '新消息', ts: BASE + 55_000 })
  assert.equal(state.compactCalls[0].turns[0].text, '消息5') // t0..t4 已放弃
  const data = await warm.getWarmData()
  assert.ok(data.foldedTurnIds.includes('t0')) // 全局账本记为已放弃
  assert.equal(data.foldedTurnIds.length, 17) // 5 放弃 + 12 折叠
  const session = await warm.currentSession()
  assert.equal(session.foldedTurnIds.length, 12) // 会话只记自己摘要覆盖的
})

test('sweep:冲到无可折叠为止', async () => {
  await warm.resetWarm()
  const entries = Array.from({ length: 30 }, (_, i) => entry(i)) // pending 20
  const { life } = harness(() => entries)
  const folded = await life.sweep()
  assert.equal(folded, 20)
  const session = await warm.currentSession()
  assert.equal(session.foldedTurnIds.length, 20)
})
