// 记忆策略行为矩阵:敏感检测(取严+确定性表) / 确认窗与有效状态 / 2-gram 相关性 /
// 规则匹配四 scope / slot 冲突三分类(规范化后比较) / queryMemory 流水线归因 /
// v1→v2 迁移(敏感隔离) / evict 顺序。全部确定性时间,零 IO。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let policy
let store

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  policy = await server.ssrLoadModule('/src/storage/memoryPolicy.ts')
  store = await server.ssrLoadModule('/src/storage/memoryStore.ts')
})

after(async () => server?.close())

const DAY = 86_400_000
const NOW = 1_800_000_000_000

/** v2 事实工厂:按需覆盖 */
function fact(over = {}) {
  return {
    id: 'f1',
    content: '用户喜欢川菜',
    category: 'preference',
    slot: undefined,
    value: undefined,
    confidence: 0.8,
    volatility: 'changeable',
    sensitivity: 'normal',
    status: 'active',
    sourceTurnId: 't1',
    sourceExcerpt: '我很喜欢吃川菜',
    createdAt: NOW - 10 * DAY,
    lastSeen: NOW - 10 * DAY,
    lastConfirmedAt: null,
    pinned: false,
    hits: 1,
    evidence: [{ turnId: 't1', excerpt: '我很喜欢吃川菜', at: NOW - 10 * DAY, kind: 'extracted' }],
    ...over,
  }
}

// ---------- 敏感检测 ----------

test('敏感检测:restricted 高精度表(山药不误伤),private 次之,其余 normal', () => {
  assert.equal(policy.detectSensitivity('对花生过敏'), 'restricted')
  assert.equal(policy.detectSensitivity('在吃胰岛素'), 'restricted')
  assert.equal(policy.detectSensitivity('身份证丢了'), 'restricted')
  assert.equal(policy.detectSensitivity('喜欢吃山药'), 'normal', '单"药"字不触发')
  assert.equal(policy.detectSensitivity('现在住在上海'), 'private')
  assert.equal(policy.detectSensitivity('工资一万二'), 'private')
  assert.equal(policy.detectSensitivity('用户叫小张'), 'normal')
  assert.equal(policy.detectSensitivity('喜欢川菜'), 'normal')
})

test('敏感度取严合并:任何一源判敏即敏,不是 AND', () => {
  assert.equal(policy.maxSensitivity('normal', 'restricted', 'normal'), 'restricted')
  assert.equal(policy.maxSensitivity('private', undefined, 'normal'), 'private')
})

// ---------- 确认窗与有效状态 ----------

test('确认窗:slot 政策优先,敏感层级压窗取严,historical/stable 不按时间过期', () => {
  assert.equal(policy.confirmWindowMs(fact({ slot: 'health.allergy', sensitivity: 'restricted' })), 7 * DAY)
  assert.equal(policy.confirmWindowMs(fact({ slot: 'profile.currentResidence', sensitivity: 'private' })), 14 * DAY, 'private 一律 ≤14 天')
  assert.equal(policy.confirmWindowMs(fact({ category: 'preference', sensitivity: 'normal' })), 180 * DAY)
  assert.equal(policy.confirmWindowMs(fact({ volatility: 'historical' })), null)
  assert.equal(policy.confirmWindowMs(fact({ slot: 'profile.name', volatility: 'stable' })), null, '名字类 stable 不按时间失效')
})

test('有效状态:过期/低置信动态判 needs_confirmation,不落盘', () => {
  // changeable 180 天窗,创建 10 天且从未确认 → active
  assert.equal(policy.effectiveStatus(fact(), NOW), 'active')
  // 200 天前创建 → 过窗
  assert.equal(policy.effectiveStatus(fact({ createdAt: NOW - 200 * DAY, lastSeen: NOW - 200 * DAY }), NOW), 'needs_confirmation')
  // 确认过则以 lastConfirmedAt 起算:60 天前确认 → 未过 180 天窗
  assert.equal(policy.effectiveStatus(fact({ createdAt: NOW - 200 * DAY, lastConfirmedAt: NOW - 60 * DAY }), NOW), 'active')
  // 低置信直接 needs_confirmation
  assert.equal(policy.effectiveStatus(fact({ confidence: 0.3 }), NOW), 'needs_confirmation')
  // superseded 优先
  assert.equal(policy.effectiveStatus(fact({ status: 'superseded' }), NOW), 'superseded')
  // sensitive private 过 14 天 → needs_confirmation(哪怕类别窗 180 天)
  assert.equal(
    policy.effectiveStatus(fact({ slot: 'profile.currentResidence', sensitivity: 'private', createdAt: NOW - 20 * DAY }), NOW),
    'needs_confirmation',
  )
})

// ---------- 规则匹配 ----------

