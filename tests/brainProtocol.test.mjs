// 影子大脑协议与挂点回归(docs/影子大脑桥接设计方案.md):
// · VAD 连续情绪空间:参考方案给的三例标签 + 全词表到立绘动作的映射 + moodState 投影;
// · BrainDecision 清洗:结构/枚举/空台词拒绝,字段钳制,requestId 透传;
// · 现场快照聚合:窗口标题脱敏闸、事实与台词截断、时序空值语义;
// · 影子存档(非 Tauri 内存降级):追加/读尾/计数/清空;
// · 调度器 observe:本地评估理由显式化(闸门/掷点/生成侧拒绝/接管 listen)。
// Rust 桥的回环行为在 src-tauri/src/bridge.rs 的 #[cfg(test)] 里,不在本文件。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

let vad
let types
let snapshot
let shadowStore
let bridgeLink
let scheduler
let runtimeMode

before(async () => {
  // localStorage 内存桩:configStore/interactionStore 在非 Tauri 环境降级读写
  const values = new Map()
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
  vad = await import('../src/brain/vad.ts')
  types = await import('../src/brain/types.ts')
  snapshot = await import('../src/brain/snapshot.ts')
  shadowStore = await import('../src/brain/shadowStore.ts')
  bridgeLink = await import('../src/brain/bridgeLink.ts')
  scheduler = await import('../src/runtime/proactiveScheduler.ts')
  runtimeMode = await import('../src/runtime/runtimeMode.ts')
})

after(async () => {
  delete globalThis.localStorage
})

// ---------- VAD ----------

test('VAD 钳位:越界收边、非数归零', () => {
  assert.deepEqual(vad.clampVad({ v: 2, a: -3, d: 0.5 }), { v: 1, a: -1, d: 0.5 })
  assert.deepEqual(vad.clampVad({ v: Number.NaN, a: 0.2, d: 1.9 }), { v: 0, a: 0.2, d: 1 })
})

test('VAD → 标签:参考方案三例与全分支', () => {
  // 参考方案原例
  assert.equal(vad.vadToLabel({ v: 0.72, a: 0.68, d: 0.55 }), 'cheerful')
  assert.equal(vad.vadToLabel({ v: -0.55, a: 0.75, d: 0.62 }), 'annoyed')
  assert.equal(vad.vadToLabel({ v: -0.45, a: 0.18, d: 0.3 }), 'gloomy')
  // 其余分支
  assert.equal(vad.vadToLabel({ v: 0.5, a: 0, d: 0 }), 'content')
  assert.equal(vad.vadToLabel({ v: -0.5, a: 0.7, d: 0 }), 'anxious')
  assert.equal(vad.vadToLabel({ v: 0, a: 0.8, d: 0 }), 'restless')
  assert.equal(vad.vadToLabel({ v: 0, a: -0.8, d: 0 }), 'sleepy')
  assert.equal(vad.vadToLabel({ v: 0, a: 0, d: 0 }), 'calm')
})

test('VAD → 立绘动作:全标签都在既有词表内', () => {
  assert.equal(vad.vadToAction({ v: 0.8, a: 0.8, d: 0 }), 'laugh')
  assert.equal(vad.vadToAction({ v: 0.8, a: 0, d: 0 }), 'happy')
  assert.equal(vad.vadToAction({ v: -0.8, a: 0.8, d: 0.9 }), 'angry')
  assert.equal(vad.vadToAction({ v: -0.8, a: 0.8, d: 0 }), 'shy')
  assert.equal(vad.vadToAction({ v: -0.8, a: 0, d: 0 }), 'sad')
  assert.equal(vad.vadToAction({ v: 0, a: 0.9, d: 0 }), 'jump')
  assert.equal(vad.vadToAction({ v: 0, a: -0.9, d: 0 }), 'sleepy')
  assert.equal(vad.vadToAction({ v: 0, a: 0, d: 0 }), 'idle')
})

test('moodState → VAD 单向投影:v/valence、a/energy 归一,d 暂记 0', () => {
  assert.deepEqual(
    vad.moodToVad({ valence: 3, energy: 5, updatedAt: 0 }),
    { v: 1, a: 1, d: 0 },
  )
  assert.deepEqual(
    vad.moodToVad({ valence: -3, energy: 0, updatedAt: 0 }),
    { v: -1, a: -1, d: 0 },
  )
  const mid = vad.moodToVad({ valence: 1.5, energy: 2.5, updatedAt: 0 })
  assert.equal(mid.v, 0.5)
  assert.equal(mid.a, 0)
  assert.equal(mid.d, 0)
})

