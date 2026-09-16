// Warm 上下文持久层回归:预载恢复(重启)、幂等清洗、过期与容量 LRU、会话冻结/新建、
// restricted 摘要拒收。store 有内存缓存(首读后不再回磁盘),所以"预载恢复"用例
// 必须先于一切读写发生(与 moodStore.test 同套路);非 Tauri 环境走 localStorage 桩。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

let store

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

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
  store = await import('../src/storage/warmStore.ts')
})

after(async () => {
  delete globalThis.localStorage
})

const episode = (over = {}) => ({
  id: 'e1',
  fromTs: NOW - 2 * DAY,
  toTs: NOW - DAY,
  summary: '用户聊了修电脑计划',
  sourceIds: ['t1', 't2'],
  sensitivity: 'normal',
  ...over,
})

test('预载恢复:手工档在首次读取时被完整接住(重启不丢)', async () => {
  localStorage.setItem(
    'vc-warm',
    JSON.stringify({
      version: 1,
      current: {
        id: 's-old',
        startedTs: NOW - 3600_000,
        lastActiveTs: NOW - 60_000,
        rollingSummary: '用户在准备明天的维修',
        foldedTurnIds: ['t1', 't2'],
      },
      episodes: [episode()],
    }),
  )
  const data = await store.getWarmData()
  assert.equal(data.current.id, 's-old')
  assert.equal(data.current.rollingSummary, '用户在准备明天的维修')
  assert.equal(data.episodes.length, 1)
})

test('幂等清洗:垃圾档归空、restricted 集摘要被清洗掉、再清洗不变', () => {
  const garbage = store.sanitizeWarmData({ version: 1, current: { startedTs: 'x' }, episodes: [{ summary: 1 }] })
  assert.equal(garbage.current, null)
  assert.equal(garbage.episodes.length, 0)

  const withRestricted = store.sanitizeWarmData({
    version: 1,
    current: null,
    episodes: [episode(), episode({ id: 'e2', sensitivity: 'restricted', summary: '用户的过敏药记录' })],
  })
  assert.equal(withRestricted.episodes.length, 1)
  assert.equal(withRestricted.episodes[0].id, 'e1')

  const once = store.sanitizeWarmData(withRestricted)
  assert.deepEqual(store.sanitizeWarmData(once), once)
})

test('裁剪纪律:过 14 天即删,超出 30 条丢最旧', () => {
  const stale = episode({ id: 'stale', toTs: NOW - 15 * DAY, fromTs: NOW - 16 * DAY })
  const fresh = Array.from({ length: 35 }, (_, i) => episode({ id: `f${i}`, toTs: NOW - i * 60_000 }))
  const out = store.pruneEpisodes([stale, ...fresh], NOW)
  assert.equal(out.length, 30)
  assert.ok(!out.some((e) => e.id === 'stale'))
  assert.ok(!out.some((e) => e.id === 'f0')) // 最旧被 LRU 挤掉
  assert.ok(out.some((e) => e.id === 'f34')) // 最新保留
})

test('会话冻结与新建:定稿成集摘要、current 清零、下次开新会话', async () => {
  await store.resetWarm()
  const s1 = await store.ensureSession(NOW - 3600_000)
  assert.equal(s1.rollingSummary, '')
  assert.equal(s1.foldedTurnIds.length, 0)

  await store.saveCurrentSession({ ...s1, rollingSummary: '用户聊了修电脑计划,甲吐槽了半天', foldedTurnIds: ['t1', 't2'] })
  const frozen = await store.freezeCurrentSession(NOW, 'normal')
  assert.ok(frozen)
  assert.equal(frozen.summary, '用户聊了修电脑计划,甲吐槽了半天')
  assert.deepEqual(frozen.sourceIds, ['t1', 't2'])
  assert.equal(frozen.fromTs, NOW - 3600_000)
  assert.equal((await store.currentSession()), null)
  assert.equal((await store.listEpisodes()).length, 1)

  const s2 = await store.ensureSession(NOW + 60_000)
  assert.notEqual(s2.id, s1.id)
  assert.equal(s2.rollingSummary, '')
})

test('restricted 摘要拒收:整条丢弃但 current 照样清零(遗忘,不残留)', async () => {
  await store.resetWarm()
  const s = await store.ensureSession(NOW)
  await store.saveCurrentSession({ ...s, rollingSummary: '用户提到过敏药的事' })
  const frozen = await store.freezeCurrentSession(NOW + 1000, 'restricted')
  assert.equal(frozen, null)
  assert.equal((await store.currentSession()), null)
  assert.equal((await store.listEpisodes()).length, 0)
})

test('空摘要冻结:不产出集摘要,current 照常闭合', async () => {
  await store.resetWarm()
  await store.ensureSession(NOW)
  const frozen = await store.freezeCurrentSession(NOW + 1000, 'normal')
  assert.equal(frozen, null)
  assert.equal((await store.currentSession()), null)
})
