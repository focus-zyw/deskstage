// 话题状态存储(topic-state)行为测试:清洗钳制、指纹稳定性、CAS 变更循环(浏览器
// adapter)、读模型快照订阅。回归目标:动态话题系统数据地基的形状契约。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let store
let planner

before(async () => {
  // 内存 localStorage 桩:浏览器降级通路(与既有 store 测试同款)
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  }
  planner = await import('../src/topic/planner.ts')
  store = await import('../src/topic/store.ts')
})


test('normalizeTitle 归一全半角/标点/大小写,指纹跨调用稳定', () => {
  assert.equal(planner.normalizeTitle('ＡＩ，帮你回消息！'), 'ai帮你回消息')
  const f1 = planner.fingerprintOf('周报到底写给谁看')
  const f2 = planner.fingerprintOf('周报到底写给谁看')
  assert.equal(f1, f2)
  assert.ok(f1.length > 0)
  assert.equal(planner.fingerprintOf('！？、'), '') // 纯标点规范化后为空 → 空指纹
})

test('sanitizeTopicCard:钳制/兜底/非法拒绝', () => {
  const card = store.sanitizeTopicCard({
    title: '  AI替你回复消息后，人缘到底算谁的  '.slice(0, 200),
    hook: '',
    category: '不存在',
    tags: ['AI', 42, '  社交  ', '', 'x'.repeat(99)],
    source: 'generated',
    sensitivity: 'top-secret',
  })
  assert.ok(card)
  assert.equal(card.category, 'life') // 非法分类兜底
  assert.equal(card.source, 'generated')
  assert.equal(card.hook, card.title) // hook 缺省回落标题
  assert.equal(card.sensitivity, 'normal')
  assert.deepEqual(card.tags, ['AI', '社交', 'x'.repeat(12)])
  assert.equal(card.fingerprint, planner.fingerprintOf(card.title)) // 指纹缺失重算
  assert.equal(store.sanitizeTopicCard({ title: '   ' }), null)
  assert.equal(store.sanitizeTopicCard(null), null)
})

test('sanitizeTopicState:容器钳制(reservoir≤40/recent≤20/signals≤500)', () => {
  const reservoir = Array.from({ length: 50 }, (_, i) => ({ title: `候选话题${i}`, source: 'generated' }))
  const recent = Array.from({ length: 30 }, (_, i) => ({ title: `最近话题${i}`, ts: i }))
  const episodeSignals = Object.fromEntries(
    Array.from({ length: 600 }, (_, i) => [`ep-${String(i).padStart(6, '0')}`, { fingerprint: `f${i}`, started: true, updatedAt: i }]),
  )
  const state = store.sanitizeTopicState({
    revision: -5,
    reservoir,
    recent,
    episodeSignals,
    session: { id: 's1', rootCard: { title: '根话题' }, duration: 'until-cleared', stage: '不可能' },
  })
  assert.equal(state.revision, 0)
  assert.equal(state.reservoir.length, store.MAX_RESERVOIR)
  assert.equal(state.recent.length, store.MAX_RECENT)
  assert.equal(Object.keys(state.episodeSignals).length, store.MAX_EPISODE_SIGNALS)
  assert.ok(Object.keys(state.episodeSignals)[0].startsWith('ep-0001')) // 保最新500
  assert.equal(state.session.stage, 'open') // 非法阶段兜底
  assert.equal(state.session.remainingEpisodes, null) // until-cleared → null
  assert.equal(state.session.rootCard.title, '根话题')
})

test('banHash:无雷区空串;词序无关;词表变化即变', () => {
  assert.equal(planner.banHashOf(''), '')
  assert.equal(planner.banHashOf(undefined), '')
  const a = planner.banHashOf('考试,前任')
  const b = planner.banHashOf('前任、考试')
  assert.equal(a, b)
  assert.notEqual(a, planner.banHashOf('考试'))
})

test('mutateTopicState(浏览器通路):变更落盘+快照失效+订阅触发', async () => {
  const seen = []
  const unsub = store.subscribeTopicState(() => seen.push(store.getTopicSnapshot().revision))
  const result = await store.mutateTopicState((s) => {
    s.revision += 1
    s.recent.push({ fingerprint: 'fp1', title: '加班到很晚', category: 'work', source: 'manual', ts: 1 })
    return { state: s, result: s.revision }
  })
  assert.equal(result, 1)
  assert.deepEqual(seen, [1])
  unsub()

  // 重读模块级缓存:再 mutate 拿到的是上一轮结果(缓存持续)
  const state = await store.getTopicState()
  assert.equal(state.revision, 1)
  assert.equal(state.recent.length, 1)
  // 落盘可恢复(清缓存后从 localStorage 回读)
  const again = await store.getTopicState()
  assert.equal(again.recent[0].title, '加班到很晚')

  const snap1 = store.getTopicSnapshot()
  const snap2 = store.getTopicSnapshot()
  assert.equal(snap1, snap2) // memoized:数据不变同一对象
  await store.mutateTopicState((s) => ({ state: s, result: null }))
  assert.notEqual(store.getTopicSnapshot(), snap1) // 数据变则快照重建
})

test('cardHitsBan:标题/hook/tags 任一命中即出局', () => {
  const card = {
    title: '完全无害的话题',
    hook: '聊聊前任的那些事',
    tags: ['日常'],
    category: 'social',
    source: 'curated',
    fingerprint: 'x',
    sensitivity: 'normal',
    generatedAt: 0,
  }
  assert.equal(planner.cardHitsBan(card, ['考试', '前任']), true)
  assert.equal(planner.cardHitsBan(card, ['考试']), false)
  assert.equal(planner.cardHitsBan(card, []), false)
})
