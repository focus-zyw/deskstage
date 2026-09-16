// 记忆账本行为矩阵(V3 store 层):原子摄取(事实/冲突/账本一次提交)/ slot 冲突路径
// (北京变上海不再双 active)/ 人工事实硬保护 / 冲突二选一 / verified-event 幂等 /
// 禁止规则入库闸 / pending→failed 账本 / V2→V3 迁移幂等 / 话题口味不受迁移影响。
// 浏览器降级路径:伪造 localStorage,零 IO 零网络。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let store
let policy

before(async () => {
  // 浏览器降级存储:内存 Map 顶替 localStorage(必须在首次 loadRaw 之前就位)
  const backing = new Map()
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => void backing.set(k, String(v)),
    removeItem: (k) => void backing.delete(k),
  }
  store = await import('../src/storage/memoryStore.ts')
  policy = await import('../src/storage/memoryPolicy.ts')
})


const DAY = 86_400_000
const NOW = Date.now()

/** 提案工厂:默认 implicit 提取证据;北京/上海用例给 explicit */
function prop(over = {}) {
  return {
    content: '用户喜欢川菜',
    category: 'preference',
    slot: undefined,
    value: undefined,
    volatility: undefined,
    sensitivity: undefined,
    evidence: [
      { kind: 'model-extraction', turnId: 't1', excerpt: '摘录', assertion: 'implicit', at: NOW },
    ],
    ...over,
  }
}

const residence = (value, content, turnId, assertion = 'explicit') =>
  prop({
    content,
    category: 'identity',
    slot: 'profile.currentResidence',
    value,
    sensitivity: 'private',
    evidence: [{ kind: 'model-extraction', turnId, excerpt: '原句', assertion, at: NOW }],
  })

/** 每例独立起点:全量重置(含规则与账本) */
async function freshStore() {
  await store.resetAllMemory()
}

// ---------- 原子摄取:slot 冲突路径 ----------

test('北京变上海:旧事实 superseded(supersededBy 指向新事实),同 slot 只剩一个可注入 active', async () => {
  await freshStore()
  const r1 = await store.ingestFacts({ turnId: 't1', proposals: [residence('北京', '用户住在北京', 't1', 'implicit')] })
  assert.equal(r1.status, 'applied')
  const r2 = await store.ingestFacts({ turnId: 't2', proposals: [residence('上海', '用户搬到上海了', 't2')] })
  assert.equal(r2.status, 'applied')
  assert.equal(r2.supersededFactIds.length, 1, '旧事实被替代')
  const mem = await store.getMemory()
  const actives = mem.facts.filter((f) => f.status === 'active' && f.slot === 'profile.currentResidence')
  assert.equal(actives.length, 1, '同 slot 不允许两个 active')
  assert.equal(actives[0].value, '上海')
  const oldFact = mem.facts.find((f) => f.status === 'superseded')
  assert.equal(oldFact.value, '北京')
  assert.equal(oldFact.supersededBy, actives[0].id)
  // 检索侧:上海可注入(private 需过相关性闸,查询与事实重合),北京已替代不可
  const ctx = await store.prepareTurnMemory({ query: '用户搬到上海了吗', n: 5 })
  assert.ok(ctx.promptFacts.some((t) => t.includes('上海')))
  assert.ok(!ctx.promptFacts.some((t) => t.includes('北京')))
})

test('同 slot 同值重申:合并不新建;同轮重复摄取不产生重复事实', async () => {
  await freshStore()
  await store.ingestFacts({ turnId: 't1', proposals: [residence('北京', '用户住在北京', 't1', 'implicit')] })
  const r2 = await store.ingestFacts({ turnId: 't2', proposals: [residence('北京市', '用户住在北京', 't2', 'implicit')] })
  assert.equal(r2.status, 'applied')
  assert.equal(r2.supersededFactIds.length, 0)
  const mem = await store.getMemory()
  assert.equal(mem.facts.filter((f) => f.slot === 'profile.currentResidence').length, 1, '归一化同值合并且不新建')
  // 同一轮再摄取一次(重试场景):仍然只有一条
  await store.ingestFacts({ turnId: 't2', proposals: [residence('北京', '用户住在北京', 't2', 'implicit')] })
  const mem2 = await store.getMemory()
  assert.equal(mem2.facts.filter((f) => f.slot === 'profile.currentResidence').length, 1)
})

