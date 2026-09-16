// 道具效果 store 测试:时序不变量逐条钉死(不变量清单见 src/runtime/propEffects.ts 头注释)。
// 真实 setTimeout 驱动,时长用小毫秒数;beforeEach clearProps 顺带重置冷却账。
import assert from 'node:assert/strict'
import { before, beforeEach, test } from 'node:test'

let pe

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  pe = await import('../src/runtime/propEffects.ts')
})


beforeEach(() => {
  pe.clearProps()
})

test('展示后到期:先标记 leaving 播淡出,再移除', async () => {
  pe.showProp('A', 'coffee', { durationMs: 40 })
  assert.equal(pe.getPropEffects().length, 1)
  assert.equal(pe.getPropEffects()[0].leaving, false)
  await sleep(60) // 40ms 到期 → leaving=true,进入 360ms 淡出
  const leaving = pe.getPropEffects()
  assert.equal(leaving.length, 1)
  assert.equal(leaving[0].leaving, true)
  await sleep(500) // 淡出窗口(至 ~400ms)走完 → 移除
  assert.equal(pe.getPropEffects().length, 0)
})

test('同 key 替换绕过冷却,旧 timer 不删新道具', async () => {
  pe.showProp('A', 'magnifier', { key: 'utility', durationMs: 0 }) // sticky 常驻
  pe.showProp('A', 'success', { key: 'utility', durationMs: 40 }) // 立即替换,无需等冷却
  const fx = pe.getPropEffects()
  assert.equal(fx.length, 1)
  assert.equal(fx[0].propId, 'success')
  // 场景:短时限旧道具被长时限新道具替换,旧 timer 到点也不得误删新道具
  pe.showProp('A', 'magnifier', { key: 'utility', durationMs: 40 })
  pe.showProp('A', 'success', { key: 'utility', durationMs: 5_000 })
  await sleep(120)
  const after = pe.getPropEffects()
  assert.equal(after.length, 1)
  assert.equal(after[0].propId, 'success')
})

test('sticky(durationMs:0)常驻,不自动到期', async () => {
  pe.showProp('A', 'magnifier', { key: 'utility', durationMs: 0 })
  await sleep(60)
  assert.equal(pe.getPropEffects().length, 1)
  assert.equal(pe.getPropEffects()[0].leaving, false)
})

test('无 key 展示受冷却约束;同 key 与不同道具互不影响', () => {
  assert.equal(pe.showProp('A', 'coffee', { durationMs: 100 }), true)
  assert.equal(pe.showProp('B', 'coffee', { durationMs: 100 }), false) // 同道具冷却拦下
  assert.equal(pe.getPropEffects().length, 1)
  assert.equal(pe.showProp('B', 'milk-tea', { durationMs: 100 }), true) // 不同道具不受影响
  // 同 key 替换连发两次,均不被冷却拦
  assert.equal(pe.showProp('A', 'success', { key: 'utility', durationMs: 100 }), true)
  assert.equal(pe.showProp('A', 'question', { key: 'utility', durationMs: 100 }), true)
  assert.equal(pe.getPropEffects().length, 3)
})

test('同屏上限 3 个:超限逐出最早展示的,槽位 0/1/2 错位', () => {
  pe.showProp('A', 'coffee', { durationMs: 10_000 })
  pe.showProp('A', 'milk-tea', { durationMs: 10_000 })
  pe.showProp('A', 'microphone', { durationMs: 10_000 })
  let fx = pe.getPropEffects()
  assert.equal(fx.length, 3)
  assert.deepEqual(fx.map((e) => e.slot).sort(), [0, 1, 2])
  pe.showProp('B', 'success', { key: 'fourth', durationMs: 10_000 })
  fx = pe.getPropEffects()
  assert.equal(fx.length, 3)
  assert.equal(fx.some((e) => e.propId === 'coffee'), false) // 最早的被逐出
  assert.deepEqual(fx.map((e) => e.slot).sort(), [0, 1, 2]) // 槽位依然错开不重叠
})

test('dismissProps 按 key 移除,不伤其他道具', () => {
  pe.showProp('A', 'magnifier', { key: 'utility', durationMs: 0 })
  pe.showProp('B', 'coffee', { durationMs: 5_000 })
  pe.dismissProps('utility')
  const fx = pe.getPropEffects()
  assert.equal(fx.length, 1)
  assert.equal(fx[0].propId, 'coffee')
})

test('clearProps 清空全部道具与 timer,不复活', async () => {
  pe.showProp('A', 'coffee', { durationMs: 30 })
  pe.showProp('B', 'milk-tea', { durationMs: 30 })
  pe.clearProps()
  assert.equal(pe.getPropEffects().length, 0)
  await sleep(60)
  assert.equal(pe.getPropEffects().length, 0)
})
