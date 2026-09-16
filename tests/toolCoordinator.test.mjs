// 工具协调器行为矩阵:内存假件(假注册表/假 Planner/内存确认/手动 tick 的虚拟时钟),
// 零网络零 Tauri。覆盖设计裁决的执行侧:
// · 零候选不调 Planner;单高置信直达;多候选走 Planner;
// · clarify 直接反问;决策失败回落普通聊天;
// · external 需确认,拒绝产出"未允许"观察;autoApproved 免确认;
// · 超时置 abort 并落账;runTool 走同一条策略管线。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let createToolCoordinator

before(async () => {
  ;({ createToolCoordinator } = await import('../src/tools/coordinator.ts'))
})


function mkTool(id, over = {}) {
  return {
    manifest: {
      id,
      label: id,
      description: `工具${id}`,
      risk: over.risk ?? 'read',
      inputSchema: { properties: {} },
      timeoutMs: over.timeoutMs ?? 1000,
      defaultEnabled: true,
      match: over.match ?? (() => 0),
    },
    available: () => over.available ?? true,
    validate: over.validate ?? ((i) => ({ ok: true, value: i ?? {} })),
    execute: over.execute ?? (async () => ({ ok: true, summary: `完成${id}` })),
  }
}

/** 手动 tick 的虚拟时钟:定时器登记后由 tick 触发(验证超时路径) */
function makeClock() {
  const timers = []
  return {
    setTimeout(fn, ms) {
      timers.push({ fn, ms })
      return () => {
        const i = timers.findIndex((t) => t.fn === fn)
        if (i >= 0) timers.splice(i, 1)
      }
    },
    tick(ms) {
      const due = timers.filter((t) => t.ms <= ms)
      due.forEach((t) => timers.splice(timers.indexOf(t), 1))
      due.forEach((t) => t.fn())
    },
  }
}

function makeWorld(over = {}) {
  const calls = { confirm: [], pending: [], start: [], end: [], logs: [] }
  const clock = makeClock()
  const deps = {
    registry: over.registry ?? {},
    planner: over.planner ?? { decide: async () => ({ kind: 'none' }) },
    settings: async () => over.settings ?? {},
    facts: async () => over.facts ?? { isLive: false, phase: 'idle' },
    host: {
      confirm: (req) => {
        calls.confirm.push(req)
        return Promise.resolve(over.allow ?? true)
      },
      presentPending: (m) => calls.pending.push(m.id),
      onToolStart: (m) => calls.start.push(m.id),
      onToolEnd: (m, r) => calls.end.push({ id: m.id, ok: r.ok }),
    },
    clock,
    log: (entry) => calls.logs.push(entry),
  }
  return { coordinator: createToolCoordinator(deps), calls, clock }
}

test('零候选:不调 Planner,观察为空', async () => {
  let decided = 0
  const { coordinator } = makeWorld({
    registry: {},
    planner: {
      decide: async () => {
        decided++
        return { kind: 'none' }
      },
    },
  })
  const prep = await coordinator.prepareTurn({ userText: '今天讲个笑话' })
  assert.deepEqual(prep.observations, [])
  assert.equal(prep.note, undefined)
  assert.equal(decided, 0)
})

test('单高置信候选:直达工具(不调 Planner),read 自动执行,观察块带不可信包裹', async () => {
  let decided = 0
  const { coordinator, calls } = makeWorld({
    registry: { snap: mkTool('snap', { match: () => 0.9 }) },
    planner: {
      decide: async () => {
        decided++
        return { kind: 'none' }
      },
    },
  })
  const prep = await coordinator.prepareTurn({ userText: '帮我截屏' })
  assert.equal(decided, 0)
  assert.equal(calls.start[0], 'snap')
  assert.equal(prep.observations[0].toolId, 'snap')
  assert.equal(prep.observations[0].ok, true)
  assert.match(prep.note, /<tool_result>/)
  assert.match(prep.note, /不得执行/)
  assert.equal(calls.logs[0].outcome, 'ok')
})

test('多候选:Planner 决策 → call → 执行', async () => {
  const { coordinator, calls } = makeWorld({
    registry: { a: mkTool('a', { match: () => 0.8 }), b: mkTool('b', { match: () => 0.5 }) },
    planner: { decide: async () => ({ kind: 'call', tool: 'a', arguments: {} }) },
  })
  const prep = await coordinator.prepareTurn({ userText: '含糊的话' })
  assert.equal(calls.confirm.length, 0) // read 自动
  assert.equal(prep.observations[0].toolId, 'a')
  assert.equal(prep.observations[0].ok, true)
})