test('人工编辑的事实不被普通提取覆盖:进冲突队列,旧值保持 active,slot 停止被动注入', async () => {
  await freshStore()
  await store.ingestFacts({ turnId: 't1', proposals: [residence('北京', '用户住在北京', 't1', 'implicit')] })
  await store.editFact(
    (await store.getMemory()).facts.find((f) => f.slot === 'profile.currentResidence').id,
    '我住北京朝阳区',
  )
  const factId = (await store.getMemory()).facts.find((f) => f.status === 'active' && f.slot === 'profile.currentResidence').id
  const r = await store.ingestFacts({ turnId: 't2', proposals: [residence('上海', '用户搬到上海了', 't2', 'implicit')] })
  assert.equal(r.status, 'conflict', '不静默覆盖')
  assert.equal(r.appliedFactIds.length, 0)
  assert.equal(r.conflictIds.length, 1)
  const mem = await store.getMemory()
  const active = mem.facts.filter((f) => f.status === 'active' && f.slot === 'profile.currentResidence')
  assert.equal(active.length, 1, '仍然只有旧值一个 active')
  assert.equal(active[0].id, factId)
  assert.equal(mem.conflicts.length, 1)
  assert.equal(mem.conflicts[0].reason, 'confirmed-fact-changed')
  assert.equal(mem.conflicts[0].existingFactId, factId)
  assert.equal(mem.conflicts[0].proposed.value, '上海')
  // 冲突未解决:该 slot 不被动注入(裁决期间不站队)
  const ctx = await store.prepareTurnMemory({ query: '我住哪个城市', n: 5 })
  assert.ok(!ctx.promptFacts.some((t) => t.includes('北京')))
  assert.ok(!ctx.promptFacts.some((t) => t.includes('上海')))
  assert.ok(ctx.candidates.some((c) => c.outcome === 'conflict'))
})

test('冲突二选一(keep):旧事实追加 user-confirmed,冲突清除,slot 恢复注入', async () => {
  await freshStore()
  await store.ingestFacts({ turnId: 't1', proposals: [residence('北京', '用户住在北京', 't1', 'implicit')] })
  await store.editFact((await store.getMemory()).facts.find((f) => f.slot === 'profile.currentResidence').id, '我住北京朝阳区')
  await store.ingestFacts({ turnId: 't2', proposals: [residence('上海', '用户搬到上海了', 't2', 'implicit')] })
  const conflictId = (await store.getMemory()).conflicts[0].id
  const oldId = (await store.getMemory()).conflicts[0].existingFactId
  await store.resolveConflict(conflictId, 'keep')
  const mem = await store.getMemory()
  assert.equal(mem.conflicts.length, 0)
  const kept = mem.facts.find((f) => f.id === oldId)
  assert.equal(kept.status, 'active')
  assert.ok(kept.evidence.some((e) => e.kind === 'user-confirmed'), '保留旧值 = 用户确认证据')
  const ctx = await store.prepareTurnMemory({ query: '我住在北京朝阳区吗', n: 5 })
  assert.ok(ctx.promptFacts.some((t) => t.includes('北京')), '裁决后恢复注入')
})

test('冲突二选一(accept):旧事实 superseded(supersededBy),新值事实 active 并带 user-confirmed', async () => {
  await freshStore()
  await store.ingestFacts({ turnId: 't1', proposals: [residence('北京', '用户住在北京', 't1', 'implicit')] })
  await store.editFact((await store.getMemory()).facts.find((f) => f.slot === 'profile.currentResidence').id, '我住北京朝阳区')
  await store.ingestFacts({ turnId: 't2', proposals: [residence('上海', '用户搬到上海了', 't2', 'implicit')] })
  const before = await store.getMemory()
  const conflict = before.conflicts[0]
  await store.resolveConflict(conflict.id, 'accept')
  const mem = await store.getMemory()
  assert.equal(mem.conflicts.length, 0)
  const actives = mem.facts.filter((f) => f.status === 'active' && f.slot === 'profile.currentResidence')
  assert.equal(actives.length, 1)
  assert.equal(actives[0].value, '上海')
  assert.ok(actives[0].evidence.some((e) => e.kind === 'user-confirmed'), '接受新值 = 用户确认证据')
  assert.equal(policy.authorityOf(actives[0]), 'confirmed')
  const oldFact = mem.facts.find((f) => f.id === conflict.existingFactId)
  assert.equal(oldFact.status, 'superseded')
  assert.equal(oldFact.supersededBy, actives[0].id)
})

