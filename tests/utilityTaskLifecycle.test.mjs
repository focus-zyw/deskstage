// 工具任务生命周期订阅回归:开始/结束各广播一次,失败也必须收尾。
// end 漏发会让 C 的"围观工作姿势"永远不还原(见 utilityTasks.ts 头注释)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

let mod

before(async () => {
  // runUtilityTask 内部用 window.setTimeout 给完成卡做自动消失,Node 侧补桩并压缩延时
  globalThis.window = {
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 5)),
    clearTimeout: (t) => clearTimeout(t),
  }
  mod = await import('../src/runtime/utilityTasks.ts')
})

after(async () => {
  delete globalThis.window
})

test('任务开始/结束各广播一次生命周期,带任务种类', async () => {
  const events = []
  const off = mod.onUtilityTaskLifecycle((l) => events.push(l))
  await mod.runUtilityTask('translate', '翻译', 'A', async (report) => {
    report('翻一半…')
    return '翻完了'
  })
  off()
  assert.equal(events.length, 2)
  assert.equal(events[0].phase, 'start')
  assert.equal(events[0].kind, 'translate')
  assert.equal(events[1].phase, 'end')
  assert.equal(events[1].id, events[0].id)
})

test('任务失败也必须广播 end(否则工作姿势永远不还原)', async () => {
  const events = []
  mod.onUtilityTaskLifecycle((l) => events.push(l))
  await mod.runUtilityTask('save', '保存', 'B', async () => {
    throw new Error('炸了')
  })
  assert.equal(events.filter((e) => e.phase === 'start').length, 1)
  assert.equal(events.filter((e) => e.phase === 'end').length, 1)
})

test('退订后不再收到广播', async () => {
  const events = []
  const off = mod.onUtilityTaskLifecycle((l) => events.push(l))
  off()
  await mod.runUtilityTask('translate', '翻译', 'A', async () => '好')
  assert.equal(events.length, 0)
})
