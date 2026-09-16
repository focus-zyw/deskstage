import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let IdleDirector

before(async () => {
  ;({ IdleDirector } = await import('../src/stage/idleDirector.ts'))
})


function fakeClock(randomValues = []) {
  let now = 0
  let nextId = 1
  const timers = new Map()
  const random = [...randomValues]

  return {
    now: () => now,
    random: () => random.shift() ?? 0,
    setTimeout(callback, delayMs) {
      const id = nextId++
      timers.set(id, { callback, at: now + delayMs })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(delayMs) {
      const target = now + delayMs
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0]
        if (!next) break
        const [id, timer] = next
        timers.delete(id)
        now = timer.at
        timer.callback()
      }
      now = target
    },
    pending: () => timers.size,
  }
}

test('待机循环先等候，再展示特殊姿势，随后回到基础图', () => {
  // 初次延迟取中位数、变体抽取命中唯一候选、休息间隔取下限。
  const clock = fakeClock([0.5, 0, 0])
  const frames = []
  const director = new IdleDirector(clock)
  director.start({
    baseFile: 'idle.png',
    variants: [{ file: 'idle-look.png', activationDelayMs: 8_000, holdMs: 4_000 }],
    onFrame: (frame) => frames.push(frame),
  })

  clock.advance(7_999)
  assert.deepEqual(frames, [])
  clock.advance(1)
  assert.deepEqual(frames, [{ file: 'idle-look.png', special: true }])
  clock.advance(3_999)
  assert.equal(frames.length, 1)
  clock.advance(1)
  assert.deepEqual(frames.at(-1), { file: 'idle.png', special: false })
  assert.equal(clock.pending(), 1)
})

test('stop 会取消尚未发生的待机姿势', () => {
  const clock = fakeClock([0.5])
  const frames = []
  const director = new IdleDirector(clock)
  director.start({
    baseFile: 'idle.png',
    variants: [{ file: 'idle-look.png', activationDelayMs: 8_000 }],
    onFrame: (frame) => frames.push(frame),
  })

  director.stop()
  clock.advance(30_000)
  assert.deepEqual(frames, [])
  assert.equal(clock.pending(), 0)
})

test('没有延迟待机变体时不启动定时器', () => {
  const clock = fakeClock()
  const director = new IdleDirector(clock)
  director.start({
    baseFile: 'idle.png',
    variants: [{ file: 'idle.png', weight: 1 }],
    onFrame: () => assert.fail('不应切换图片'),
  })
  assert.equal(clock.pending(), 0)
})
