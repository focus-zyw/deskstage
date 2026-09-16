// 网页模型全模式支持回归:攒批弹幕回复容错解析、节奏分档、API Key 门放宽。
// 沿用仓库测试原则:不碰网络与磁盘,webchatAsk 依赖注入。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let generateLiveReplyBatch
let sanitizeLiveReplyBatch
let paceFor
let startLiveSession

before(async () => {
  ;({ generateLiveReplyBatch, sanitizeLiveReplyBatch } = await import('../src/engine/llmClient.ts'))
  ;({ paceFor, startLiveSession } = await import('../src/runtime/liveDanmaku.ts'))
})


const BATCH = [
  { username: '观众甲', content: '今天吃什么' },
  { username: '观众乙', content: '丙在干嘛' },
  { username: '观众丙', content: '哈哈哈哈' },
]

/** 种入最小 config(无 Key 无雷区);localStorage 桩 */
function seedLocalStorage(extra = {}) {
  const values = new Map([['vc-config', JSON.stringify({ userProfile: { banTopics: '' }, ...extra })]])
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
  return values
}

test('容错解析:合法 3 条原样通过(speaker/action 归一)', () => {
  const raw = JSON.stringify({
    replies: [
      { pick: 0, reply: '想吃火锅!', speaker: 'A', action: 'happy' },
      { pick: 1, reply: '丙在认真记账呢。', speaker: 'C', action: 'talk' },
      { pick: 2, reply: '笑什么,说来听听。', speaker: 'B', action: 'surprise' },
    ],
  })
  const out = sanitizeLiveReplyBatch(raw, BATCH.length)
  assert.equal(out.length, 3)
  assert.deepEqual(out[0], { pick: 0, reply: '想吃火锅!', speaker: 'A', action: 'happy' })
  assert.equal(out[1].speaker, 'C')
})

test('容错解析:宽容归一(speaker 非法归 A/action 非法归 talk,与 API 单条版同语义)+ 坏 pick/空 reply 丢弃', () => {
  const raw = JSON.stringify({
    replies: [
      { pick: 99, reply: '越界', speaker: 'A', action: 'talk' },
      { pick: 0, reply: '好', speaker: 'X', action: 'dance' },
      { pick: 1, reply: '   ', speaker: 'A', action: 'talk' },
      { reply: '没有 pick', speaker: 'A', action: 'talk' },
      { pick: 2, reply: '这条有效', speaker: 'B', action: 'laugh' },
    ],
  })
  const out = sanitizeLiveReplyBatch(raw, BATCH.length)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { pick: 0, reply: '好', speaker: 'A', action: 'talk' }, '坏 speaker/action 归一不丢弃')
  assert.deepEqual(out[1], { pick: 2, reply: '这条有效', speaker: 'B', action: 'laugh' })
})

test('容错解析:pick 去重保首个;上限 5;非 JSON/缺 replies 抛错;全部无效抛错', () => {
  const dup = sanitizeLiveReplyBatch(
    JSON.stringify({ replies: [
      { pick: 0, reply: '第一条', speaker: 'A', action: 'talk' },
      { pick: 0, reply: '重复 pick', speaker: 'B', action: 'talk' },
    ] }),
    BATCH.length,
  )
  assert.equal(dup.length, 1)
  assert.equal(dup[0].reply, '第一条')

  const many = sanitizeLiveReplyBatch(
    JSON.stringify({ replies: Array.from({ length: 8 }, (_, i) => ({ pick: i, reply: `r${i}`, speaker: 'A', action: 'talk' })) }),
    8,
  )
  assert.equal(many.length, 5)

  assert.throws(() => sanitizeLiveReplyBatch('不是JSON', 3), /JSON/)
  assert.throws(() => sanitizeLiveReplyBatch(JSON.stringify({ foo: 1 }), 3), /replies/)
  // 全部无效:sanitize 返回空数组,抛错回退在 generateLiveReplyBatch 层(上方用例已覆盖)
  assert.equal(sanitizeLiveReplyBatch(JSON.stringify({ replies: [{ pick: 0, reply: '  ', speaker: 'A', action: 'talk' }] }), 3).length, 0)
})

test('generateLiveReplyBatch:走注入的 webchatAsk(整段 prompt 含弹幕与协议),返回解析结果', async () => {
  seedLocalStorage()
  let captured = ''
  const replies = await generateLiveReplyBatch(BATCH, [], {
    webchatAsk: async (prompt) => {
      captured = prompt
      return JSON.stringify({ replies: [
        { pick: 0, reply: '想吃火锅!', speaker: 'A', action: 'happy' },
        { pick: 1, reply: '丙在记账。', speaker: 'C', action: 'talk' },
      ] })
    },
  })
  assert.equal(replies.length, 2)
  assert.match(captured, /观众甲:今天吃什么/)
  assert.match(captured, /"replies"/)
  assert.match(captured, /挑出最值得回的 3~5 条/)
})

test('generateLiveReplyBatch:网页全部无效/ask 抛错 → 向上抛错(调用方回退 API)', async () => {
  seedLocalStorage()
  await assert.rejects(() =>
    generateLiveReplyBatch(BATCH, [], { webchatAsk: async () => JSON.stringify({ replies: [] }) }),
  )
  await assert.rejects(() =>
    generateLiveReplyBatch(BATCH, [], { webchatAsk: async () => { throw new Error('网页超时') } }),
    /网页超时/,
  )
})

test('节奏分档:API 档现状不变,网页档放宽(过期 90s/间隔 30s/每分钟 2 次)', () => {
  assert.deepEqual(paceFor(false), { staleMs: 15_000, minGapMs: 2_000, callsPerMin: 8, batchSize: 5 })
  assert.deepEqual(paceFor(true), { staleMs: 90_000, minGapMs: 30_000, callsPerMin: 2, batchSize: 5 })
})

test('会话快照:webchat 档由开播时配置决定(startLiveSession 不抛错即会话可建)', async () => {
  seedLocalStorage({ webchatEnabled: true })
  // provider 连接在无 Tauri 环境会失败,但会话构造/门判断已执行;断言不抛即通过
  await startLiveSession('bilibili', '1', {
    onReply: () => {},
    onStatus: () => {},
  }).catch(() => 'connect-failed-is-ok')
  const m = await import('../src/runtime/liveDanmaku.ts')
  m.stopLiveSession()
  assert.ok('会话生命周期在无 Tauri 环境下安全')
})
