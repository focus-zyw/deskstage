// 礼物反应旁路测试:档位映射(阈值边界)、开关、感谢语节流、A/B 轮流、revision 门。
// giftReactions 只 import 类型(运行时零依赖),node --test 经 vite ssrLoadModule 直载。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let gr

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  gr = await server.ssrLoadModule('/src/runtime/giftReactions.ts')
})

after(async () => {
  await server?.close()
})

/** 构造一个归一化 GiftEvent(与 src/live/types.ts 的 GiftEvent 同形) */
function giftEvent(over = {}) {
  return {
    kind: 'gift',
    platform: 'bilibili',
    roomId: '23058',
    userId: 'u1',
    username: '小明',
    timestamp: Date.now(),
    gift: { name: '小花花', count: 1, coinType: 'gold', totalCoin: 100 },
    ...over,
  }
}

/** 假件装配:记录道具与感谢语,开关可切 */
function makeHarness({ enabled = true } = {}) {
  const props = []
  const replies = []
  let on = enabled
  const reactions = gr.createGiftReactions({
    showProp: (who, propId) => props.push([who, propId]),
    present: (reply) => replies.push(reply),
    isEnabled: () => on,
  })
  return { props, replies, reactions, setEnabled: (v) => (on = v) }
}

test('档位映射:每个阈值的前一位、阈值本身、silver', () => {
  const t = gr.giftTierToProp
  assert.equal(t(0, 'gold'), 'coffee')
  assert.equal(t(gr.TIER_MID_COIN - 1, 'gold'), 'coffee')
  assert.equal(t(gr.TIER_MID_COIN, 'gold'), 'milk-tea')
  assert.equal(t(gr.TIER_TOP_COIN - 1, 'gold'), 'milk-tea')
  assert.equal(t(gr.TIER_TOP_COIN, 'gold'), 'microphone')
  // silver/免费礼物无论金额一律最低档
  assert.equal(t(999_999_999, 'silver'), 'coffee')
  assert.equal(t(0, 'silver'), 'coffee')
})

test('礼物触发道具与模板感谢语:经 present 走统一呈现口', () => {
  const h = makeHarness()
  h.reactions.onGift(giftEvent())
  assert.equal(h.props.length, 1)
  assert.equal(h.replies.length, 1)
  const reply = h.replies[0]
  assert.ok(['happy', 'wave', 'laugh'].includes(reply.action)) // 现有动作词表内
  assert.ok(reply.text.includes('小明')) // 模板插观众名
  assert.equal(reply.username, '小明')
  assert.equal(reply.speaker, 'A') // 首个展示角色
})

test('A/B 轮流展示;感谢语节流期内道具照放、嘴上不说', () => {
  const h = makeHarness()
  h.reactions.onGift(giftEvent())
  h.reactions.onGift(giftEvent({ gift: { name: '火箭', count: 1, coinType: 'gold', totalCoin: 50_000 } }))
  assert.deepEqual(h.props.map((p) => p[0]), ['A', 'B']) // 道具照放且轮流
  assert.deepEqual(h.props.map((p) => p[1]), ['coffee', 'microphone']) // 档位各自生效
  assert.equal(h.replies.length, 1) // 第二条感谢被节流
})

test('开关关闭:道具与感谢语都不出(旁路整体静默)', () => {
  const h = makeHarness({ enabled: false })
  h.reactions.onGift(giftEvent())
  assert.equal(h.props.length, 0)
  assert.equal(h.replies.length, 0)
  // 中途打开即恢复
  h.setEnabled(true)
  h.reactions.onGift(giftEvent())
  assert.equal(h.props.length, 1)
  assert.equal(h.replies.length, 1)
})

test('观众名清洗:换行/超长截断,空名回退通用称呼', () => {
  const h = makeHarness()
  h.reactions.onGift(giftEvent({ username: '很长的名字'.repeat(10) }))
  assert.ok(h.replies[0].text.includes('很长的名字'.repeat(2).slice(0, 12)))
  const h2 = makeHarness()
  h2.reactions.onGift(giftEvent({ username: '   ' }))
  assert.ok(h2.replies[0].text.includes('这位观众'))
})

test('revision 门:礼物感谢插队后,在途 AI 回复作废;无插队则通过', () => {
  const h = makeHarness()
  const gate = h.reactions.gate
  const at = gate.capture() // AI 发请求前记录
  h.reactions.onGift(giftEvent()) // 礼物插队(内部 bump)
  assert.equal(gate.valid(at), false) // AI 返回后校验失败 → 丢弃,不顶掉感谢语
  // 对照:没有礼物插队时,版本未变,回复有效
  const fresh = gr.createReactionGate()
  const at2 = fresh.capture()
  assert.equal(fresh.valid(at2), true)
})
