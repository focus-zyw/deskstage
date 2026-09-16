// 设置即存队列测试:合并/冲刷/丢弃语义逐条钉死(见 src/settings/saveQueue.ts 头注释)。
// 真实 setTimeout 驱动,防抖窗口用小毫秒数。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let mod

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  mod = await import('../src/settings/saveQueue.ts')
})


test('防抖窗口内的多次文本输入合并为一次落盘,后写覆盖先写', async () => {
  const commits = []
  const q = mod.createSettingsSaveQueue((p) => commits.push(p), 30)
  q.save({ autoReplayMin: 5 })
  q.save({ autoReplayMin: 8 })
  q.save({ autoReplayMin: 10, userProfile: { userName: '张三' } })
  assert.equal(commits.length, 0) // 窗口内不落盘
  await sleep(60)
  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0], { autoReplayMin: 10, userProfile: { userName: '张三' } })
  assert.equal(q.pending(), false)
})

test('immediate 立即落盘并顺带带走已排队字段', async () => {
  const commits = []
  const q = mod.createSettingsSaveQueue((p) => commits.push(p), 30)
  q.save({ envSense: true })
  await q.save({ proactivity: 'lively' }, true) // 开关类离散操作
  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0], { envSense: true, proactivity: 'lively' })
  // 不再有挂起防抖:窗口过期后不会二次落盘
  await sleep(60)
  assert.equal(commits.length, 1)
})

test('防抖到期只落盘一次,不会因队列重置丢字段', async () => {
  const commits = []
  const q = mod.createSettingsSaveQueue((p) => commits.push(p), 25)
  q.save({ a: 1 })
  await sleep(15)
  q.save({ b: 2 }) // 重置窗口,字段保留
  await sleep(50)
  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0], { a: 1, b: 2 })
})

test('dispose 丢弃待存包并取消挂起防抖(窗口卸载后不迟到落盘)', async () => {
  const commits = []
  const q = mod.createSettingsSaveQueue((p) => commits.push(p), 25)
  q.save({ a: 1 })
  q.dispose()
  assert.equal(q.pending(), false)
  await sleep(50)
  assert.equal(commits.length, 0)
})

test('commit 失败向 immediate 调用方传播,且待存包不回滚重投', async () => {
  let fail = true
  const commits = []
  const q = mod.createSettingsSaveQueue((p) => {
    commits.push(p)
    if (fail) throw new Error('disk full')
  }, 30)
  await assert.rejects(() => q.save({ a: 1 }, true))
  assert.deepEqual(commits, [{ a: 1 }])
  fail = false
  await q.save({ b: 2 }) // 下一次保存照常,不重投旧包
  await sleep(50)
  assert.deepEqual(commits, [{ a: 1 }, { b: 2 }])
})

test('flush 手动冲刷:无待存时空转,有待存时立即提交', async () => {
  const commits = []
  const q = mod.createSettingsSaveQueue((p) => commits.push(p), 10_000)
  await q.flush()
  assert.equal(commits.length, 0)
  q.save({ a: 1 })
  await q.flush()
  assert.deepEqual(commits, [{ a: 1 }])
  assert.equal(q.pending(), false)
})
