// 预生成零副作用回归:预览上下文不得写持久状态,采纳时才一次性提交。
// 痛点:预取的集没播也会烧掉注入冷却、消费掉互动 recap(doc §4.2 预生成零副作用)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let story
let interactions

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
  story = await server.ssrLoadModule('/src/storage/storyStore.ts')
  interactions = await server.ssrLoadModule('/src/storage/interactionStore.ts')
})

after(async () => {
  await server?.close()
  delete globalThis.localStorage
})

test('previewStoryContext 不写注入冷却,commitStoryInjection 才写', async () => {
  localStorage.setItem(
    'vc-story',
    JSON.stringify({
      version: 2,
      gags: [{ id: 'g-noodle', text: '甲的泡面必须配冰可乐', lastSeen: 1, hits: 0, lastInjectedAt: 0 }],
      threads: [],
      arcs: [],
      bond: { trust: 1, rivalry: 0, updatedAt: 0 },
    }),
  )
  const preview = await story.previewStoryContext('泡面', 2)
  assert.equal(preview.gags.length, 1)
  assert.equal(preview.gagIds[0], 'g-noodle')
  // 预览不落冷却
  let gag = (await story.getStory()).gags[0]
  assert.equal(gag.lastInjectedAt, 0)
  // 采纳才落
  await story.commitStoryInjection(preview.gagIds, preview.threadIds)
  gag = (await story.getStory()).gags[0]
  assert.ok(gag.lastInjectedAt > 0)
})

test('peekRecap 与 takeRecap 文案一致,但只有 take 清零计数', async () => {
  localStorage.setItem(
    'vc-interactions',
    JSON.stringify({ pokeA: 2, pokeB: 0, interrupts: 1, drags: 2, sinceInject: 3, dismissSpontaneous: 0, dismissReplay: 0, dismissBreak: 0 }),
  )
  const peeked = await interactions.peekRecap()
  assert.ok(peeked, '攒够素材时 peek 应返回文案')
  const statsAfterPeek = JSON.parse(localStorage.getItem('vc-interactions'))
  assert.equal(statsAfterPeek.sinceInject, 3) // 预览不消费
  const taken = await interactions.takeRecap()
  assert.equal(taken, peeked) // 文案一致
  const statsAfterTake = JSON.parse(localStorage.getItem('vc-interactions'))
  assert.equal(statsAfterTake.sinceInject, 0) // 采纳才清零
  assert.equal(await interactions.peekRecap(), null) // 清零后再 peek 为空
})
