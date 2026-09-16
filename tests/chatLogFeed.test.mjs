// 聊天记录回放的纯逻辑回归:
// ①sanitizeChatEntry 字段级清洗——who/text/ts 非法整条拒收,text 截断;
// ②buildFeed 把演出集与聊天消息合并成统一时间线——升序穿插、同 ts 时聊天消息在前;
// ③空输入空输出。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let store

before(async () => {
  store = await import('../src/storage/chatLogStore.ts')
})


const ep = (ts, text) => ({
  ts,
  mode: 'daily',
  fav: false,
  lines: [{ speaker: 'A', text, action: 'talk' }],
})

test('sanitizeChatEntry:合法条目保留', () => {
  assert.deepEqual(store.sanitizeChatEntry({ ts: 1000, who: 'user', text: ' 你好 ' }), {
    ts: 1000,
    who: 'user',
    text: '你好',
  })
  assert.deepEqual(store.sanitizeChatEntry({ ts: 1000, who: 'B', text: '哈喽' }), {
    ts: 1000,
    who: 'B',
    text: '哈喽',
  })
})

test('sanitizeChatEntry:who 非法 / text 空 / ts 缺失整条拒收,text 超长截断', () => {
  assert.equal(store.sanitizeChatEntry({ ts: 1, who: 'D', text: 'x' }), null)
  assert.equal(store.sanitizeChatEntry({ ts: 1, who: 'user', text: '   ' }), null)
  assert.equal(store.sanitizeChatEntry({ ts: 1, who: 'user', text: 42 }), null)
  assert.equal(store.sanitizeChatEntry({ who: 'user', text: 'x' }), null)
  assert.equal(store.sanitizeChatEntry(null), null)
  const long = store.sanitizeChatEntry({ ts: 1, who: 'A', text: '啊'.repeat(600) })
  assert.equal(long.text.length, 500)
})

test('buildFeed:集块与消息按 ts 升序穿插', () => {
  const feed = store.buildFeed([ep(3000, '演出'), ep(1000, '开场')], [
    { ts: 2000, who: 'user', text: '插一句' },
    { ts: 4000, who: 'A', text: '应答' },
  ])
  assert.deepEqual(
    feed.map((i) => [i.kind, i.ts]),
    [
      ['episode', 1000],
      ['chat', 2000],
      ['episode', 3000],
      ['chat', 4000],
    ],
  )
  assert.equal(feed[0].ep.lines[0].text, '开场')
  assert.equal(feed[1].entry.text, '插一句')
})

test('buildFeed:同 ts 时聊天消息排在集块前(稳定排序)', () => {
  const feed = store.buildFeed([ep(1000, '演出')], [{ ts: 1000, who: 'user', text: '同时刻' }])
  assert.equal(feed[0].kind, 'chat')
  assert.equal(feed[1].kind, 'episode')
})

test('buildFeed:空输入空输出', () => {
  assert.deepEqual(store.buildFeed([], []), [])
})
