// 记忆策略行为矩阵(V3):敏感检测(取严+确定性表) / 确认窗与 assessFact 有效状态 /
// 权威与支持度派生(独立轮加分/同轮不加分/提取封顶) / 证据摘录校验 / 规则匹配四 scope /
// decideFactUpdate 裁决矩阵 / queryMemory 流水线归因(含冲突门控) /
// v1/v2→v3 迁移(不伪造证据) / evict 顺序。全部确定性时间,零 IO。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let policy
let store

before(async () => {
  policy = await import('../src/storage/memoryPolicy.ts')
  store = await import('../src/storage/memoryStore.ts')
})


const DAY = 86_400_000
const NOW = 1_800_000_000_000

/** v3 事实工厂:按需覆盖(evidence 默认一条 implicit 提取,turnId t1) */
function fact(over = {}) {
  return {
    id: 'f1',
    content: '用户喜欢川菜',
    category: 'preference',
    slot: undefined,
    value: undefined,
    volatility: 'changeable',
    sensitivity: 'normal',
    status: 'active',
    createdAt: NOW - 10 * DAY,
    lastSeen: NOW - 10 * DAY,
    pinned: false,
    evidence: [
      { kind: 'model-extraction', turnId: 't1', excerpt: '我很喜欢吃川菜', assertion: 'implicit', at: NOW - 10 * DAY },
    ],
    ...over,
  }
}

/** 提案工厂(裁决矩阵输入) */
function proposal(over = {}) {
  return {
    content: '用户现在住在上海',
    category: 'identity',
    slot: undefined,
    value: undefined,
    volatility: 'changeable',
    sensitivity: 'normal',
    evidence: [
      { kind: 'model-extraction', turnId: 't2', excerpt: '我上个月搬到上海了', assertion: 'explicit', at: NOW },
    ],
    ...over,
  }
}

const extracted = (turnId, at, assertion = 'implicit') => ({
  kind: 'model-extraction',
  turnId,
  excerpt: 'q',
  assertion,
  at,
})

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

// ---------- 确认窗与 assessFact ----------

test('确认窗:slot 政策优先,敏感层级压窗取严,historical/stable 不按时间过期', () => {
  assert.equal(policy.confirmWindowMs(fact({ slot: 'health.allergy', sensitivity: 'restricted' })), 7 * DAY)
  assert.equal(policy.confirmWindowMs(fact({ slot: 'profile.currentResidence', sensitivity: 'private' })), 14 * DAY, 'private 一律 ≤14 天')
  assert.equal(policy.confirmWindowMs(fact({ category: 'preference', sensitivity: 'normal' })), 180 * DAY)
  assert.equal(policy.confirmWindowMs(fact({ volatility: 'historical' })), null)
  assert.equal(policy.confirmWindowMs(fact({ slot: 'profile.name', volatility: 'stable' })), null, '名字类 stable 不按时间失效')
})

test('assessFact:过期/低支持动态判 needs-confirmation,不落盘', () => {
  // changeable 180 天窗,创建 10 天 → active
  assert.equal(policy.assessFact(fact(), { now: NOW }).effectiveStatus, 'active')
  // 200 天前创建 → 过窗(expired)
  const old = fact({ createdAt: NOW - 200 * DAY, lastSeen: NOW - 200 * DAY })
  assert.equal(policy.assessFact(old, { now: NOW }).effectiveStatus, 'needs-confirmation')
  assert.equal(policy.assessFact(old, { now: NOW }).reason, 'expired')
  // 用户确认过则以确认时刻起算:evidence 带 user-confirmed(60 天前)→ 未过 180 天窗
  const confirmed = fact({
    createdAt: NOW - 200 * DAY,
    evidence: [extracted('t1', NOW - 200 * DAY), { kind: 'user-confirmed', at: NOW - 60 * DAY }],
  })
  assert.equal(policy.assessFact(confirmed, { now: NOW }).effectiveStatus, 'active')
  // 用户确认不绕过 changeable 的长期时效:changeable 事实 400 天前确认 → 照样过期
  const staleConfirmed = fact({
    createdAt: NOW - 500 * DAY,
    evidence: [extracted('t1', NOW - 500 * DAY), { kind: 'user-confirmed', at: NOW - 400 * DAY }],
  })
  assert.equal(policy.assessFact(staleConfirmed, { now: NOW }).reason, 'expired')
  // superseded 优先
  assert.equal(policy.assessFact(fact({ status: 'superseded' }), { now: NOW }).effectiveStatus, 'superseded')
  // sensitive private 过 14 天 → needs-confirmation(哪怕类别窗 180 天)
  assert.equal(
    policy.assessFact(fact({ slot: 'profile.currentResidence', sensitivity: 'private', createdAt: NOW - 20 * DAY }), { now: NOW }).reason,
    'expired',
  )
})

