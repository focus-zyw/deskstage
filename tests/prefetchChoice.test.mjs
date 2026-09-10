import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let savePrefetchEntry
let takePrefetch

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
  ;({ savePrefetchEntry, takePrefetch } = await server.ssrLoadModule(
    '/src/storage/prefetchStore.ts',
  ))
})

after(async () => {
  await server?.close()
  delete globalThis.localStorage
})

test('预生成缓存往返后保留 choice 和两个分支', async () => {
  await savePrefetchEntry({
    mode: 'crosstalk',
    topic: '周报到底写给谁看',
    script: {
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
    },
  })

  const hit = await takePrefetch('crosstalk')

  assert.equal(hit?.script.choice?.prompt, '支持谁？')
  assert.deepEqual(hit?.script.choice?.options.map((option) => option.id), ['a', 'b'])
  assert.deepEqual(Object.keys(hit?.script.after ?? {}).sort(), ['a', 'b'])
})

test('缺少完整脚本的旧缓存自动失效，避免再播放一次无选项版本', async () => {
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

  const hit = await takePrefetch('daily')

  assert.equal(hit, null)
})
