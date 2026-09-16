// 朗读归一化与情绪收敛的回归测试。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let normalizeForSpeech
let diversifyDeliveries
let deliverySpeed

before(async () => {
  ;({ normalizeForSpeech, diversifyDeliveries, deliverySpeed } = await import('../src/performer/dialogSchema.ts'))
})


test('朗读归一化:AI/省略号/长破折号/百分号统一读法', () => {
  assert.equal(normalizeForSpeech('AI助手'), 'A I 助手')
  assert.equal(normalizeForSpeech('等等……然后……'), '等等，然后，')
  assert.equal(normalizeForSpeech('我说——算了'), '我说，算了')
  assert.equal(normalizeForSpeech('便宜50%'), '便宜百分之50')
  assert.equal(normalizeForSpeech('  多余   空格 '), '多余 空格')
})

test('语速收敛:三档都在 0.9~1.1 的窄区间', () => {
  assert.equal(deliverySpeed('deadpan'), 0.96)
  assert.equal(deliverySpeed('excited'), 1.06)
  assert.equal(deliverySpeed('slow'), 0.92)
  assert.equal(deliverySpeed(undefined), 1)
})

const line = (speaker, text, delivery) => ({ speaker, text, action: 'talk', delivery })

test('情绪收敛:同角色同种强情绪第三句起降回普通', () => {
  const lines = [
    line('A', '一', 'excited'),
    line('A', '二', 'excited'),
    line('A', '三', 'excited'),
    line('A', '四', 'excited'),
  ]
  const out = diversifyDeliveries(lines)
  assert.equal(out[0].delivery, 'excited')
  assert.equal(out[1].delivery, 'excited')
  assert.equal(out[2].delivery, undefined)
  assert.equal(out[3].delivery, undefined)
})

test('情绪收敛:换角色或夹普通语气会重新计数', () => {
  const lines = [
    line('A', '一', 'slow'),
    line('B', '二', 'slow'),
    line('A', '三', 'slow'),
    line('A', '四', undefined),
    line('A', '五', 'slow'),
  ]
  const out = diversifyDeliveries(lines)
  assert.equal(out[0].delivery, 'slow')
  assert.equal(out[1].delivery, 'slow') // 不同角色,各自计数
  assert.equal(out[2].delivery, 'slow') // A 只连续第 2 句
  assert.equal(out[4].delivery, 'slow') // 中间夹了普通语气,重新起算
})

test('情绪收敛:普通语气(无 delivery)不受影响', () => {
  const lines = [line('A', '一', undefined), line('A', '二', undefined), line('A', '三', undefined)]
  const out = diversifyDeliveries(lines)
  assert.ok(out.every((l) => l.delivery === undefined))
})