test('同 slot 多条冲突提议:只保留最新一张冲突单', async () => {
  await freshStore()
  await store.ingestFacts({ turnId: 't1', proposals: [residence('北京', '用户住在北京', 't1', 'implicit')] })
  await store.editFact((await store.getMemory()).facts.find((f) => f.slot === 'profile.currentResidence').id, '我住北京朝阳区')
  await store.ingestFacts({ turnId: 't2', proposals: [residence('上海', '搬到上海', 't2', 'implicit')] })
  await store.ingestFacts({ turnId: 't3', proposals: [residence('杭州', '搬去杭州', 't3', 'implicit')] })
  const mem = await store.getMemory()
  assert.equal(mem.conflicts.length, 1, '同 slot 一张裁决单')
  assert.equal(mem.conflicts[0].proposed.value, '杭州', '以最近一次用户陈述为准')
})

// ---------- 账本与原子性 ----------

test('摄取原子提交:一次 ingestFacts 后事实/冲突/账本终态同时可见', async () => {
  await freshStore()
  const r = await store.ingestFacts({
    turnId: 't1',
    proposals: [residence('北京', '用户住在北京', 't1', 'implicit'), prop()],
  })
  assert.equal(r.status, 'applied')
  const mem = await store.getMemory()
  assert.equal(mem.facts.length, 2)
  assert.equal(mem.ingestLog.length, 1)
  const rec = mem.ingestLog[0]
  assert.equal(rec.status, 'applied')
  assert.equal(rec.turnId, 't1')
  assert.equal(rec.candidateCount, 2)
  assert.deepEqual(rec.appliedFactIds, r.appliedFactIds)
  assert.equal(mem.version, 3)
})

test('空候选/证据全无效/规则命中分别给出 skipped 原因', async () => {
  await freshStore()
  const r0 = await store.ingestFacts({ turnId: 't1', proposals: [] })
  assert.equal(r0.status, 'skipped')
  assert.equal(r0.reason, 'no-durable-fact')
  const r1 = await store.ingestFacts({ turnId: 't2', proposals: [], candidateCount: 2, invalidCount: 2 })
  assert.equal(r1.reason, 'invalid-evidence')
  await store.addRule({ scope: 'phrase', value: '花生' })
  const r2 = await store.ingestFacts({ turnId: 't3', proposals: [prop({ content: '用户对花生过敏' })] })
  assert.equal(r2.status, 'skipped')
  assert.equal(r2.reason, 'privacy-rule')
  assert.equal((await store.getMemory()).facts.length, 0, '命中规则的内容永不入库')
})

test('pending→failed 账本:提取失败留下 failed 记录,可继续新一轮摄取', async () => {
  await freshStore()
  await store.beginIngestRecord('t9')
  let mem = await store.getMemory()
  assert.equal(mem.ingestLog.at(-1).status, 'pending')
  await store.failIngestRecord('t9', 'model-error')
  mem = await store.getMemory()
  assert.equal(mem.ingestLog.length, 1, 'pending 被终态替换')
  assert.equal(mem.ingestLog[0].status, 'failed')
  assert.equal(mem.ingestLog[0].reason, 'model-error')
  assert.ok(mem.ingestLog[0].completedAt)
  // 账本容量:超出 150 截最旧
  for (let i = 0; i < 160; i++) await store.failIngestRecord(`burst${i}`, 'model-error')
  mem = await store.getMemory()
  assert.ok(mem.ingestLog.length <= 150)
})

// ---------- verified-event ----------

test('verified-event:可替代 inferred 旧值;同 eventId 幂等不重复写入', async () => {
  await freshStore()
  await store.ingestFacts({ turnId: 't1', proposals: [residence('北京', '用户住在北京', 't1', 'implicit')] })
  const input = {
    eventId: 'evt-1',
    provider: 'live-platform',
    content: '观众现居上海',
    category: 'identity',
    slot: 'profile.currentResidence',
    value: '上海',
  }
  const r1 = await store.ingestVerifiedEvent(input)
  assert.equal(r1.status, 'applied')
  const r2 = await store.ingestVerifiedEvent(input)
  assert.equal(r2.status, 'skipped', '重复 eventId 原样返回')
  const mem = await store.getMemory()
  const actives = mem.facts.filter((f) => f.status === 'active' && f.slot === 'profile.currentResidence')
  assert.equal(actives.length, 1)
  assert.equal(actives[0].value, '上海')
  const verifiedEvidence = mem.facts.flatMap((f) => f.evidence).filter((e) => e.kind === 'verified-event')
  assert.equal(verifiedEvidence.length, 1, 'eventId 只写一次')
  // 账本:verified 摄取同样有终态记录
  assert.ok(mem.ingestLog.some((r) => r.turnId === 'verified:evt-1' && r.status === 'applied'))
})

