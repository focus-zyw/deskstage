// 记忆摄取器行为矩阵(V3):证据摘录校验(编造原句拒收)/ 同轮重试不加支持度 /
// 跨轮独立重申加分 / 非法 slot 降级不参与槽位替代 / 提取失败账本记 failed 不影响聊天 /
// 禁止规则第二道闸。注入假 extract,零网络;存储走浏览器降级路径(伪造 localStorage)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let ingestorMod
let store
let policy

before(async () => {
  const backing = new Map()
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => void backing.set(k, String(v)),
    removeItem: (k) => void backing.delete(k),
  }
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ingestorMod = await server.ssrLoadModule('/src/memory/ingestor.ts')
  store = await server.ssrLoadModule('/src/storage/memoryStore.ts')
  policy = await server.ssrLoadModule('/src/storage/memoryPolicy.ts')
})

after(async () => server?.close())

const NOW = 1_800_000_000_000

/** 候选工厂 */
const cand = (over = {}) => ({
  content: '用户现在住在上海',
  category: 'identity',
  slot: 'profile.currentResidence',
  value: '上海',
  assertion: 'explicit',
  excerpt: '我上个月已经搬到上海了',
  ...over,
})

function makeIngestor(over = {}) {
  const calls = { extract: [] }
  const ingestor = ingestorMod.createMemoryIngestor({
    known: async () => [],
    extract: async (text, known, diagTurnId) => {
      calls.extract.push({ text, known, diagTurnId })
      if (over.fail) throw new Error('模型挂了')
      return over.candidates ?? []
    },
    now: () => NOW,
  })
  return { ingestor, calls }
}

const residenceFact = () =>
  store.getMemory().then((mem) => mem.facts.find((f) => f.slot === 'profile.currentResidence'))

// ---------- 证据校验 ----------

test('摘录能在原文找到:候选入库,evidence 带 turnId/摘录/assertion', async () => {
  await store.resetAllMemory()
  const { ingestor, calls } = makeIngestor({
    candidates: [cand()],
  })
  const report = await ingestor.ingestUserTurn({ turnId: 't1', text: '我上个月已经搬到上海了,这边挺热。' })
  assert.equal(report.status, 'applied')
  assert.equal(calls.extract[0].diagTurnId, 't1')
  const f = await residenceFact()
  assert.equal(f.value, '上海')
  assert.equal(f.evidence[0].kind, 'model-extraction')
  assert.equal(f.evidence[0].turnId, 't1')
  assert.equal(f.evidence[0].excerpt, '我上个月已经搬到上海了')
  assert.equal(f.evidence[0].assertion, 'explicit')
})

test('摘录不存在于原文:候选被拒,账本记 invalid-evidence,零事实入库', async () => {
  await store.resetAllMemory()
  const { ingestor } = makeIngestor({
    candidates: [cand({ excerpt: '我住在上海' }), cand({ content: '用户喜欢川菜', slot: undefined, value: undefined, excerpt: '很爱吃川菜' })],
  })
  const report = await ingestor.ingestUserTurn({ turnId: 't1', text: '上海最近好热。' })
  assert.equal(report.status, 'skipped')
  assert.equal(report.reason, 'invalid-evidence')
  assert.equal(report.candidateCount, 2)
  const mem = await store.getMemory()
  assert.equal(mem.facts.length, 0, '"上海最近好热"不得推断出住址事实')
})

// ---------- 支持度记账 ----------

test('同一 turnId 重试不增加支持度;不同回合独立重申 +0.05', async () => {
  await store.resetAllMemory()
  const { ingestor } = makeIngestor({ candidates: [cand()] })
  const text = '我上个月已经搬到上海了'
  await ingestor.ingestUserTurn({ turnId: 't1', text })
  const once = policy.supportOf(await residenceFact())
  await ingestor.ingestUserTurn({ turnId: 't1', text, }) // 同轮重试
  assert.equal(policy.supportOf(await residenceFact()), once, '同轮重试不加分')
  await ingestor.ingestUserTurn({ turnId: 't2', text }) // 新一轮重申
  assert.equal(policy.supportOf(await residenceFact()), +(once + 0.05).toFixed(5), '独立轮 +0.05')
  const mem = await store.getMemory()
  assert.equal(mem.facts.length, 1, '重申合并不新建')
})

// ---------- 非法 slot 与规则闸 ----------

test('非法 slot 降级为开放事实,不参与槽位替代', async () => {
  await store.resetAllMemory()
  await store.ingestFacts({
    turnId: 't0',
    proposals: [
      {
        content: '用户住在曹杨新村',
        category: 'identity',
        slot: 'profile.currentResidence',
        value: '上海',
        volatility: 'changeable',
        sensitivity: 'private',
        evidence: [{ kind: 'model-extraction', turnId: 't0', excerpt: 'q', assertion: 'explicit', at: NOW }],
      },
    ],
  })
  const { ingestor } = makeIngestor({
    candidates: [cand({ slot: 'user.currentCity', value: '北京', content: '用户当前在北京', excerpt: '搬到上海' })],
  })
  const report = await ingestor.ingestUserTurn({ turnId: 't1', text: '我搬到上海了' })
  assert.equal(report.status, 'applied')
  const mem = await store.getMemory()
  const slotted = mem.facts.filter((f) => f.slot === 'profile.currentResidence')
  assert.equal(slotted.length, 1, '槽位事实不受非法 slot 候选影响')
  assert.equal(slotted[0].value, '上海')
  const open = mem.facts.find((f) => f.slot === undefined)
  assert.ok(open, '非法 slot 降级为开放事实')
  assert.equal(open.value, undefined)
})

test('命中禁止规则的候选在入库前被拒(第二道闸)', async () => {
  await store.resetAllMemory()
  await store.addRule({ scope: 'phrase', value: '上海' })
  const { ingestor } = makeIngestor({ candidates: [cand()] })
  const report = await ingestor.ingestUserTurn({ turnId: 't1', text: '我上个月已经搬到上海了' })
  assert.equal(report.status, 'skipped')
  assert.equal(report.reason, 'privacy-rule')
  assert.equal((await store.getMemory()).facts.length, 0)
})

// ---------- 失败路径 ----------

test('提取失败:返回 failed 报告(不抛异常),账本记 failed,不影响聊天调用方', async () => {
  await store.resetAllMemory()
  const { ingestor } = makeIngestor({ fail: true })
  const report = await ingestor.ingestUserTurn({ turnId: 't9', text: '随便说点' })
  assert.equal(report.status, 'failed')
  assert.equal(report.reason, 'model-error')
  const mem = await store.getMemory()
  assert.equal(mem.ingestLog.at(-1).status, 'failed')
  assert.equal(mem.ingestLog.at(-1).turnId, 't9')
  // 失败后新一轮照常摄取
  const { ingestor: ok } = makeIngestor({ candidates: [cand()] })
  const r2 = await ok.ingestUserTurn({ turnId: 't10', text: '我上个月已经搬到上海了' })
  assert.equal(r2.status, 'applied')
})

test('空候选:skipped + no-durable-fact;pending 账本被终态替换', async () => {
  await store.resetAllMemory()
  const { ingestor } = makeIngestor({})
  const report = await ingestor.ingestUserTurn({ turnId: 't1', text: '今天天气不错' })
  assert.equal(report.status, 'skipped')
  assert.equal(report.reason, 'no-durable-fact')
  const mem = await store.getMemory()
  assert.equal(mem.ingestLog.filter((r) => r.turnId === 't1').length, 1)
  assert.equal(mem.ingestLog[0].status, 'skipped')
  assert.ok(mem.ingestLog[0].completedAt)
})