test('规则匹配:四 scope 各自精确生效', () => {
  const f = fact({ slot: 'profile.currentResidence', sensitivity: 'private' })
  assert.ok(policy.ruleMatches(f, { id: 'r', scope: 'slot', value: 'profile.currentResidence', createdAt: 0 }))
  assert.ok(policy.ruleMatches(f, { id: 'r', scope: 'category', value: 'preference', createdAt: 0 }))
  assert.ok(policy.ruleMatches(f, { id: 'r', scope: 'sensitivity', value: 'private', createdAt: 0 }))
  assert.ok(policy.ruleMatches(f, { id: 'r', scope: 'phrase', value: '川菜', createdAt: 0 }))
  assert.ok(!policy.ruleMatches(f, { id: 'r', scope: 'slot', value: 'profile.hometown', createdAt: 0 }))
  assert.ok(!policy.ruleMatches(fact({ slot: undefined }), { id: 'r', scope: 'slot', value: 'profile.name', createdAt: 0 }))
})

// ---------- slot 冲突分类 ----------

test('slot 冲突:同 slot 异值 supersede,同 slot 同值新轮 reaffirm,无 slot 不判', () => {
  const live = fact({ slot: 'profile.currentResidence', value: '北京' })
  assert.equal(
    policy.classifyIncoming(live, { slot: 'profile.currentResidence', value: '上海', turnId: 't2' }),
    'supersede',
  )
  // 规范化后同值("北京市"→"北京"):不是冲突,是新轮重申
  assert.equal(
    policy.classifyIncoming(live, { slot: 'profile.currentResidence', value: '北京市', turnId: 't2' }),
    'reaffirm',
  )
  // 同值但同一轮的重复提取:不算用户重申
  assert.equal(
    policy.classifyIncoming(live, { slot: 'profile.currentResidence', value: '北京', turnId: 't1' }),
    'none',
  )
  // 无 slot / 不同 slot:不判冲突(2-gram 不可靠)
  assert.equal(policy.classifyIncoming(fact({ slot: undefined }), { slot: undefined, value: '北京' }), 'none')
  assert.equal(
    policy.classifyIncoming(live, { slot: 'profile.hometown', value: '北京', turnId: 't2' }),
    'none',
  )
})

// ---------- 检索流水线 ----------

test('passive 检索:restricted/needs_confirmation/无关 private 被资格过滤,归因正确', () => {
  const facts = [
    fact({ id: 'a', content: '用户喜欢川菜' }),
    fact({ id: 'b', content: '对花生过敏', slot: 'health.allergy', sensitivity: 'restricted', category: 'identity' }),
    fact({ id: 'c', content: '现在住在上海', slot: 'profile.currentResidence', value: '上海', sensitivity: 'private', category: 'identity', createdAt: NOW - 3 * DAY }),
    fact({ id: 'd', content: '用户在2024年跑过马拉松', volatility: 'historical', category: 'event', confidence: 0.8 }),
  ]
  const { selected, candidates } = policy.queryMemory(facts, {
    query: '晚饭吃什么好',
    purpose: 'passive-context',
    now: NOW,
    n: 3,
  })
  const byId = (id) => candidates.find((c) => c.id === id)
  assert.equal(byId('b').outcome, 'privacy-blocked', 'restricted 永不 passive')
  assert.equal(byId('c').outcome, 'privacy-blocked', 'private 无关不注入(未过确认窗,纯相关性闸)')
  assert.equal(byId('d').outcome, 'irrelevant', 'historical 不相关不浮出')
  assert.ok(selected.some((s) => s.id === 'a'))
  assert.equal(selected[0].source, 'passive')
})

test('passive 检索:过期事实不注入(expired);确认后恢复', () => {
  const facts = [
    fact({ id: 'old', content: '用户喜欢川菜', createdAt: NOW - 400 * DAY, lastSeen: NOW - 400 * DAY }),
  ]
  const r1 = policy.queryMemory(facts, { query: '今天吃什么', purpose: 'passive-context', now: NOW, n: 3 })
  assert.equal(r1.candidates[0].outcome, 'expired')
  assert.equal(r1.candidates[0].effectiveStatus, 'needs_confirmation')
  // 用户确认 → lastConfirmedAt 刷新 → 恢复注入
  const r2 = policy.queryMemory(
    [facts[0]],
    { query: '今天吃什么', purpose: 'passive-context', now: NOW, n: 3 },
  )
  void r2
  const confirmed = policy.queryMemory(
    [{ ...facts[0], lastConfirmedAt: NOW - DAY }],
    { query: '今天吃什么', purpose: 'passive-context', now: NOW, n: 3 },
  )
  assert.equal(confirmed.selected.length, 1)
})

