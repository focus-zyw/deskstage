// 非喜剧场景卡往返回归(2026-09 提示词修复):清洗层只看数据合法性(secret/callback
// 可选),模式规则由 validatePerformanceScript 的 comedy 选项把关——
// 非喜剧卡要能活着走完 生成→落盘/收藏聚合→预取缓存 全链路,不得无声消失。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let schema
let history
let prefetch

// 无 secret/callback 的合法非喜剧卡
const card = {
  relationship: '老朋友',
  scene: '周末的客厅',
  goalA: '想安静待着',
  goalB: '想聊天',
  escalation: ['坐下', '倒水', '开口'],
}

const line = (speaker, text) => ({ speaker, text, action: 'talk' })

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
  schema = await server.ssrLoadModule('/src/performer/dialogSchema.ts')
  history = await server.ssrLoadModule('/src/storage/historyStore.ts')
  prefetch = await server.ssrLoadModule('/src/storage/prefetchStore.ts')
})

after(async () => {
  await server?.close()
  delete globalThis.localStorage
})

test('清洗层:非喜剧无 secret 卡合法,基础结构缺失仍然废卡', () => {
  const c = schema.sanitizeSceneCard(card)
  assert.ok(c, '缺 secret 不再废卡')
  assert.equal(c.secret, undefined)
  assert.equal(c.callback, undefined)
  assert.equal(schema.sanitizeSceneCard({ ...card, scene: '' }), undefined)
  assert.equal(schema.sanitizeSceneCard({ ...card, escalation: [] }), undefined)
})

test('校验层:喜剧卡缺 secret/callback 是 fatal;非喜剧不检查;无卡容忍', () => {
  const script = {
    before: [line('A', '一'), line('B', '二'), line('A', '三'), line('B', '四')],
    card: schema.sanitizeSceneCard(card),
    after: {},
  }
  const comedyV = schema.validatePerformanceScript(script, 4, { comedy: true })
  assert.ok(comedyV.fatal.some((f) => f.includes('secret')))
  assert.ok(comedyV.fatal.some((f) => f.includes('callback')))
  assert.deepEqual(schema.validatePerformanceScript(script, 4, { comedy: false }).fatal, [])
  const noCard = { before: script.before, card: undefined, after: {} }
  assert.deepEqual(schema.validatePerformanceScript(noCard, 4, { comedy: true }).fatal, [], '卡整体缺失仍容忍')
})

test('分集聚合:无 secret 卡落盘→聚合读取后仍保留', () => {
  const entries = [
    { ...line('A', '一'), ts: 1, mode: 'daily', eid: 'e1', card },
    { ...line('B', '二'), ts: 2, mode: 'daily', eid: 'e1' },
  ]
  const [ep] = history.aggregateEpisodes(entries)
  assert.ok(ep.card, '卡没有被清洗层丢掉')
  assert.equal(ep.card.secret, undefined)
  assert.equal(ep.card.scene, '周末的客厅')
  assert.deepEqual(ep.card.escalation, ['坐下', '倒水', '开口'])
})

test('预取缓存:无 secret 卡的剧本存→取往返后卡保留', async () => {
  await prefetch.savePrefetchEntry({
    mode: 'daily',
    topic: '泡茶',
    script: {
      before: [line('A', '一'), line('B', '二'), line('A', '三'), line('B', '四')],
      card,
      choice: undefined,
      after: {},
    },
  })
  const taken = await prefetch.takePrefetch('daily', '泡茶')
  assert.ok(taken, '预取条目取回')
  assert.ok(taken.script.card, '往返后卡保留')
  assert.equal(taken.script.card.secret, undefined)
  assert.equal(taken.script.card.scene, '周末的客厅')
})
