// 演出中插话(P4)规划器回归:反应回合插在已播之后、剩余剧本之前;
// 未选边时保留原抉择点,已选边不再携带;下标语义 = 已开播当前句(算已播)。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let interjection

before(async () => {
  interjection = await import('../src/dialogue/interjection.ts')
})


const line = (speaker, text) => ({ speaker, text, action: '' })

test('未选边时接回:反应 + 剩余合成新列表,并保留原抉择点', () => {
  const playing = [line('A', '1'), line('B', '2'), line('A', '3'), line('B', '4')]
  const reaction = [line('A', '回应插话')]
  const plan = interjection.planInterjectionTakeover({
    reaction,
    playingLines: playing,
    index: 1, // 第 2 句开播后接的话
    chosen: false,
  })
  assert.equal(plan.keepChoice, true)
  assert.deepEqual(
    plan.list.map((l) => l.text),
    ['回应插话', '3', '4'], // 反应插在已播之后、剩余之前
  )
  assert.equal(plan.consumedIndex, 1)
})

test('选边后接回:不再携带抉择点', () => {
  const plan = interjection.planInterjectionTakeover({
    reaction: [line('B', '回应')],
    playingLines: [line('A', '分支1'), line('B', '分支2')],
    index: 0,
    chosen: true,
  })
  assert.equal(plan.keepChoice, false)
  assert.deepEqual(
    plan.list.map((l) => l.text),
    ['回应', '分支2'],
  )
})

test('keepChoiceOpts:未选边透传,已选边返回 undefined', () => {
  const choice = { prompt: 'p', options: [] }
  assert.equal(interjection.keepChoiceOpts(false, choice), choice)
  assert.equal(interjection.keepChoiceOpts(true, choice), undefined)
  assert.equal(interjection.keepChoiceOpts(false, undefined), undefined)
})

test('当前句是最后一句时仍能合成(剩余为空,列表只含反应)', () => {
  const plan = interjection.planInterjectionTakeover({
    reaction: [line('A', '接话')],
    playingLines: [line('A', '1'), line('B', '2')],
    index: 1,
    chosen: false,
  })
  assert.deepEqual(
    plan.list.map((l) => l.text),
    ['接话'],
  )
})
