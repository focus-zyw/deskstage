// 感知通知分发验收:统一间隔一次取注记 → 出口播报;不合时先不取注记(冷却账本
// 不消费,感知顺延不丢);无注记不播;start 幂等 / stop 清理。假时钟+假依赖全 DI。
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createServer } from 'vite'

let server
let m

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  m = { worldNotify: await server.ssrLoadModule('/src/runtime/worldNotify.ts') }
})

after(async () => {
  await server?.close()
})

/** 假时钟:可推进的 interval(单一 tick) */
function fakeClock() {
  let tick = null
  return {
    clock: {
      setInterval(fn) {
        tick = fn
        return () => {
          tick = null
        }
      },
    },
    fire() {
      tick?.()
    },
    hasTimer: () => tick !== null,
  }
}

test('统一间隔:合时且有注记 → 出口播报一条;无注记不播', () => {
  const fc = fakeClock()
  const said = []
  let notes = ['用户正开着IDEA忙;电脑电量只剩 15%']
  const wn = m.worldNotify.createWorldNotify({
    getNote: () => notes.shift(),
    allowed: () => true,
    say: (t) => said.push(t),
    clock: fc.clock,
  })
  wn.start(30 * 60_000)
  fc.fire()
  assert.deepEqual(said, ['用户正开着IDEA忙;电脑电量只剩 15%'])
  // 重新装一个无注记的分发器验证静默
  const fc2 = fakeClock()
  const said2 = []
  const wn2 = m.worldNotify.createWorldNotify({
    getNote: () => undefined,
    allowed: () => true,
    say: (t) => said2.push(t),
    clock: fc2.clock,
  })
  wn2.start()
  fc2.fire()
  assert.deepEqual(said2, [])
})

test('不合时先不取注记:冷却账本不消费,感知顺延不丢', () => {
  const fc = fakeClock()
  let allowed = false
  let taken = 0
  const said = []
  const wn = m.worldNotify.createWorldNotify({
    getNote: () => {
      taken += 1
      return '用户已经连续忙了 120 分钟没休息'
    },
    allowed: () => allowed,
    say: (t) => said.push(t),
    clock: fc.clock,
  })
  wn.start()
  fc.fire()
  assert.equal(taken, 0, '不合时不应消费注记')
  assert.deepEqual(said, [])
  allowed = true
  fc.fire()
  assert.deepEqual(said, ['用户已经连续忙了 120 分钟没休息'])
  assert.equal(taken, 1)
})

test('start 幂等不重复挂表;stop 后停表可重启', () => {
  const fc = fakeClock()
  let fired = 0
  const wn = m.worldNotify.createWorldNotify({
    getNote: () => 'n',
    allowed: () => true,
    say: () => {
      fired += 1
    },
    clock: fc.clock,
  })
  wn.start()
  wn.start()
  assert.equal(fc.hasTimer(), true)
  fc.fire()
  fc.fire()
  assert.equal(fired, 2, '幂等:仍只有一个 tick')
  wn.stop()
  assert.equal(fc.hasTimer(), false, 'stop 后无表')
  wn.start()
  assert.equal(fc.hasTimer(), true, '重启后恢复')
})