// ---------- BrainDecision 清洗 ----------

test('决策清洗:结构/枚举/空台词拒绝', () => {
  assert.equal(types.sanitizeBrainDecision(null).ok, false)
  assert.equal(types.sanitizeBrainDecision('speak').ok, false)
  assert.equal(types.sanitizeBrainDecision({ decision: 'speak' }).ok, false) // 缺 inputId
  assert.equal(
    types.sanitizeBrainDecision({ inputId: 'brin_1', decision: 'maybe' }).error,
    'bad-decision',
  )
  assert.equal(
    types.sanitizeBrainDecision({ inputId: 'brin_1', decision: 'speak' }).error,
    'empty-lines',
  )
  const listen = types.sanitizeBrainDecision({ inputId: 'brin_1', decision: 'listen' })
  assert.equal(listen.ok, true)
  assert.deepEqual(listen.decision.lines, [])
})

test('决策清洗:台词逐条钳制,坏行丢弃,字段封顶', () => {
  const result = types.sanitizeBrainDecision({
    inputId: 'brin_x',
    decision: 'speak',
    requestId: 'breq_1',
    reason: Array.from({ length: 10 }, (_, i) => `理由${i}${'长'.repeat(100)}`),
    memoryUsed: Array.from({ length: 9 }, () => 'm'.repeat(50)),
    expression: { vad: { v: 5, a: 0.68, d: -9 }, label: '  cheerful ' },
    lines: [
      { speaker: 'A', text: '你好'.repeat(200), action: 'dance' }, // 动作词表外 → talk;超长截断
      { speaker: 'D', text: '坏人', action: 'idle' }, // 词表外说话者 → 丢
      { speaker: 'B', text: '   ', action: 'idle' }, // 空台词 → 丢
      { speaker: 'C', text: '小管家在场', action: 'surprise' },
    ],
  })
  assert.equal(result.ok, true)
  const d = result.decision
  assert.equal(d.decision, 'speak')
  assert.equal(d.requestId, 'breq_1')
  assert.equal(d.reason.length, 6) // 封顶 6 条
  assert.ok(d.reason[0].length <= 80)
  assert.equal(d.memoryUsed.length, 6)
  assert.ok(d.memoryUsed[0].length <= 40)
  assert.deepEqual(d.expression.vad, { v: 1, a: 0.68, d: -1 })
  assert.equal(d.expression.label, 'cheerful')
  assert.equal(d.lines.length, 2) // 两条合法台词
  assert.equal(d.lines[0].action, 'talk') // 词表外动作归一
  assert.ok(d.lines[0].text.length <= 200)
  assert.equal(d.lines[1].action, 'surprise')
})

// ---------- 现场快照聚合 ----------

function sampleSource(overrides = {}) {
  return {
    world: null,
    evaluation: {
      blocked: null,
      candidate: 'spontaneous',
      fired: false,
      decline: 'chance',
      idleForMs: 152_000,
      quotaUsed: 2,
      reasons: ['掷点未中'],
    },
    quotaCap: 6,
    timing: { lastSpontAttempt: 0, lastSpontSuccess: 0 },
    moods: {
      A: { valence: 3, energy: 5, updatedAt: 1_758_100_000_000 }, // updatedAt = now:不触发惰性衰减
      B: { valence: 0, energy: 2.5, updatedAt: 1_758_100_000_000 },
      C: { valence: -1.5, energy: 1, updatedAt: 1_758_100_000_000, cause: '被戳烦了' },
    },
    promptFacts: ['用户在写 Rust 桌宠', '短'.repeat(100)],
    lastTurns: [
      { who: 'user', text: '在吗' },
      { who: 'A', text: '在的呀'.padEnd(90, '长') },
    ],
    interactions: {
      pokeA: 1, pokeB: 2, pokeC: 3, interrupts: 4, sinceInject: 0,
      dismissSpontaneous: 2, dismissReplay: 0, dismissBreak: 1,
    },
    includeWindowTitle: false,
    now: 1_758_100_000_000,
    ...overrides,
  }
}

