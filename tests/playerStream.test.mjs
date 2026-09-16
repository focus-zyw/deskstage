// playStream 流式播放验收:单句 lookahead(下一句请求在当前句播放时已在飞)、
// done 值经 onSourceEnd 先于 onDone 交还、最后一句不清气泡、
// stop() 同步 onStopped 前缀 + 异步 iterator.return()、首句前抛错走 onSourceError。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let mod

before(async () => {
  mod = await import('../src/performer/player.ts')
})


const line = (speaker, text) => ({ speaker, text, action: '' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    onLineStart: (l, i) => {
      events.push(['start', l.text, i])
      return { speechPhase: Promise.resolve() }
    },
    onSpeechEnd: (s) => events.push(['speechEnd', s]),
    onLineEnd: (s) => events.push(['end', s]),
    onDone: () => events.push(['done']),
    onStopped: (played) => events.push(['stopped', played.map((l) => l.text)]),
  })
}

/** 记录 finally(验证 stop() 的 iterator.return() 触发会话释放路径) */
async function* gen(lines, result, track) {
  if (track) track.entered = true
  try {
    for (const l of lines) yield l
    return result
  } finally {
    if (track) track.closed = true
  }
}

test('自然流完:单句 lookahead、最后一句不清气泡、onSourceEnd 先于 onDone', async () => {
  const events = []
  const player = makePlayer(events)
  // initial 是播放器外交付的第一句;source 只含剩余句(relay 的 rest 契约)
  player.playStream(gen([line('B', '2'), line('A', '3')], { natural: true }), {
    gap: 10,
    initial: line('A', '1'),
    onSourceEnd: (r) => events.push(['sourceEnd', r]),
  })
  await waitUntil(() => events.some((e) => e[0] === 'done'))
  const starts = events.filter((e) => e[0] === 'start')
  assert.equal(starts.length, 3)
  const ends = events.filter((e) => e[0] === 'end')
  assert.equal(ends.length, 2, '最后一句不清气泡')
  const doneAt = events.findIndex((e) => e[0] === 'done')
  const sourceEndAt = events.findIndex((e) => e[0] === 'sourceEnd')
  assert.notEqual(sourceEndAt, -1, 'onSourceEnd 必须交还 done 值')
  assert.ok(sourceEndAt < doneAt, 'onSourceEnd 先于 onDone(提交语义定 naturalness)')
  assert.deepEqual(events[sourceEndAt][1], { natural: true })
})

test('中途中止:onStopped 同步收前缀,onDone 不触发,iterator 被关闭', async () => {
  const events = []
  const track = {}
  const player = makePlayer(events)
  player.playStream(gen([line('A', '1'), line('B', '2'), line('A', '3')], { natural: true }, track), {
    gap: 10,
    initial: line('A', '1'),
  })
  await waitUntil(() => events.some((e) => e[0] === 'start' && e[1] === '1'))
  player.stop()
  assert.deepEqual(events.filter((e) => e[0] === 'stopped'), [['stopped', ['1']]])
  assert.ok(!events.some((e) => e[0] === 'done'), '中止不得触发 onDone')
  await waitUntil(() => track.closed, 2000)
  await sleep(30)
})

test('首句之前抛错:onSourceError(played 为空),onDone 不触发', async () => {
  const events = []
  const player = makePlayer(events)
  // 生成器形状是流式依赖的契约;首句产出前即抛错,故无 yield
  // oxlint-disable-next-line require-yield
  const boom = async function* () {
    throw new Error('首句失败')
  }
  player.playStream(boom(), {
    onSourceError: (e, played) => events.push(['sourceError', String(e?.message), played.length]),
  })
  await waitUntil(() => events.some((e) => e[0] === 'sourceError'))
  assert.deepEqual(events.find((e) => e[0] === 'sourceError'), ['sourceError', '首句失败', 0])
  assert.ok(!events.some((e) => e[0] === 'done'))
})

test('initial 缺省:playStream 自行取第一句', async () => {
  const events = []
  const player = makePlayer(events)
  player.playStream(gen([line('B', '1'), line('A', '2')], { reason: 'x' }), { gap: 10 })
  await waitUntil(() => events.some((e) => e[0] === 'done'))
  assert.deepEqual(events.filter((e) => e[0] === 'start').map((e) => e[1]), ['1', '2'])
})

test('空源:直接 onDone,零台词', async () => {
  const events = []
  const player = makePlayer(events)
  player.playStream(gen([], { natural: false }), { gap: 10 })
  await waitUntil(() => events.some((e) => e[0] === 'done'))
  assert.ok(!events.some((e) => e[0] === 'start'))
})
