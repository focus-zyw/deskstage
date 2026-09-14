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

test('精选池:核心 85 条、指纹唯一、分类分布、通用骨架不绑职业', () => {
  const cards = catalog.CURATED_CARDS
  assert.equal(cards.length, 85)
  const fps = new Set(cards.map((c) => c.fingerprint))
  assert.equal(fps.size, cards.length)
  const byCat = {}
  for (const c of cards) byCat[c.category] = (byCat[c.category] ?? 0) + 1
  assert.deepEqual(byCat, {
    consumption: 16,
    work: 12,
    life: 17,
    social: 10,
    technology: 8,
    health: 9,
    emotion: 7,
    imagination: 6,
  })
  for (const c of cards) {
    assert.equal(c.source, 'curated')
    assert.ok(c.hook.length > c.title.length / 2, 'hook 必须比标题有信息量')
    assert.ok(c.hook !== c.title)
    // 通用骨架纪律:核心池不携带默认职业门控(默认世界题在 TOPIC_PACKS)
    assert.equal(c.applicability, undefined)
    // 角色往事不硬填:只允许来自真实故事数据(candidates 通道)
    assert.notEqual(c.category, 'character-history')
  }
  // 旅行换皮对已删除
  assert.ok(!cards.some((c) => c.title.includes('旅行')))
})

test('默认人设专属包:仅分组不做门控,逐卡 applicability 覆盖,手写 hook', () => {
  const packs = catalog.TOPIC_PACK_CARDS
  assert.equal(packs.length, 1)
  const pack = packs[0]
  assert.equal(pack.id, 'default-world')
  assert.ok(pack.cards.length >= 20 && pack.cards.length <= 30, '包规模 20~30')
  let cross = 0
  let aOnly = 0
  let bOnly = 0
  let cOnly = 0
  for (const c of pack.cards) {
    assert.ok(c.applicability?.actors && Object.keys(c.applicability.actors).length > 0, '包卡必须带 applicability')
    assert.ok(c.hook && c.hook !== c.title, '包卡 hook 必须手写')
    const a = c.applicability.actors
    if (a.A === 'default' && a.B === 'default') cross++
    else if (a.A === 'default') aOnly++
    else if (a.B === 'default') bOnly++
    else if (a.C === 'default') cOnly++
  }
  assert.ok(cross >= 10, `A×B 交叉 ≥10,实际 ${cross}`)
  assert.ok(aOnly >= 4, `A 独立 ≥4,实际 ${aOnly}`)
  assert.ok(bOnly >= 4, `B 独立 ≥4,实际 ${bOnly}`)
  assert.ok(cOnly >= 1, `C 相关 ≥1,实际 ${cOnly}`)
})

test('applicability 门控矩阵:逐卡按人设来源可见性过滤,包分组不整体门控', () => {
  const world = (a, b, c) => ({ A: a, B: b, C: c })
  const mk = () => catalog.createTopicCatalog({ getReservoir: () => [], getHistoryPieces: () => [] })
  const full = new Set(mk().candidates({ actorWorld: world('default', 'default', 'default') }).map((c) => c.id))
  const partial = new Set(mk().candidates({ actorWorld: world('default', 'custom', 'default') }).map((c) => c.id))
  const none = new Set(mk().candidates({ actorWorld: world('custom', 'custom', 'custom') }).map((c) => c.id))
  const packCards = catalog.TOPIC_PACK_CARDS[0].cards
  const cross = packCards.filter((c) => c.applicability.actors.A && c.applicability.actors.B)
  const bIndependent = packCards.filter((c) => c.applicability.actors.B && !c.applicability.actors.A)
  assert.ok(cross.length >= 10)
  assert.ok(bIndependent.length >= 4)
  for (const c of cross) {
    assert.ok(full.has(c.id), '双默认可见')
    assert.equal(partial.has(c.id), false, 'B 自定义时交叉卡消失')
    assert.equal(none.has(c.id), false, '双自定义消失')
  }
  for (const c of bIndependent) {
    assert.ok(full.has(c.id), 'B 独立卡双默认可见')
    assert.equal(partial.has(c.id), false, '仅 B 自定义时 B 独立卡(依赖默认 B)消失')
    assert.equal(none.has(c.id), false, '双自定义时 B 独立卡消失')
  }
})

test('query:同 seed 同结果、前缀稳定、排除近期、facets 与门控池同源', () => {
  const cat = catalog.createTopicCatalog({ getReservoir: () => [], getHistoryPieces: () => [] })
  const a = cat.query({ category: 'work', seed: 7, limit: 4 }).items.map((s) => s.id)
  const b = cat.query({ category: 'work', seed: 7, limit: 4 }).items.map((s) => s.id)
  assert.deepEqual(a, b, '同 seed 同结果')
  const c = cat.query({ category: 'work', seed: 8, limit: 4 }).items.map((s) => s.id)
  assert.notDeepEqual(a, c, '不同 seed 应有变化')
  const wider = cat.query({ category: 'work', seed: 7, limit: 8 }).items.map((s) => s.id)
  assert.deepEqual(wider.slice(0, 4), a, 'limit 扩大时前缀稳定')
  const anyWork = catalog.CURATED_CARDS.find((x) => x.category === 'work')
  const baseWork = cat.query({ category: 'work', limit: 0 }).facets.find((f) => f.id === 'work').count
  const excluded = cat.query({ category: 'work', excludeFingerprints: [anyWork.fingerprint], limit: 50 })
  assert.ok(excluded.items.every((s) => s.id !== anyWork.id), '近期指纹被排除')
  const excludedWork = excluded.facets.find((f) => f.id === 'work').count
  assert.equal(excludedWork, baseWork - 1, 'facets 计数同步排除(含默认包同类卡)')
  assert.equal(excludedWork, excluded.items.length, 'facets 与 items 同源:分类计数=该分类实际条数')
  const facets = cat.query({ limit: 0 }).facets
  assert.ok(facets.length > 0 && facets.every((f) => f.count > 0), '空分类不出现')
  assert.ok(!facets.some((f) => f.id === 'character-history'), '无真实往事时角色往事隐藏')
})