test('快照聚合:脱敏闸、截断与空值语义', () => {
  const input = snapshot.buildBrainInput(sampleSource())
  assert.ok(input.inputId.startsWith('brin_'))
  assert.equal(input.ts, 1_758_100_000_000)
  // 世界缺失 → 全空现场,不炸
  assert.equal(input.world.foreground, null)
  assert.equal(input.world.idleMinutes, 0)
  // 脱敏闸:没开窗口标题采集就不带
  assert.equal(input.world.activeWindowTitle, null)
  // 时序:没发生过自发 → null 而不是负数
  assert.equal(input.tick.sinceLastSpontMs, null)
  assert.equal(input.tick.quotaUsed, 2)
  assert.equal(input.tick.quotaCap, 6)
  // 事实与台词截断
  assert.equal(input.memory.promptFacts.length, 2)
  assert.ok(input.memory.promptFacts[1].length <= 60)
  assert.equal(input.recent.lastLines[0], 'user:在吗')
  assert.ok(input.recent.lastLines[1].length <= 1 + 1 + 80)
  // 心情投影 + 原因透传
  assert.deepEqual(input.mood.A.vad, { v: 1, a: 1, d: 0 })
  assert.equal(input.mood.C.cause, '被戳烦了')
  // 互动账本聚合
  assert.equal(input.interactions.pokes, 6)
  assert.equal(input.interactions.dismissSpontaneous, 2)
  // 本地评估原样进快照(配对的锚)
  assert.equal(input.local.decline, 'chance')
})

test('快照聚合:开窗口标题采集后携带标题;两次构建 id 不重复', () => {
  const world = { foreground: 'editor', processName: 'zcode.exe', activeWindowTitle: 'bridge.rs - 编码中', fullscreenApp: false, idleMinutes: 3, audioPlaying: false, mediaName: null, cpuPercent: 12, memPercent: 50, batteryPercent: 88, charging: false }
  const a = snapshot.buildBrainInput(sampleSource({ world, includeWindowTitle: true }))
  const b = snapshot.buildBrainInput(sampleSource({ world, includeWindowTitle: true }))
  assert.equal(a.world.activeWindowTitle, 'bridge.rs - 编码中')
  assert.equal(a.world.processName, 'zcode.exe')
  assert.notEqual(a.inputId, b.inputId)
  // 没开采集:同样的 world,标题不出
  const c = snapshot.buildBrainInput(sampleSource({ world }))
  assert.equal(c.world.activeWindowTitle, null)
})

// ---------- 影子存档(内存降级) ----------

test('影子存档:追加/读尾/计数/清空(非 Tauri 内存降级)', async () => {
  await shadowStore.clearShadowArchive()
  for (let i = 0; i < 3; i++) {
    await shadowStore.appendShadowRecord('decisions', { seq: i })
  }
  await shadowStore.appendShadowRecord('inputs', { seq: 'a' })
  const tail = await shadowStore.readShadowRecords('decisions', 2)
  assert.deepEqual(tail, [{ seq: 1 }, { seq: 2 }])
  const counts = await shadowStore.countShadowRecords()
  assert.deepEqual(counts, { inputs: 1, decisions: 3 })
  await shadowStore.clearShadowArchive()
  assert.deepEqual(await shadowStore.countShadowRecords(), { inputs: 0, decisions: 0 })
})

// ---------- 调度器 observe(理由显式化) ----------

/** 时钟推进后的微任务排空:tick 内有 getConfig/账本等多级 await */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function baseDeps(evals, overrides = {}) {
  return {
    sweepMemos: async () => {},
    breakRemind: async () => true,
    autoReplay: async () => false,
    spontaneous: async () => false,
    observe: (e) => evals.push(e),
    ...overrides,
  }
}

/** 逐 tick 推进并排空:一次 tick(200s)会同步连发全部 interval 回调,
 *  多个 tick 并发交错会在 lastSpontAttempt 赋值前都通过 due 检查——
 *  真实运行是 15s 一拍、拍与拍之间有等待,这里按同构方式推进 */
async function advance(t, ms) {
  const steps = Math.floor(ms / 15_000)
  for (let i = 0; i < steps; i++) {
    t.mock.timers.tick(15_000)
    await flush()
  }
}