test('assessFact:低支持(<0.5)与冲突点名分别给出独立原因', () => {
  // 证据为空在清洗层不会出现,这里直接构造退化证据验证守卫分支
  const degenerate = fact({ evidence: [] })
  const a = policy.assessFact(degenerate, { now: NOW })
  assert.equal(a.effectiveStatus, 'needs-confirmation')
  assert.equal(a.reason, 'low-support')
  const b = policy.assessFact(fact(), { now: NOW, hasOpenConflict: true })
  assert.equal(b.effectiveStatus, 'needs-confirmation')
  assert.equal(b.reason, 'conflict')
})

// ---------- 权威与支持度 ----------

test('authorityOf:取全部证据的最高档,user-edited > user-confirmed > verified > explicit 提取 > implicit 提取 > legacy', () => {
  assert.equal(policy.authorityOf(fact()), 'inferred')
  assert.equal(policy.authorityOf(fact({ evidence: [{ kind: 'legacy', at: 1 }] })), 'legacy')
  assert.equal(policy.authorityOf(fact({ evidence: [extracted('t1', 1, 'explicit')] })), 'explicit')
  assert.equal(policy.authorityOf(fact({ evidence: [extracted('t1', 1, 'unknown')] })), 'inferred', '迁移数据 unknown 按 inferred 档')
  assert.equal(policy.authorityOf(fact({ evidence: [{ kind: 'verified-event', eventId: 'e1', provider: 'p', at: 1 }] })), 'verified')
  assert.equal(policy.authorityOf(fact({ evidence: [extracted('t1', 1), { kind: 'user-confirmed', at: 2 }] })), 'confirmed')
  assert.equal(
    policy.authorityOf(fact({ evidence: [{ kind: 'user-confirmed', at: 2 }, { kind: 'user-edited', text: 'x', at: 3 }] })),
    'authored',
  )
})

test('supportOf:基础分表 + 独立轮 +0.05 + 提取封顶 0.90;同轮重试不加分', () => {
  const one = policy.supportOf(fact())
  assert.equal(one, 0.55, '单条 implicit 提取')
  // 同一 turn 重试:两条同 turnId 证据不加分
  assert.equal(policy.supportOf(fact({ evidence: [extracted('t1', 1), extracted('t1', 2)] })), 0.55, '同 turn 不加分')
  // 不同回合独立重申:+0.05/轮
  assert.equal(policy.supportOf(fact({ evidence: [extracted('t1', 1), extracted('t2', 2), extracted('t3', 3)] })), 0.65)
  // explicit 提取 0.72,重申也封顶 0.90
  assert.equal(
    policy.supportOf(
      fact({ evidence: Array.from({ length: 5 }, (_, i) => extracted(`t${i}`, i, 'explicit')) }),
    ),
    0.9,
    '普通提取最高不超过 0.90',
  )
  // 固定高权威档不参与轮数加分
  assert.equal(policy.supportOf(fact({ evidence: [{ kind: 'user-confirmed', at: 1 }] })), 0.98)
  assert.equal(policy.supportOf(fact({ evidence: [{ kind: 'user-edited', text: 'x', at: 1 }] })), 1.0)
  assert.equal(policy.supportOf(fact({ evidence: [{ kind: 'verified-event', eventId: 'e', provider: 'p', at: 1 }] })), 0.95)
  assert.equal(policy.supportOf(fact({ evidence: [{ kind: 'legacy', at: 1 }] })), 0.5, 'legacy 恰 0.50,不触发低支持')
})

