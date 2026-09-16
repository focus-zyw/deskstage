// Relay 台词解析验收:模型输出不可信——speaker 忽略、动作白名单、截断、
// 容错取首个 JSON、结构不对一律 null(不猜)。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let m

before(async () => {
  m = await import('../src/relay/relaySchema.ts')
})


test('正常解析:text/action/intent,容错围栏与前后说明', () => {
  const ok = m.parseRelayTurn('{"text":"蛋糕上写着你的名字","action":"surprise","intent":"continue"}')
  assert.deepEqual(ok, { text: '蛋糕上写着你的名字', action: 'surprise', intent: 'continue' })
  const fenced = m.parseRelayTurn('好的,这是我的台词:\n```json\n{"text":"我看看","intent":"end"}\n```')
  assert.deepEqual(fenced, { text: '我看看', action: 'talk', intent: 'end' })
})

test('speaker 一律忽略:谁发言由本地轮转决定', () => {
  const r = m.parseRelayTurn('{"text":"我说的","speaker":"Z","action":"wave"}')
  assert.equal(r.text, '我说的')
  assert.equal('speaker' in r, false)
})

test('action 越轨按 talk;text 截断 80 字;空文本拒绝', () => {
  assert.equal(m.parseRelayTurn('{"text":"hi","action":"fly"}').action, 'talk')
  const long = m.parseRelayTurn(JSON.stringify({ text: 'x'.repeat(120) }))
  assert.equal(long.text.length, 80)
  assert.equal(m.parseRelayTurn('{"text":"  "}'), null)
  assert.equal(m.parseRelayTurn('{"action":"talk"}'), null)
})

test('结构不对一律 null:非 JSON / 数组 / 纯文本', () => {
  assert.equal(m.parseRelayTurn('完全不是 JSON'), null)
  assert.equal(m.parseRelayTurn('[{"text":"a"}]'), null)
  assert.equal(m.parseRelayTurn('{"text":123}'), null)
})

test('归一化:去标点空白小写,供重复检测', () => {
  assert.equal(m.normalizeRelayText('嗯,嗯!好的。'), '嗯嗯好的')
  assert.equal(m.normalizeRelayText('Hello World'), 'helloworld')
})