test('resolve:精选/包查找 + 世界门控失败回落 null;点卡 hook 与展示同源', () => {
  const packCard = catalog.TOPIC_PACK_CARDS[0].cards[0]
  const cat = catalog.createTopicCatalog({ getReservoir: () => [], getHistoryPieces: () => [] })
  const hit = cat.resolve(packCard.id, { actorWorld: { A: 'default', B: 'default', C: 'default' } })
  assert.equal(hit?.id, packCard.id)
  assert.equal(hit.hook, packCard.hook, '点卡拿到的是原卡 hook')
  // B 自定义 → 交叉卡门控失败
  assert.equal(cat.resolve(packCard.id, { actorWorld: { A: 'default', B: 'custom', C: 'default' } }), null)
  // 候选仓优先(点 AI 卡)
  const genCard = { ...packCard, id: 'gen-x', applicability: undefined }
  const withReservoir = catalog.createTopicCatalog({ getReservoir: () => [genCard], getHistoryPieces: () => [] })
  assert.equal(withReservoir.resolve('gen-x', { actorWorld: world0() }).id, 'gen-x')
  function world0() {
    return { A: 'default', B: 'default', C: 'default' }
  }
})

test('candidates:自动池排除 sensitive;query(显式浏览)保留', () => {
  const cat = catalog.createTopicCatalog({ getReservoir: () => [], getHistoryPieces: () => [] })
  const pool = cat.candidates({})
  assert.ok(pool.every((c) => c.sensitivity !== 'sensitive'))
  assert.ok(pool.some((c) => c.sensitivity === 'personal'), 'personal 可进自动池(prompt 加约束)')
})

test('换皮审计:titleSimilarity>0.6 的卡对必须在显式允许列表', () => {
  const all = [
    ...catalog.CURATED_CARDS,
    ...catalog.TOPIC_PACK_CARDS.flatMap((p) => p.cards),
  ]
  const allowed = new Set(catalog.ALLOWED_SIMILAR_PAIRS.map(([x, y]) => [x, y].sort().join('\u0001')))
  const offenders = []
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (planner.titleSimilarity(all[i].title, all[j].title) > 0.6) {
        const key = [all[i].title, all[j].title].sort().join('\u0001')
        if (!allowed.has(key)) offenders.push(`${all[i].title} ↔ ${all[j].title}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `疑似换皮题目(需人工确认或加入允许列表):\n${offenders.join('\n')}`)
})

test('personaSource 迁移三规则 + usesDefaultPersona 只读结构化来源', async () => {
  const personaMod = await server.ssrLoadModule('/src/engine/persona.ts')
  // 规则一:空文本 → default;规则三:其他非空 → custom
  const dirty = configStore.sanitizeConfig({ persona: { a: '', b: '自定义侦探人设', c: '' } })
  assert.deepEqual(dirty.personaSource, { a: 'default', b: 'custom', c: 'default' })
  // 规则二:能识别为内置默认全文(旧"还原默认"按钮按当时名字写入)→ default
  const canonical = personaMod.defaultPersonaText('A')
  const legacy = configStore.sanitizeConfig({ persona: { a: canonical, b: '', c: '' } })
  assert.equal(legacy.personaSource.a, 'default')
  // 已持久化的结构化来源直接信任(来源是权威事实)
  const explicit = configStore.sanitizeConfig({
    persona: { a: '', b: '', c: '' },
    personaSource: { a: 'custom', b: 'default', c: 'custom' },
  })
  assert.deepEqual(explicit.personaSource, { a: 'custom', b: 'default', c: 'custom' })
})

test('castHash:同配置同哈希(跨重启稳定),人设/名字/性别任一变化即变', async () => {
  const personaMod = await server.ssrLoadModule('/src/engine/persona.ts')
  personaMod.setPersonaOverride('', '', '')
  personaMod.setCharacterNames('甲', '乙', '丙')
  personaMod.setCharacterGenders('女', '男', '女')
  const base = personaMod.castHash()
  assert.equal(personaMod.castHash(), base, '内容哈希,非进程内计数器')
  personaMod.setPersonaOverride('侦探,观察入微', '', '')
  assert.notEqual(personaMod.castHash(), base, '人设变化 → 哈希变化')
  personaMod.setPersonaOverride('', '', '')
  assert.equal(personaMod.castHash(), base, '恢复同配置 → 同哈希(可安全复用)')
  personaMod.setCharacterNames('阿甲', '乙', '丙')
  assert.notEqual(personaMod.castHash(), base, '改名 → 哈希变化(名字进提示词)')
  personaMod.setCharacterGenders('男', '男', '女')
  assert.notEqual(personaMod.castHash(), base, '改性别 → 哈希变化(代词纪律)')
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
