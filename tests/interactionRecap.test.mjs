// 互动账本回收回归:攒够阈值 → takeRecap 报出"这一期攒的量"并把戳/拖计数清零;
// peek 只预览不消费。此前计数只增不清,开场抱怨会报出吓人的终身累计数。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let store

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
  store = await server.ssrLoadModule('/src/storage/interactionStore.ts')
})

after(async () => {
  await server?.close()
  delete globalThis.localStorage
})

async function poke(times, kind = 'pokeA') {
  for (let i = 0; i < times; i++) await store.logInteraction(kind)
}

test('攒够阈值后 takeRecap 报出本期量,并把戳/拖计数清零', async () => {
  await poke(2)
  await poke(1, 'pokeC')
  await store.logDrag()
  const recap = await store.takeRecap()
  assert.ok(recap, '达到阈值应有抱怨文案')
  assert.match(recap, /2 次/) // 甲被戳 2 次
  assert.match(recap, /1 回/) // 小管家被戳 1 回
  assert.match(recap, /1 次/) // 拖拽 1 次
  // 消费后计数归零:不足阈值,再 take 为 null
  assert.equal(await store.takeRecap(), null)
})

test('peek 只预览不消费:两次 peek 结果一致,消费仍能拿到同量', async () => {
  await poke(3)
  const peeked = await store.peekRecap()
  assert.ok(peeked)
  assert.equal(await store.peekRecap(), peeked)
  const taken = await store.takeRecap()
  assert.equal(taken, peeked)
})

test('清零后重新攒,只报新量不报终身累计', async () => {
  await poke(3, 'pokeB') // 上一期清零后再攒 3 次戳乙
  const recap = await store.takeRecap()
  assert.ok(recap)
  assert.match(recap, /3 次/)
  assert.ok(!recap.match(/拖近又拽远 [1-9]/), '上期的拖拽数不应再出现')
})
