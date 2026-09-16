// 直播事件路由测试:handleLiveEvent 分流 —— gift 走免 AI 旁路(绝不进 LLM inbox),
// danmaku 走过滤+入队。假 session 直接驱动导出的路由函数,不起真连接。
// 附:noteActivity 记账在 gift 分支先行(一行代码,行为由 giftReactions 测试覆盖开关逻辑)。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let ld

before(async () => {
  ld = await import('../src/runtime/liveDanmaku.ts')
})


/** 假 session:只需路由函数触达的字段;reactions 用假件记录旁路调用 */
function fakeSession() {
  const s = {
    inbox: [],
    seen: new Map(),
    banTopics: [],
    giftCalls: [],
    reactions: { onGift: (e) => s.giftCalls.push(e), gate: { capture: () => 0, valid: () => true, bump: () => {} } },
  }
  return s
}

test('gift 事件进旁路,不进 LLM inbox', () => {
  const s = fakeSession()
  ld.handleLiveEvent(s, {
    kind: 'gift',
    platform: 'bilibili',
    roomId: '23058',
    userId: '1',
    username: '小明',
    timestamp: Date.now(),
    gift: { name: '小花花', count: 1, coinType: 'gold', totalCoin: 100 },
  })
  assert.equal(s.inbox.length, 0) // 不入弹幕队列 → 永远不会被 AI 消费
  assert.equal(s.giftCalls.length, 1)
  assert.equal(s.giftCalls[0].gift.name, '小花花')
})

test('danmaku 事件走过滤入队;超长/空文本被滤掉', () => {
  const s = fakeSession()
  const mk = (content) => ({ kind: 'danmaku', platform: 'bilibili', roomId: '23058', userId: '2', username: 'b', content, timestamp: Date.now(), guard: 0 })
  ld.handleLiveEvent(s, mk('你好'))
  ld.handleLiveEvent(s, mk('x'.repeat(80))) // 超长过滤
  ld.handleLiveEvent(s, mk('   ')) // 空文本过滤
  assert.equal(s.inbox.length, 1)
  assert.equal(s.inbox[0].content, '你好')
  assert.equal(s.giftCalls.length, 0)
})