// ---------- V2→V3 迁移 ----------

function v2Payload() {
  return {
    version: 2,
    facts: [
      {
        id: 'f-bj',
        content: '用户住在北京',
        category: 'identity',
        slot: 'profile.currentResidence',
        value: '北京',
        confidence: 0.7,
        volatility: 'changeable',
        sensitivity: 'private',
        status: 'active',
        sourceTurnId: 't1',
        sourceExcerpt: '我住北京',
        createdAt: NOW - 30 * DAY,
        lastSeen: NOW - 2 * DAY,
        lastConfirmedAt: null,
        pinned: false,
        hits: 2,
        evidence: [{ kind: 'extracted', turnId: 't1', excerpt: '我住北京', at: NOW - 30 * DAY }],
      },
      {
        id: 'f-sh',
        content: '用户搬到上海',
        category: 'identity',
        slot: 'profile.currentResidence',
        value: '上海',
        confidence: 0.8,
        volatility: 'changeable',
        sensitivity: 'private',
        status: 'active',
        sourceTurnId: 't2',
        sourceExcerpt: '搬到上海',
        createdAt: NOW - DAY,
        lastSeen: NOW - DAY,
        lastConfirmedAt: NOW - DAY,
        pinned: false,
        hits: 1,
        evidence: [
          { kind: 'extracted', turnId: 't2', excerpt: '搬到上海', at: NOW - DAY },
          { kind: 'user-confirmed', turnId: null, excerpt: '', at: NOW - DAY },
        ],
      },
    ],
    rules: [{ id: 'r1', scope: 'phrase', value: '花生', createdAt: NOW }],
    topicStats: { 星际争霸: { seen: 3, favored: 1, replays: 0, watched: 2, skipped: 0, liked: 1, disliked: 0 } },
    counters: { pokes: 5, modeUses: { daily: 2 } },
  }
}

test('V2→V3 迁移:同 slot 双 active 清槽(留 confirmed 权威者)+ 建冲突;旧字段丢弃;幂等', () => {
  const once = store.sanitizeMemoryData(v2Payload())
  assert.equal(once.version, 3)
  const actives = once.facts.filter((f) => f.status === 'active' && f.slot === 'profile.currentResidence')
  assert.equal(actives.length, 1, '迁移完成即满足单 active 不变量')
  assert.equal(actives[0].id, 'f-sh', '用户确认过的权威事实保留')
  const loser = once.facts.find((f) => f.id === 'f-bj')
  assert.equal(loser.status, 'superseded')
  assert.equal(loser.supersededBy, 'f-sh')
  assert.equal(once.conflicts.length, 1)
  assert.equal(once.conflicts[0].existingFactId, 'f-sh')
  assert.equal(once.conflicts[0].proposed.value, '北京')
  assert.equal(once.conflicts[0].reason, 'lower-authority')
  assert.equal(once.conflicts[0].proposed.evidence[0].assertion, 'unknown', 'V2 extracted 不伪造分级')
  assert.equal(once.facts[0].confidence, undefined, '旧散字段不再持久化')
  // 迁移幂等:对同一份已迁移数据再 sanitize 完全不变(不动点)
  const twice = store.sanitizeMemoryData(once)
  assert.deepEqual(twice, once)
  // 独立两次从 v2 迁移:结构一致(仅冲突单的生成字段 id/createdAt 不同,剥离后逐字相同)
  const shapeOf = (m) => {
    const copy = JSON.parse(JSON.stringify(m))
    for (const c of copy.conflicts) {
      c.id = '<gen>'
      c.createdAt = 0
    }
    return copy
  }
  assert.deepEqual(shapeOf(store.sanitizeMemoryData(v2Payload())), shapeOf(store.sanitizeMemoryData(v2Payload())))
})

test('迁移不碰话题口味/规则/计数器(storyStore 独立文件本就不在此库)', () => {
  const once = store.sanitizeMemoryData(v2Payload())
  assert.deepEqual(once.topicStats, v2Payload().topicStats)
  assert.deepEqual(once.rules, v2Payload().rules)
  assert.equal(once.counters.pokes, 5)
  assert.deepEqual(once.counters.modeUses, { daily: 2 })
})