test('evidenceExcerptHolds:归一化后必须能在原文找到;空摘录直接拒', () => {
  assert.ok(policy.evidenceExcerptHolds('我上个月已经搬到上海了', '搬到上海'))
  assert.ok(policy.evidenceExcerptHolds('我上个月已经搬到上海了。', '我上个月已经搬到上海了'))
  assert.ok(!policy.evidenceExcerptHolds('上海最近好热', '我住在上海'), '编造的原句被拦下')
  assert.ok(!policy.evidenceExcerptHolds('随便说点什么', ''))
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

// ---------- decideFactUpdate 裁决矩阵 ----------

test('裁决:同 slot 同值(归一化后)merge;北京市=北京 不新建', () => {
  const live = fact({ slot: 'profile.currentResidence', value: '北京', category: 'identity', sensitivity: 'private' })
  assert.deepEqual(policy.decideFactUpdate(live, proposal({ slot: 'profile.currentResidence', value: '北京市' })), { kind: 'merge' })
  assert.deepEqual(policy.decideFactUpdate(live, proposal({ slot: 'profile.currentResidence', value: '北京' })), { kind: 'merge' })
})

test('裁决:低权威旧事实遇明确陈述/可信事件 → replace;遇含糊提取 → conflict(ambiguous-change)', () => {
  const inferred = fact({ slot: 'profile.currentResidence', value: '北京', category: 'identity', sensitivity: 'private' })
  const legacy = fact({
    slot: 'profile.currentResidence',
    value: '北京',
    category: 'identity',
    sensitivity: 'private',
    evidence: [{ kind: 'legacy', at: NOW - 100 * DAY }],
  })
  assert.deepEqual(
    policy.decideFactUpdate(inferred, proposal({ slot: 'profile.currentResidence', value: '上海' })),
    { kind: 'replace' },
    'inferred + 明确用户陈述 → 替代',
  )
  assert.deepEqual(
    policy.decideFactUpdate(
      inferred,
      proposal({
        slot: 'profile.currentResidence',
        value: '上海',
        evidence: [{ kind: 'verified-event', eventId: 'e1', provider: 'p', at: NOW }],
      }),
    ),
    { kind: 'replace' },
    'inferred + verified-event → 替代',
  )
  assert.deepEqual(
    policy.decideFactUpdate(
      legacy,
      proposal({
        slot: 'profile.currentResidence',
        value: '上海',
        evidence: [{ kind: 'explicit-command', turnId: 't9', excerpt: '记住我住上海', at: NOW }],
      }),
    ),
    { kind: 'replace' },
    'legacy + explicit-command → 替代',
  )
  const implicit = proposal({ slot: 'profile.currentResidence', value: '上海' })
  implicit.evidence = [extracted('t2', NOW, 'implicit')]
  assert.deepEqual(policy.decideFactUpdate(inferred, implicit), { kind: 'conflict', reason: 'ambiguous-change' })
})

test('裁决:人工事实(authored/confirmed)对机器提取的改写一律 conflict(confirmed-fact-changed),verified 也不例外', () => {
  const authored = fact({
    slot: 'profile.currentResidence',
    value: '北京',
    category: 'identity',
    sensitivity: 'private',
    evidence: [{ kind: 'user-edited', text: '住北京', at: NOW - 5 * DAY }],
  })
  const confirmed = fact({
    slot: 'profile.currentResidence',
    value: '北京',
    category: 'identity',
    sensitivity: 'private',
    evidence: [extracted('t1', NOW - 30 * DAY), { kind: 'user-confirmed', at: NOW - 5 * DAY }],
  })
  for (const existing of [authored, confirmed]) {
    assert.deepEqual(
      policy.decideFactUpdate(existing, proposal({ slot: 'profile.currentResidence', value: '上海' })),
      { kind: 'conflict', reason: 'confirmed-fact-changed' },
      `${existing.id ?? '人工'}:普通提取不得静默覆盖`,
    )
    assert.deepEqual(
      policy.decideFactUpdate(
        existing,
        proposal({
          slot: 'profile.currentResidence',
          value: '上海',
          evidence: [{ kind: 'verified-event', eventId: 'e1', provider: 'p', at: NOW }],
        }),
      ),
      { kind: 'conflict', reason: 'confirmed-fact-changed' },
      'authored/confirmed 对 verified-event 也进冲突',
    )
  }
  // 用户亲手改值(user-edited 提案)永远说了算
  assert.deepEqual(
    policy.decideFactUpdate(confirmed, proposal({
      slot: 'profile.currentResidence',
      value: '上海',
      evidence: [{ kind: 'user-edited', text: '改成上海', at: NOW }],
    })),
    { kind: 'replace' },
  )
})

test('裁决:verified 旧事实遇提取 → conflict(lower-authority);verified 对 verified → replace', () => {
  const verified = fact({
    slot: 'profile.currentResidence',
    value: '北京',
    category: 'identity',
    sensitivity: 'private',
    evidence: [{ kind: 'verified-event', eventId: 'e1', provider: 'p', at: NOW - 5 * DAY }],
  })
  assert.deepEqual(policy.decideFactUpdate(verified, proposal({ slot: 'profile.currentResidence', value: '上海' })), {
    kind: 'conflict',
    reason: 'lower-authority',
  })
  assert.deepEqual(
    policy.decideFactUpdate(
      verified,
      proposal({
        slot: 'profile.currentResidence',
        value: '上海',
        evidence: [{ kind: 'verified-event', eventId: 'e2', provider: 'p', at: NOW }],
      }),
    ),
    { kind: 'replace' },
  )
})

test('裁决:开放事实不做值替代——同文/高相似 merge,其余由调用方共存', () => {
  const open = fact()
  assert.deepEqual(policy.decideFactUpdate(open, proposal({ content: '用户喜欢川菜,很爱' })), { kind: 'merge' }, '定位到高相似开放事实 → merge')
  assert.deepEqual(policy.decideFactUpdate(open, proposal()), { kind: 'merge' }, '同文 merge')
  // slot 对不上:coexist(调用方不会把不同 slot 的定位结果传进来)
  assert.deepEqual(policy.decideFactUpdate(open, proposal({ slot: 'profile.currentResidence', value: '上海' })), { kind: 'coexist' })
})

// ---------- 检索流水线 ----------

test('passive 检索:restricted/过期/无关 private 被资格过滤,归因正确', () => {
  const facts = [
    fact({ id: 'a', content: '用户喜欢川菜' }),
    fact({ id: 'b', content: '对花生过敏', slot: 'health.allergy', sensitivity: 'restricted', category: 'identity' }),
    fact({ id: 'c', content: '现在住在上海', slot: 'profile.currentResidence', value: '上海', sensitivity: 'private', category: 'identity', createdAt: NOW - 3 * DAY }),
    fact({ id: 'd', content: '用户在2024年跑过马拉松', volatility: 'historical', category: 'event' }),
  ]
  const { selected, candidates } = policy.queryMemory(facts, {
    query: '晚饭吃什么好',
    purpose: 'passive-context',
    now: NOW,
    n: 3,
  })
  const byId = (id) => candidates.find((c) => c.id === id)
  assert.equal(byId('b').outcome, 'privacy-blocked', 'restricted 永不 passive')
  assert.equal(byId('c').outcome, 'privacy-blocked', 'private 无关不注入(纯相关性闸)')
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
  assert.equal(r1.candidates[0].effectiveStatus, 'needs-confirmation')
  const confirmed = policy.queryMemory(
    [{ ...facts[0], evidence: [...facts[0].evidence, { kind: 'user-confirmed', at: NOW - DAY }] }],
    { query: '今天吃什么', purpose: 'passive-context', now: NOW, n: 3 },
  )
  assert.equal(confirmed.selected.length, 1)
})

test('passive 检索:冲突未解决的 slot 整体封禁(conflict 归因),显式搜索不受限', () => {
  const oldFact = fact({ id: 'res', content: '用户住在北京', slot: 'profile.currentResidence', value: '北京', category: 'identity', sensitivity: 'private' })
  const conflicts = [
    { id: 'c1', slot: 'profile.currentResidence', existingFactId: 'res', proposed: proposal({ slot: 'profile.currentResidence', value: '上海' }), reason: 'confirmed-fact-changed', createdAt: NOW },
  ]
  const r = policy.queryMemory([oldFact], {
    query: '我住哪个城市来着',
    purpose: 'passive-context',
    now: NOW,
    n: 3,
    conflicts,
  })
  assert.equal(r.candidates[0].outcome, 'conflict', '裁决期间不站队')
  assert.equal(r.candidates[0].effectiveStatus, 'needs-confirmation')
  assert.equal(r.selected.length, 0, '同 slot 不允许被动注入')
  // 显式搜索不受冲突门限(带 needs-confirmation 标记返回)
  const search = policy.queryMemory([oldFact], {
    query: '我住哪个城市来着',
    purpose: 'explicit-search',
    now: NOW,
    n: 3,
    conflicts,
  })
  assert.equal(search.selected.length, 1)
  assert.equal(search.selected[0].effectiveStatus, 'needs-confirmation')
  assert.equal(search.selected[0].reason, 'conflict')
})

test('explicit-search 比 passive 宽:可见过期事实但带 needs-confirmation 标记;规则仍然拦截', () => {
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
  assert.ok(selected.some((s) => s.id === 'old' && s.effectiveStatus === 'needs-confirmation' && s.reason === 'expired'))
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
    fact({ id: 'p', content: '用户喜欢川菜', pinned: true }),
    fact({ id: 'q', content: '用户喜欢粤菜', evidence: [extracted('t1', NOW, 'explicit')] }),
    fact({ id: 'r', content: '用户喜欢鲁菜', evidence: [extracted('t1', NOW, 'explicit')] }),
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

// ---------- v1/v2→v3 迁移 ----------

test('v1 迁移:ts→createdAt,敏感检测取严,evidence=legacy(不伪造可定位来源)', () => {
  const v3 = store.sanitizeFact({
    id: 'f-legacy',
    content: '对花生过敏',
    category: 'identity',
    ts: NOW - 100 * DAY,
    lastSeen: NOW - 50 * DAY,
    hits: 3,
    pinned: true,
  })
  assert.equal(v3.createdAt, NOW - 100 * DAY)
  assert.equal(v3.sensitivity, 'restricted', '确定性检测接管敏感层级')
  assert.equal(v3.status, 'active')
  assert.equal(v3.evidence[0].kind, 'legacy')
  assert.equal(v3.confidence, undefined, 'confidence 不再持久化')
  assert.equal(v3.sourceTurnId, undefined)
  assert.equal(v3.lastConfirmedAt, undefined)
  assert.equal(v3.hits, undefined)
  // 迁移即隔离:restricted + 过 7 天窗 → 立即动态 needs-confirmation(pinned 不豁免)
  assert.equal(policy.assessFact(v3, { now: NOW }).reason, 'expired')
})

test('v2→v3 证据映射:extracted→model-extraction(unknown),user-edited/user-confirmed 保真', () => {
  const v3 = store.sanitizeFact({
    id: 'f-v2',
    content: '用户喜欢川菜',
    category: 'preference',
    createdAt: NOW - 30 * DAY,
    lastSeen: NOW - DAY,
    confidence: 0.9,
    sourceTurnId: 't-old',
    sourceExcerpt: '我很喜欢吃川菜',
    lastConfirmedAt: NOW - DAY,
    hits: 4,
    evidence: [
      { kind: 'extracted', turnId: 't-old', excerpt: '我很喜欢吃川菜', at: NOW - 30 * DAY },
      { kind: 'user-edited', turnId: null, excerpt: '超爱川菜', at: NOW - 2 * DAY },
      { kind: 'user-confirmed', turnId: null, excerpt: '', at: NOW - DAY },
    ],
  })
  assert.deepEqual(
    v3.evidence,
    [
      { kind: 'model-extraction', turnId: 't-old', excerpt: '我很喜欢吃川菜', assertion: 'unknown', at: NOW - 30 * DAY },
      { kind: 'user-edited', text: '超爱川菜', at: NOW - 2 * DAY },
      { kind: 'user-confirmed', at: NOW - DAY },
    ],
    '不伪造 assertion 分级',
  )
  assert.equal(policy.assessFact(v3, { now: NOW }).effectiveStatus, 'active', '权威/支持度从证据派生,不依赖旧散字段')
})

test('evict:superseded 优先(保留最近 5 条),总量压回 200;非固定低支持度先丢', () => {
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
  // 低支持度先丢:implicit 提取(0.55)比 explicit 提取(0.72)先出局
  const tight = [
    ...Array.from({ length: 200 }, (_, i) =>
      fact({ id: `hi${i}`, content: `明确事实${i}`, evidence: [extracted(`t${i}`, NOW - i * DAY, 'explicit')] }),
    ),
    fact({ id: 'low', content: '低支持事实', lastSeen: NOW - 500 * DAY }),
  ]
  const trimmed2 = store.evict(tight)
  assert.equal(trimmed2.length, 200)
  assert.ok(!trimmed2.some((f) => f.id === 'low'), '低支持度先丢')
})
