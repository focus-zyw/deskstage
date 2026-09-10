// 播放器中止语义回归:单次落盘策略的地基。
// stop() 必须上报"真实开播过的台词前缀"且不触发 onDone;
// 自然播完只触发 onDone;空闲时防御性 stop 是空操作。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let mod

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  mod = await server.ssrLoadModule('/src/performer/player.ts')
})

after(async () => {
  await server?.close()
})

const line = (speaker, text) => ({ speaker, text, action: '' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询直到事件出现(播放循环走真实定时器,需要等) */
async function waitUntil(pred, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(10)
  }
  assert.fail('等待事件超时')
}

function makePlayer(events) {
  return new mod.PerformancePlayer({
    onLineStart: (l) => {
      events.push(['start', l.text])
      return { speechPhase: Promise.resolve() }
    },
    onSpeechEnd: () => {},
    onLineEnd: () => {},
    onDone: () => events.push(['done']),
    onStopped: (played) => events.push(['stopped', played.map((l) => l.text)]),
  })
}

test('中途中止:onStopped 收到已播前缀,onDone 不触发', async () => {
  const events = []
  const player = makePlayer(events)
  player.play([line('A', '1'), line('B', '2'), line('A', '3')], { gap: 50 })
  await waitUntil(() => events.some((e) => e[0] === 'start' && e[1] === '1'))
  player.stop()
  assert.deepEqual(events.filter((e) => e[0] === 'stopped'), [['stopped', ['1']]])
  assert.ok(!events.some((e) => e[0] === 'done'), '中止不得触发 onDone')
  await sleep(50) // 等 async 循环退出
})

test('停在选择点:上报铺垫前缀,不触发 onDone', async () => {
  const events = []
  const player = makePlayer(events)
  player.play([line('A', '1'), line('B', '2')], {
    gap: 20,
    choice: { prompt: '选一个', options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] },
    after: { a: [line('A', '分支A')], b: [line('B', '分支B')] },
  })
  await waitUntil(() => events.some((e) => e[0] === 'start' && e[1] === '2'))
  await sleep(50) // 等 before 段收尾进入抉择等待
  await waitUntil(() => player.playing === false) // 抉择暂停期间视作非播放态
  player.stop()
  assert.deepEqual(events.filter((e) => e[0] === 'stopped'), [['stopped', ['1', '2']]])
  assert.ok(!events.some((e) => e[0] === 'done'))
  await sleep(50)
})

test('自然播完:只触发 onDone;随后防御性 stop 是空操作', async () => {
  const events = []
  const player = makePlayer(events)
  player.play([line('A', '1'), line('B', '2')], { gap: 10 })
  await waitUntil(() => events.some((e) => e[0] === 'done'))
  assert.ok(!events.some((e) => e[0] === 'stopped'), '自然播完不得触发 onStopped')
  player.stop() // 播完后的防御性清场
  assert.ok(!events.some((e) => e[0] === 'stopped'), '空闲时 stop 不得触发 onStopped')
})