test('调度器 observe:闸门被挡时空闲计时停摆并回报 gate', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  t.mock.timers.setTime(new Date('2026-06-01T12:00:00').getTime())
  const evals = []
  const stop = scheduler.startScheduler(baseDeps(evals))
  t.after(() => stop())
  runtimeMode.setDnd(true)
  t.mock.timers.tick(15_000)
  await flush()
  const last = evals[evals.length - 1]
  assert.equal(last.blocked, 'gate')
  assert.equal(last.idleForMs, 0)
  runtimeMode.setDnd(false)
  stop()
})

test('调度器 observe:掷点未中要有候选与理由(不说话也能说清为什么)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  t.mock.timers.setTime(new Date('2026-06-01T12:00:00').getTime())
  const random = t.mock.method(Math, 'random', () => 0.99) // 恒不中(SPONT_CHANCE=0.4)
  const evals = []
  const stop = scheduler.startScheduler(baseDeps(evals))
  t.after(() => stop())
  await advance(t, 210_000) // 跨过自发空闲阈值(150s)
  const last = evals[evals.length - 1]
  assert.equal(last.blocked, null)
  assert.equal(last.candidate, 'spontaneous')
  assert.equal(last.fired, false)
  assert.equal(last.decline, 'chance')
  assert.ok(last.idleForMs >= 150_000)
  assert.ok(last.reasons.some((r) => r.includes('掷点未中')))
  assert.equal(random.mock.calls.length > 0, true)
  stop()
})

test('调度器 observe:生成侧拒绝与真实播出分开记账', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  t.mock.timers.setTime(new Date('2026-06-01T12:00:00').getTime())
  t.mock.method(Math, 'random', () => 0.01) // 恒通过掷点
  let spontCalls = 0
  let spontResult = false
  const evals = []
  const stop = scheduler.startScheduler(
    baseDeps(evals, {
      spontaneous: async () => {
        spontCalls += 1
        return spontResult
      },
    }),
  )
  t.after(() => stop())
  t.mock.timers.tick(15_000)
  await flush()
  assert.equal(spontCalls, 0, '空闲未够时不会尝试')

  await advance(t, 195_000)
  // 掷点通过的那一拍之后还有冷却拍,别用队尾断言
  const declinedEval = evals.find((e) => e.decline === 'producers-declined')
  assert.ok(declinedEval, '生成侧拒绝要有评估')
  assert.equal(spontCalls, 1)
  assert.equal(declinedEval.fired, false)

  // 冷却过后再来一次,这次真的播了
  spontResult = true
  await advance(t, 195_000) // 跨过自发尝试间隔(150s)
  const firedEval = evals.find((e) => e.fired && e.candidate === 'spontaneous')
  assert.ok(firedEval, '真实播出要有 fired 评估')
  assert.equal(spontCalls, 2)
  assert.equal(firedEval.decline, null)
  assert.equal(firedEval.quotaUsed, 1) // 配额入账
})

test('调度器 consult:外部大脑裁决 listen 时不播且记录在案', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  t.mock.timers.setTime(new Date('2026-06-01T12:00:00').getTime())
  t.mock.method(Math, 'random', () => 0.01)
  let spontCalls = 0
  let consultCalls = 0
  const evals = []
  const stop = scheduler.startScheduler(
    baseDeps(evals, {
      spontaneous: async () => {
        spontCalls += 1
        return true
      },
      consult: async (candidate) => {
        consultCalls += 1
        assert.equal(candidate, 'spontaneous')
        return 'listen'
      },
    }),
  )
  t.after(() => stop())
  t.mock.timers.tick(15_000)
  await flush()
  assert.equal(consultCalls, 0, '空闲未够不会咨询外部大脑')
  await advance(t, 1_200_000)
  const listenEval = evals.find((e) => e.decline === 'takeover-listen')
  assert.ok(listenEval, '外部裁决 listen 要记录在案')
  assert.ok(consultCalls >= 1, '每个可尝试的 tick 都先问外部大脑')
  assert.equal(spontCalls, 0, '外部说别说话,就不播')
  assert.equal(
    evals.some((e) => e.fired),
    false,
    'listen 期间绝无播出',
  )
  stop()
})

test('桥未运行时 consult 直接回落本地,observe 是无害空操作', async () => {
  assert.equal(await bridgeLink.consultBrain('spontaneous'), null)
  assert.doesNotThrow(() =>
    bridgeLink.observeEvaluation({
      blocked: null, candidate: 'none', fired: false, decline: null,
      idleForMs: 0, quotaUsed: 0, reasons: [],
    }),
  )
})