test('explicit-search 比 passive 宽:可见过期事实但带 needs_confirmation 标记;规则仍然拦截', () => {
  const facts = [
    fact({ id: 'old', content: '用户喜欢川菜', createdAt: NOW - 400 * DAY, lastSeen: NOW - 400 * DAY }),
    fact({ id: 'sec', content: '住在长宁路88号', sensitivity: 'private' }),
  ]
  const { selected } = policy.queryMemory(facts, {
    query: '用户住在哪',
    purpose: 'explicit-search',
    now: NOW,
    n: 5,
  })
  assert.ok(selected.some((s) => s.id === 'old' && s.effectiveStatus === 'needs_confirmation'))
  // 显式搜索比 passive 宽:private 无关也可被用户主动搜到(source=search-tool)
  assert.ok(selected.some((s) => s.id === 'sec' && s.source === 'search-tool'))
  // 规则对显式搜索照样生效
  const blocked = policy.queryMemory(facts, {
    query: '用户住在哪',
    purpose: 'explicit-search',
    now: NOW,
    n: 5,
    rules: [{ id: 'r', scope: 'phrase', value: '长宁路', createdAt: 0 }],
  })
  assert.equal(blocked.candidates.find((c) => c.id === 'sec').outcome, 'privacy-blocked')
})

test('排序与 limit:pinned 加权优先,超出名额归因 limit', () => {
  const facts = [
    fact({ id: 'p', content: '用户喜欢川菜', pinned: true, confidence: 0.5 }),
    fact({ id: 'q', content: '用户喜欢粤菜', confidence: 0.9 }),
    fact({ id: 'r', content: '用户喜欢鲁菜', confidence: 0.9 }),
  ]
  const { selected, candidates } = policy.queryMemory(facts, {
    query: '喜欢吃什么菜',
    purpose: 'passive-context',
    now: NOW,
    n: 2,
  })
  assert.equal(selected.length, 2)
  assert.equal(selected[0].id, 'p', 'pinned +0.3 加权登顶')
  const outs = candidates.filter((c) => c.id === 'r').map((c) => c.outcome)
  assert.ok(outs.includes('limit'))
})

// ---------- v1→v2 迁移与淘汰 ----------

test('v1 迁移:ts→createdAt,lastConfirmedAt=null,敏感检测取严,evidence=legacy', () => {
  const v2 = store.sanitizeFact({
    id: 'f-legacy',
    content: '对花生过敏',
    category: 'identity',
    ts: NOW - 100 * DAY,
    lastSeen: NOW - 50 * DAY,
    hits: 3,
    pinned: true,
  })
  assert.equal(v2.version, undefined)
  assert.equal(v2.createdAt, NOW - 100 * DAY)
  assert.equal(v2.lastConfirmedAt, null, '从未被用户确认')
  assert.equal(v2.confidence, 0.6)
  assert.equal(v2.sensitivity, 'restricted', '确定性检测接管敏感层级')
  assert.equal(v2.status, 'active')
  assert.equal(v2.evidence[0].kind, 'legacy')
  assert.equal(v2.evidence[0].turnId, null, '不伪造可定位来源')
  // 迁移即隔离:restricted + 从未确认 → 立即动态 needs_confirmation(pinned 不豁免)
  assert.equal(policy.effectiveStatus(v2, NOW), 'needs_confirmation')
})

test('evict:superseded 优先(保留最近 5 条),总量压回 200', () => {
  const facts = []
  for (let i = 0; i < 10; i++) {
    facts.push(fact({ id: `s${i}`, content: `替代历史${i}`, status: 'superseded', lastSeen: NOW - i * DAY }))
  }
  for (let i = 0; i < 190; i++) facts.push(fact({ id: `n${i}`, content: `活跃事实${i}` }))
  facts.push(fact({ id: 'overflow', content: '挤出位' }))
  const trimmed = store.evict(facts)
  assert.equal(trimmed.length, 200)
  assert.ok(!trimmed.some((f) => f.id === 's9'), '最旧的 superseded 先丢')
  assert.ok(trimmed.some((f) => f.id === 's4'), '保留最近 5 条 superseded(s0..s4)')
  assert.ok(trimmed.some((f) => f.id === 'overflow'), '活跃事实不被丢')
})

test('evict:无 superseded 可丢时,非固定的低置信最旧者先丢,敏感不豁免', () => {
  const facts = []
  for (let i = 0; i < 195; i++) facts.push(fact({ id: `n${i}`, content: `事实${i}`, confidence: 0.9, lastSeen: NOW - i * DAY }))
  facts.push(fact({ id: 'low', content: '低置信事实', confidence: 0.2, lastSeen: NOW - 500 * DAY }))
  facts.push(fact({ id: 'sec', content: '对芒果过敏', confidence: 0.8, sensitivity: 'restricted', lastSeen: NOW - 200 * DAY }))
  const trimmed = store.evict(facts) // 197 条,不超限
  assert.equal(trimmed.length, 197)
  // 超限:再塞 5 条 → 需要丢 5 条,低置信的 low 与敏感 sec 按置信/新旧参与排序,不豁免
  for (let i = 0; i < 5; i++) trimmed.push(fact({ id: `x${i}`, content: `新增${i}`, confidence: 0.95, lastSeen: NOW }))
  const trimmed2 = store.evict(trimmed)
  assert.equal(trimmed2.length, 200)
  assert.ok(!trimmed2.some((f) => f.id === 'low'), '低置信先丢')
})
