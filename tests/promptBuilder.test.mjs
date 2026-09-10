import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let buildMessages
let selectStoryItems
let storyContext

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ buildMessages } = await server.ssrLoadModule('/src/engine/promptBuilder.ts'))
  ;({ selectStoryItems, storyContext } = await server.ssrLoadModule('/src/storage/storyStore.ts'))
})

after(async () => {
  await server?.close()
})

const story = (gags, threads = []) => ({
  version: 1,
  gags,
  threads,
  arcs: [],
  bond: { trust: 1, rivalry: 0, updatedAt: 0 },
})

function finalPrompt({ recentLines = [], storyContext, continueFromPrevious = false } = {}) {
  return buildMessages(
    'crosstalk',
    '周报到底写给谁看',
    recentLines,
    false,
    undefined,
    storyContext ? { story: storyContext } : undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    continueFromPrevious,
  )
    .map((message) => message.content)
    .join('\n')
}

test('周报主题的最终提示词不会注入无关的满减记忆', () => {
  const selection = selectStoryItems(
    story([
      {
        id: 'shopping',
        text: '凑奶茶满减退17单叫精准凑单',
        hits: 10,
        lastSeen: 300,
        lastInjectedAt: 0,
      },
      {
        id: 'weekly-report',
        text: '甲把周报写成了连续剧预告',
        hits: 0,
        lastSeen: 100,
        lastInjectedAt: 0,
      },
    ]),
    '周报到底写给谁看',
    2,
  )
  const prompt = finalPrompt({
    storyContext: {
      gags: selection.gags.map((item) => item.text),
      threads: selection.threads.map((item) => item.text),
    },
  })

  assert.match(prompt, /周报写成了连续剧预告/)
  assert.doesNotMatch(prompt, /满减|凑单/)
})

test('冷却时间优先于 hits，近期高频老梗不会继续霸榜', () => {
  const selection = selectStoryItems(
    story([
      {
        id: 'hot-recent',
        text: '周报写成八百回连续剧',
        hits: 99,
        lastSeen: 300,
        lastInjectedAt: 300,
      },
      {
        id: 'cool',
        text: '周报最后一页其实是请假条',
        hits: 0,
        lastSeen: 100,
        lastInjectedAt: 100,
      },
    ]),
    '周报到底写给谁看',
    1,
  )

  assert.equal(selection.gags[0]?.id, 'cool')
})

test('每次注入后记录冷却时间并轮换到下一个相关老梗', async () => {
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
  localStorage.setItem(
    'vc-story',
    JSON.stringify(
      story([
        {
          id: 'first',
          text: '周报写成了一部长篇小说',
          hits: 0,
          lastSeen: 200,
          lastInjectedAt: 0,
        },
        {
          id: 'second',
          text: '周报最后一页藏着请假条',
          hits: 0,
          lastSeen: 100,
          lastInjectedAt: 0,
        },
      ]),
    ),
  )

  const first = await storyContext('周报到底写给谁看', 1)
  const second = await storyContext('周报到底写给谁看', 1)

  assert.deepEqual(first.gags, ['周报写成了一部长篇小说'])
  assert.deepEqual(second.gags, ['周报最后一页藏着请假条'])
  delete globalThis.localStorage
})

test('新主题默认不携带上一段原始结尾', () => {
  const prompt = finalPrompt({
    recentLines: [{ speaker: 'A', text: '要不再凑一单满减？', action: 'talk' }],
  })

  assert.doesNotMatch(prompt, /要不再凑一单满减/)
})

test('显式续聊时才携带上一段原始结尾', () => {
  const prompt = finalPrompt({
    recentLines: [{ speaker: 'A', text: '这份周报还没写完。', action: 'talk' }],
    continueFromPrevious: true,
  })

  assert.match(prompt, /这份周报还没写完/)
})
