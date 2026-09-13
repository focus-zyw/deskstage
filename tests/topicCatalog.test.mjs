// 话题目录与旧数据迁移行为测试:75 条精选结构化、分类角度、模式池/手动卡转换、
// config.topicOverride 幂等迁移四步序、topicPrefs 清洗。回归目标:动态话题系统
// 的数据地基不漂移,旧"锁定直到清除"用户升级后语义无损。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let catalog
let planner
let store
let migration
let configStore

before(async () => {
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  }
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  planner = await server.ssrLoadModule('/src/topic/planner.ts')
  catalog = await server.ssrLoadModule('/src/topic/catalog.ts')
  store = await server.ssrLoadModule('/src/topic/store.ts')
  migration = await server.ssrLoadModule('/src/topic/migration.ts')
  configStore = await server.ssrLoadModule('/src/storage/configStore.ts')
})

after(async () => {
  await server?.close()
})

test('精选池:75 条、指纹唯一、分类分布与原六组一致', () => {
  const cards = catalog.CURATED_CARDS
  assert.equal(cards.length, 75)
  const fps = new Set(cards.map((c) => c.fingerprint))
  assert.equal(fps.size, cards.length)
  const byCat = {}
  for (const c of cards) byCat[c.category] = (byCat[c.category] ?? 0) + 1
  assert.deepEqual(byCat, { consumption: 15, work: 12, life: 15, social: 10, technology: 8, health: 15 })
  for (const c of cards) {
    assert.equal(c.source, 'curated')
    assert.ok(c.hook.length > c.title.length / 2, 'hook 必须比标题有信息量')
    assert.ok(c.hook !== c.title)
  }
})

test('角度按分类取,不再全局混配', () => {
  const work = catalog.CURATED_CARDS.find((c) => c.title === '周报到底写给谁看')
  assert.ok(work)
  assert.ok(catalog.anglesFor(work).length > 0)
  assert.deepEqual(catalog.anglesFor(work), catalog.ANGLES_BY_CATEGORY.work)
})

test('模式专属池转换:modeAffinity 锁定 + 分类猜测', () => {
  const cards = catalog.cardsFromSeeds(['加班到崩溃的那天', 'AI 替我开会', '周末补觉'], 'crosstalk')
  assert.equal(cards.length, 3)
  assert.deepEqual(cards[0].modeAffinity, ['crosstalk'])
  assert.equal(cards[0].category, 'work')
  assert.equal(cards[1].category, 'technology')
  assert.equal(cards[2].category, 'life')
  for (const c of cards) assert.ok(c.id.startsWith('mode-'))
})

test('手动话题文本 → manual 卡', () => {
  const card = catalog.manualCardFromText('  我家猫上周学会开门  ')
  assert.equal(card.source, 'manual')
  assert.equal(card.title, '我家猫上周学会开门')
  assert.equal(card.fingerprint, planner.fingerprintOf('我家猫上周学会开门'))
})

test('topicOverride 迁移:无旧字段不动;有旧字段写 strict+until-cleared 会话并清理', async () => {
  // 无 override:什么都不发生
  let clearedCalls = 0
  let override = null
  const deps = {
    getOverride: async () => override,
    clearOverride: async () => {
      clearedCalls++
      override = null
    },
  }
  assert.equal(await migration.migrateLegacyTopicOverride(deps), false)
  assert.equal(clearedCalls, 0)
  assert.equal((await store.getTopicState()).session, null)

  // 有 override:写迁移会话 + 清旧字段
  override = '周报到底写给谁看'
  assert.equal(await migration.migrateLegacyTopicOverride(deps), true)
  assert.equal(clearedCalls, 1)
  assert.equal(override, null)
  const s = (await store.getTopicState()).session
  assert.ok(s)
  assert.equal(s.policy, 'strict')
  assert.equal(s.duration, 'until-cleared')
  assert.equal(s.remainingEpisodes, null)
  assert.equal(s.migratedFromOverride, planner.fingerprintOf('周报到底写给谁看'))
  assert.equal(s.rootCard.title, '周报到底写给谁看')
})

test('迁移幂等:同标记会话重跑只补清理;其他会话不覆盖', async () => {
  let override = '周报到底写给谁看'
  const deps = {
    getOverride: async () => override,
    clearOverride: async () => {
      override = null
    },
  }
  // 模拟步骤③崩溃后重跑:override 复活,会话已在(同标记)→ 只清字段,不改会话
  const beforeState = await store.getTopicState()
  assert.equal(await migration.migrateLegacyTopicOverride(deps), false)
  assert.equal(override, null)
  const afterState = await store.getTopicState()
  assert.deepEqual(afterState.session, beforeState.session)

  // 其他会话存在:放弃迁移写入,但仍清理遗留字段
  await store.mutateTopicState((s) => {
    s.session = null
    return { state: s, result: null }
  })
  await store.mutateTopicState((s) => {
    const card = catalog.manualCardFromText('用户自己选的新话题')
    s.session = {
      id: 'tse-user',
      rootCard: card,
      currentCard: card,
      policy: 'guided',
      duration: 'three-episodes',
      remainingEpisodes: 3,
      stage: 'open',
      usedFingerprints: [],
      usedAngles: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    s.revision += 1
    return { state: s, result: null }
  })
  override = '周报到底写给谁看'
  assert.equal(await migration.migrateLegacyTopicOverride(deps), false)
  assert.equal(override, null)
  assert.equal((await store.getTopicState()).session.rootCard.title, '用户自己选的新话题')
})

test('topicPrefs 清洗:非法回落 once/medium/false,费用开关必须显式开启', () => {
  const dirty = configStore.sanitizePartial({
    topicPrefs: { duration: '一辈子', distance: '瞬间移动', aiDiscover: 'yes' },
  })
  assert.deepEqual(dirty.topicPrefs, { duration: 'once', distance: 'medium', aiDiscover: false })
  const good = configStore.sanitizePartial({
    topicPrefs: { duration: 'three-episodes', distance: 'far', aiDiscover: true },
  })
  assert.deepEqual(good.topicPrefs, { duration: 'three-episodes', distance: 'far', aiDiscover: true })
})
