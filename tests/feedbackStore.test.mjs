// 演出评价持久层回归:落盘/读档清洗、改评与撤销、删除联动、上限裁剪,
// 以及评价→话题口味权重的 ± 可逆联动(rateEpisode ↔ memoryStore.getTopicWeights)。
// 非 Tauri 环境走 localStorage,先垫桩(与 moodStore.test 同套路);
// store 有内存缓存(首读后不再回磁盘),坏数据用例必须先于一切加载发生。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let store
let memory

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
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  store = await server.ssrLoadModule('/src/storage/feedbackStore.ts')
  memory = await server.ssrLoadModule('/src/storage/memoryStore.ts')
})

after(async () => {
  await server?.close()
  delete globalThis.localStorage
})

const meta = (topic) => ({ ts: Date.now(), mode: 'crosstalk', topic })

// bumpTopicFavored 是 fire-and-forget(void),等锁队列与同步落盘走完再读
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test('坏数据首读回空表,不炸', async () => {
  localStorage.setItem('vc-feedback', '{oops not json')
  assert.deepEqual(await store.getRatings(), {})
  assert.equal(await store.getEpisodeRating('e1'), null)
})

test('评价落盘:rating 与元数据可读回', async () => {
  await store.rateEpisode('e1', meta('穿越（古代角度）'), 'up')
  assert.equal(await store.getEpisodeRating('e1'), 'up')
  const all = await store.getRatings()
  assert.equal(all.e1.rating, 'up')
  assert.equal(all.e1.mode, 'crosstalk')
  assert.equal(all.e1.topic, '穿越（古代角度）')
  assert.equal(JSON.parse(localStorage.getItem('vc-feedback')).table.e1.rating, 'up')
})

test('改评与撤销:up→down→撤销,评价表随之增删', async () => {
  await store.rateEpisode('e2', meta('职场吐槽'), 'up')
  await store.rateEpisode('e2', meta('职场吐槽'), 'down')
  assert.equal(await store.getEpisodeRating('e2'), 'down')
  await store.rateEpisode('e2', meta('职场吐槽'), null)
  assert.equal(await store.getEpisodeRating('e2'), null)
  assert.equal((await store.getRatings()).e2, undefined)
})

test('评价联动话题权重:赞+1/踩-1.5,改评可逆,角度后缀剥成种子', async () => {
  // 权重 = 1(基础) + 各信号加权,期望值按公式给绝对值,避免"话题未出场时无权重"的基线歧义
  const topic = '科幻（硬核角度）'
  await store.rateEpisode('e3', meta(topic), 'up')
  assert.ok(Math.abs((await memory.getTopicWeights())['科幻'] - 2) < 1e-9) // 基础1 + 赞1
  // 改评:赞信号回退、踩信号生效
  await store.rateEpisode('e3', meta(topic), 'down')
  assert.ok(Math.abs((await memory.getTopicWeights())['科幻'] - -0.5) < 1e-9) // 基础1 - 踩1.5
  // 撤销:信号清零,回基础分
  await store.rateEpisode('e3', meta(topic), null)
  assert.ok(Math.abs((await memory.getTopicWeights())['科幻'] - 1) < 1e-9)
})

test('显式赞弱于收藏:同话题各来一次,收藏权重增量更大', async () => {
  await store.rateEpisode('e4', meta('温泉'), 'up')
  const afterLike = (await memory.getTopicWeights())['温泉']
  memory.bumpTopicFavored('温泉')
  await settle()
  const afterFav = (await memory.getTopicWeights())['温泉']
  assert.ok(Math.abs(afterLike - 2) < 1e-9) // 基础1 + 赞1
  assert.ok(Math.abs(afterFav - 4) < 1e-9) // 再加收藏2:显式赞(1) < 收藏(2)
})

test('删除联动:removeRatings 清掉对应集,无 eid 的空输入安静跳过', async () => {
  await store.rateEpisode('e5', meta('相亲趣事'), 'up')
  await store.rateEpisode('e6', meta('相亲趣事'), 'down')
  await store.removeRatings([undefined, '', 'e5'])
  assert.equal(await store.getEpisodeRating('e5'), null)
  assert.equal(await store.getEpisodeRating('e6'), 'down')
  await store.removeRatings([])
  assert.equal(await store.getEpisodeRating('e6'), 'down')
})

test('上限裁剪:超出 MAX_ENTRIES 淘汰最旧的(纯函数直测)', () => {
  const table = {}
  for (let i = 0; i < 505; i++) {
    table[`e${i}`] = { rating: 'up', ts: i, mode: 'daily', ratedAt: i }
  }
  const trimmed = store.trimTable(table)
  assert.equal(Object.keys(trimmed).length, 500)
  assert.equal(trimmed.e0, undefined)
  assert.equal(trimmed.e4, undefined)
  assert.equal(trimmed.e5.rating, 'up')
  assert.equal(trimmed.e504.rating, 'up')
})
