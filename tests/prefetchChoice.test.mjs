// 预取缓存新契约回归:条目必须携带话题计划(TopicPlan);消费走
// peekCompatiblePrefetch(兼容令牌挑选)→ 采纳成功后 dropPrefetchEntry 的两步,
// "缓存至多消费一次"。覆盖:choice/分支往返保留、旧格式失效、revision/雷区/模式/
// 规划器版本/过期/意图/manual 归属/recent 指纹/剧情拍号 十条兼容检查。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let store

before(async () => {
  const values = new Map()
  globalThis.localStorage = {
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: (k) => values.delete(k),
    clear: () => values.clear(),
  }
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  store = await server.ssrLoadModule('/src/storage/prefetchStore.ts')
})

after(async () => {
  await server?.close()
  delete globalThis.localStorage
})

let planSeq = 0
const fakePlan = (over = {}) => ({
  planId: `tp-${++planSeq}`,
  createdAt: 0,
  expiresAt: 9e15,
  baseRevision: 0,
  lane: 'dynamic',
  mode: 'crosstalk',
  intent: 'new',
  card: {
    id: 'tc-x',
    title: '周报到底写给谁看',
    hook: '周报到底写给谁看',
    category: 'work',
    tags: [],
    source: 'curated',
    fingerprint: 'fp-weekly',
    sensitivity: 'normal',
    generatedAt: 0,
  },
  policy: 'guided',
  stage: 'open',
  episodeFocus: '周报到底写给谁看',
  allowedBranches: [],
  avoid: [],
  duration: 'once',
  compatibility: { sessionRevision: 0, banHash: '', modeHash: 'mh', topicPolicyHash: 'ph', plannerVersion: 1, castHash: 'cast' },
  ...over,
})

const script = () => ({
  before: [{ speaker: 'A', text: '你站哪边？', action: 'talk' }],
  choice: {
    prompt: '支持谁？',
    options: [
      { id: 'a', label: '支持甲' },
      { id: 'b', label: '支持乙' },
    ],
  },
  after: {
    a: [{ speaker: 'B', text: '甲赢了。', action: 'talk', branch: 'a' }],
    b: [{ speaker: 'B', text: '乙赢了。', action: 'talk', branch: 'b' }],
  },
})

const save = async (planOver = {}, entryOver = {}) =>
  store.savePrefetchEntry({
    mode: 'crosstalk',
    topic: '周报到底写给谁看',
    topicPlan: fakePlan(planOver),
    script: script(),
    ...entryOver,
  })

const check = (over = {}) => ({
  intent: 'new',
  sessionRevision: 0,
  banHash: '',
  modeHash: 'mh',
  topicPolicyHash: 'ph',
  castHash: 'cast',
  plannerVersion: 1,
  recentFingerprints: [],
  now: 1e12,
  ...over,
})

test('预生成缓存往返后保留 choice 和两个分支', async () => {
  await save()
  const hit = await store.peekCompatiblePrefetch('crosstalk', check())
  assert.equal(hit?.script.choice?.prompt, '支持谁？')
  assert.deepEqual(hit?.script.choice?.options.map((option) => option.id), ['a', 'b'])
  assert.deepEqual(Object.keys(hit?.script.after ?? {}).sort(), ['a', 'b'])
  assert.equal(hit?.topicPlan.card.fingerprint, 'fp-weekly')
  await store.dropPrefetchEntry(hit)
  assert.equal(await store.peekCompatiblePrefetch('crosstalk', check()), null, 'drop 后不可再次消费')
})

test('旧格式缓存(无 topicPlan)读取即失效,不消费', async () => {
  localStorage.setItem(
    'vc-prefetch',
    JSON.stringify([
      {
        mode: 'daily',
        topic: '旧缓存',
        lines: [{ speaker: 'A', text: '选项已经丢失', action: 'talk' }],
      },
    ]),
  )
  assert.equal(await store.peekCompatiblePrefetch('daily', check()), null)
})