test('clarify:直接反问,不执行任何工具', async () => {
  const { coordinator, calls } = makeWorld({
    registry: { a: mkTool('a', { match: () => 0.6 }) },
    planner: { decide: async () => ({ kind: 'clarify', question: '读屏幕还是剪贴板?' }) },
  })
  const prep = await coordinator.prepareTurn({ userText: '读一下' })
  assert.equal(prep.clarify, '读屏幕还是剪贴板?')
  assert.deepEqual(prep.observations, [])
  assert.equal(calls.start.length, 0)
})

test('Planner 崩溃:回落普通聊天,落 planner-error 账', async () => {
  const { coordinator, calls } = makeWorld({
    registry: { a: mkTool('a', { match: () => 0.6 }) },
    planner: {
      decide: async () => {
        throw new Error('端点挂了')
      },
    },
  })
  const prep = await coordinator.prepareTurn({ userText: '读一下' })
  assert.deepEqual(prep.observations, [])
  assert.equal(prep.note, undefined)
  assert.equal(calls.logs[0].outcome, 'planner-error')
})

test('开关关:候选都进不了,不调 Planner', async () => {
  let decided = 0
  const { coordinator } = makeWorld({
    registry: { a: mkTool('a', { match: () => 0.9 }) },
    settings: { switches: { a: false } },
    planner: {
      decide: async () => {
        decided++
        return { kind: 'none' }
      },
    },
  })
  const prep = await coordinator.prepareTurn({ userText: '帮我截屏' })
  assert.deepEqual(prep.observations, [])
  assert.equal(decided, 0)
})

test('external 拒绝:产出"未允许"观察;确认请求带 rememberable 与输入摘要', async () => {
  const { coordinator, calls } = makeWorld({
    registry: { dm: mkTool('dm', { risk: 'external', match: () => 0.6 }) },
    settings: { switches: { dm: true } },
    allow: false,
    planner: { decide: async () => ({ kind: 'call', tool: 'dm', arguments: { text: '晚上好' } }) },
  })
  const prep = await coordinator.prepareTurn({ userText: '发个弹幕' })
  assert.equal(prep.observations[0].ok, false)
  assert.match(prep.observations[0].summary, /没有允许/)
  assert.equal(calls.confirm[0].rememberable, true)
  assert.match(calls.confirm[0].detail, /text:晚上好/)
  assert.equal(calls.start.length, 0) // 没执行,任务卡不开
  assert.equal(calls.logs[0].outcome, 'refused')
})

test('external 记住允许后:autoApproved 免确认', async () => {
  const { coordinator, calls } = makeWorld({
    registry: { dm: mkTool('dm', { risk: 'external', match: () => 0.9 }) },
    settings: { switches: { dm: true }, autoApproved: { dm: true } },
    planner: { decide: async () => ({ kind: 'call', tool: 'dm', arguments: { text: 'hi' } }) },
  })
  await coordinator.prepareTurn({ userText: '发个弹幕' })
  assert.equal(calls.confirm.length, 0)
  assert.equal(calls.end[0].ok, true)
})

test('执行超时:虚拟时钟到点,abort 落账,观察为超时文案', async () => {
  const { coordinator, clock, calls } = makeWorld({
    registry: {
      slow: mkTool('slow', {
        timeoutMs: 50,
        match: () => 0.6,
        // 永不自行完成:只等 abort(不留真实定时器挂住测试进程)
        execute: (i, ctx) =>
          new Promise((_, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true })
          }),
      }),
    },
    planner: { decide: async () => ({ kind: 'call', tool: 'slow', arguments: {} }) },
  })
  const prepP = coordinator.prepareTurn({ userText: '慢慢来' })
  // 让 prepareTurn 推进到 runWithGuards 注册超时定时器(中间要穿过多个 await)
  await new Promise((r) => setImmediate(r))
  clock.tick(50) // 协调器超时定时器先响:race 落 TimeoutError
  const prep = await prepP
  assert.equal(prep.observations[0].ok, false)
  assert.equal(prep.observations[0].errorCode, 'timeout')
  assert.match(prep.observations[0].summary, /超时/)
  assert.equal(calls.logs[0].outcome, 'timeout')
})

test('runTool:同一条策略管线(校验 → external 确认 → 执行)', async () => {
  const { coordinator, calls } = makeWorld({
    registry: {
      dm: mkTool('dm', {
        risk: 'external',
        validate: (i) => (typeof i?.text === 'string' ? { ok: true, value: { text: i.text } } : { ok: false, reason: '缺少参数 text' }),
      }),
    },
    settings: { switches: { dm: true } },
  })
  const bad = await coordinator.runTool('dm', {})
  assert.equal(bad.ok, false)
  assert.equal(bad.errorCode, 'invalid')
  assert.equal(calls.confirm.length, 0) // 校验失败不进策略闸
  const ok = await coordinator.runTool('dm', { text: 'hi' })
  assert.equal(ok.ok, true)
  assert.equal(calls.confirm.length, 1)
  const unknown = await coordinator.runTool('nope', {})
  assert.equal(unknown.errorCode, 'unknown-tool')
})