test('兼容令牌:revision/雷区/模式/规划器版本任一不符即不消费', async () => {
  await save({ compatibility: { sessionRevision: 0, banHash: '', modeHash: 'mh', topicPolicyHash: 'ph', plannerVersion: 1, castHash: 'cast' } })
  assert.ok(await store.peekCompatiblePrefetch('crosstalk', check({ sessionRevision: 1 })) === null, 'revision 变更')
  assert.ok(await store.peekCompatiblePrefetch('crosstalk', check({ banHash: 'b' })) === null, '雷区变更')
  assert.ok(await store.peekCompatiblePrefetch('crosstalk', check({ modeHash: 'other' })) === null, '模式编辑')
  assert.ok(await store.peekCompatiblePrefetch('crosstalk', check({ plannerVersion: 2 })) === null, '规划器升级')
  assert.ok(await store.peekCompatiblePrefetch('crosstalk', check({ castHash: 'other' })) === null, '阵容变更(人设/名字/性别)')
  assert.ok(await store.peekCompatiblePrefetch('crosstalk', check({ topicPolicyHash: 'ph2' })) === null, '话题策略变更(默认值/来源/个人策略)')
  assert.ok(await store.peekCompatiblePrefetch('crosstalk', check({ topicPolicyHash: undefined })) === null, '旧缓存缺策略哈希不可消费')
  const hit = await store.peekCompatiblePrefetch('crosstalk', check())
  await store.dropPrefetchEntry(hit)
})

test('点卡点播:明确点 A 卡不消费 B 卡预生成,同卡才消费', async () => {
  // 预生成条目是精选卡 A(fp-weekly)
  await save()
  const auto = await store.peekCompatiblePrefetch('crosstalk', check())
  assert.ok(auto, '自动请求可消费精选卡预生成')
  // 明确点另一张卡 B:不消费(否则点 B 却播 A,面板展示与实际演出脱节)
  assert.ok(
    await store.peekCompatiblePrefetch('crosstalk', check({ requestedFingerprint: 'fp-other' })) === null,
    '点 B 卡不得命中 A 卡缓存',
  )
  // 明确点同一张卡 A:消费
  const pinned = await store.peekCompatiblePrefetch('crosstalk', check({ requestedFingerprint: 'fp-weekly' }))
  assert.ok(pinned, '点同一张卡可复用其预生成')
  await store.dropPrefetchEntry(pinned)
})

test('过期计划与 manual 归属:过期不消费;自动请求不消费手动计划', async () => {
  await save({ expiresAt: 1 })
  assert.ok(await store.peekCompatiblePrefetch('crosstalk', check({ now: 2 })) === null, '计划过期')
  await save({ card: { ...fakePlan().card, source: 'manual' } })
  assert.ok(await store.peekCompatiblePrefetch('crosstalk', check()) === null, 'manual 计划不给自动请求')
  const hit = await store.peekCompatiblePrefetch('crosstalk', check({ requestedFingerprint: 'fp-weekly' }))
  assert.ok(hit, '同指纹手动请求可消费 manual 计划')
  await store.dropPrefetchEntry(hit)
})

test('recent 指纹命中与剧情拍号:他窗播过/剧情推进的缓存不误播', async () => {
  await save()
  assert.ok(
    await store.peekCompatiblePrefetch('crosstalk', check({ recentFingerprints: ['fp-weekly'] })) === null,
    '计划卡已在 recent',
  )
  await save()
  const hit = await store.peekCompatiblePrefetch('crosstalk', check())
  await store.dropPrefetchEntry(hit)
  // 剧情:arc 条目 stage 必须与当前剧情线一致
  await save({}, { arc: { id: 'arc-1', stage: 2 } })
  assert.ok(await store.peekCompatiblePrefetch('crosstalk', check()) === null, 'arc 条目缺 arcStages 快照')
  assert.ok(
    await store.peekCompatiblePrefetch('crosstalk', check({ arcStages: { 'arc-1': 3 } })) === null,
    '剧情已推进到第3拍,第2拍缓存作废',
  )
  const hit2 = await store.peekCompatiblePrefetch('crosstalk', check({ arcStages: { 'arc-1': 2 } }))
  assert.ok(hit2, '拍号一致可消费')
  await store.dropPrefetchEntry(hit2)
})

test('意图兼容:new 请求可消费会话推进条目(同 revision 同世界状态)', async () => {
  await save({ intent: 'continue', sessionId: 'tse-1' })
  const hit = await store.peekCompatiblePrefetch('crosstalk', check({ intent: 'new' }))
  assert.ok(hit, 'new 消费 continue 条目')
  await store.dropPrefetchEntry(hit)
  await save({ intent: 'pivot' })
  assert.ok(await store.peekCompatiblePrefetch('crosstalk', check({ intent: 'surprise' })) === null, '换台/惊喜必须严格同意图')
})
