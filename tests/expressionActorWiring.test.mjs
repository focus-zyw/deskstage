// 表达导演 × ActorWorker 接线验收矩阵:开关开→每轮 prompt 注入表达指令(含网页
// 增量轮与恢复重建)/ 开关关→与旧版逐字节一致 / maySpeak=false 不规划不强迫发言 /
// 质量闸恰一次轻修复后提交 / 不可修复问题照常提交且 gateIssues 穿出 / trace 随提交
// meta 送达宿主。假 Adapter + 手动时钟,零网络。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let createRoomJournal
let createRoomRouter
let createActorWorker
let createFakeActorAdapter
let expression

before(async () => {
  ;({ createRoomJournal } = await import('../src/groupChat/roomJournal.ts'))
  ;({ createRoomRouter } = await import('../src/groupChat/roomRouter.ts'))
  ;({ createActorWorker } = await import('../src/groupChat/actorWorker.ts'))
  ;({ createFakeActorAdapter } = await import('../src/groupChat/adapters/fakeActor.ts'))
  ;(expression = await import('../src/expression/index.ts'))
})



// ---------- 测试基建(与 groupChatCore 同款) ----------

function makeClock(start = 1_000_000) {
  let now = start
  const settle = async (n = 8) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
  }
  return {
    now: () => now,
    setTimeout(fn, ms) {
      // happy path 不经定时器;万一触发就立即排空
      void Promise.resolve().then(() => {
        now += ms
        fn()
      })
      return () => undefined
    },
    settle,
  }
}

const allApi = {
  A: { binding: { kind: 'api' }, autonomy: 'natural' },
  B: { binding: { kind: 'api' }, autonomy: 'natural' },
  C: { binding: { kind: 'api' }, autonomy: 'natural' },
}

const identityFor = (actor) => ({
  actor,
  names: { A: '甲', B: '乙', C: '丙' },
  persona: '测试人设文本',
  rosterLine: `乙(speaker "B")`,
  userName: '你',
})

/** 场景 harness:发一条用户消息,worker 消费一轮,捕获请求与提交 meta */
async function runTurn({ text, script, director, extraDeps = {}, actor = 'A', voice = false } = {}) {
  const clock = makeClock()
  const journal = createRoomJournal(clock)
  const committed = []
  const router = createRoomRouter({
    journal,
    clock,
    configs: () => allApi,
    onCommitted: (a, result, meta) => committed.push({ actor: a, result, meta }),
  })
  const adapter = createFakeActorAdapter(script)
  const worker = createActorWorker({
    actor,
    router,
    journal,
    adapter,
    clock,
    identity: () => identityFor(actor),
    ...(director ? { expression: director } : {}),
    ...extraDeps,
  })
  router.appendUser({
    text: text ?? '今天上线又炸了',
    epoch: router.currentEpoch(),
    primaryActor: actor,
    primaryAutonomy: 'natural',
    ...(voice ? { voice: true } : {}),
  })
  worker.wake()
  await clock.settle()
  return { journal, router, adapter, worker, committed, requests: adapter.calls.map((c) => c.req) }
}

test('语音回合(channel=voice)强制走 voiceAdapter,普通回合仍走绑定适配器', async () => {
  // 语音回合:voiceAdapter 被调用,绑定适配器不动
  const voiceSpy = createFakeActorAdapter([{ listen: true }])
  const voiceRun = await runTurn({
    text: '语音说的一句话',
    script: [{ listen: true }],
    extraDeps: { voiceAdapter: () => voiceSpy },
    voice: true,
  })
  assert.equal(voiceSpy.calls.length, 1, '语音回合应走 voiceAdapter')
  assert.equal(voiceRun.adapter.calls.length, 0, '绑定适配器不应被调用')
  // 普通回合:voiceAdapter 不参与
  const voiceSpy2 = createFakeActorAdapter([{ listen: true }])
  const chatRun = await runTurn({
    text: '普通消息',
    script: [{ listen: true }],
    extraDeps: { voiceAdapter: () => voiceSpy2 },
  })
  assert.equal(chatRun.adapter.calls.length, 1, '普通回合走绑定适配器')
  assert.equal(voiceSpy2.calls.length, 0, 'voiceAdapter 不应参与普通回合')
})

const spyOf = (director, calls) => ({
  plan: (input) => {
    calls.push(input)
    return director.plan(input)
  },
  noteSpoken: (entry) => director.noteSpoken(entry),
  learn: async (x) => director.learn(x),
  recentTraces: (actor) => director.recentTraces(actor),
})

// ---------- 用例 ----------

test('开关开:prompt 注入本轮表达策略(两种形态一致),trace 随提交 meta 穿出', async () => {
  const director = expression.createExpressionDirector({ rng: () => 0, prefs: null })
  const { requests, committed } = await runTurn({
    director: () => director,
    script: [{ speak: '来了来了' }],
  })
  assert.equal(requests.length, 1)
  assert.ok(requests[0].prompt.includes('本轮表达策略(执行即可,不得复述):'))
  assert.ok(requests[0].messages[0].content.includes('本轮表达策略'))
  assert.ok(requests[0].prompt.includes('输出协议'))
  // 提交成功:trace 必达(meta.expression),健康文本无 gateIssues
  assert.equal(committed.length, 1)
  assert.equal(committed[0].result.outcome, 'committed-speak')
  assert.ok(committed[0].meta.expression)
  assert.equal(committed[0].meta.expression.actor, 'A')
  assert.ok(committed[0].meta.expression.id)
  assert.deepEqual(committed[0].meta.gateIssues, [])
})

test('开关关:prompt 与完全未注入导演的旧版行为逐字节一致', async () => {
  const off = await runTurn({ director: () => undefined, script: [{ speak: '来了来了' }] })
  const none = await runTurn({ script: [{ speak: '来了来了' }] })
  assert.equal(off.requests.length, 1)
  assert.equal(none.requests.length, 1)
  assert.ok(!off.requests[0].prompt.includes('本轮表达策略'))
  assert.equal(off.requests[0].prompt, none.requests[0].prompt)
  assert.equal(off.committed[0].meta?.expression, undefined)
})

test('maySpeak=false(预算耗尽):不规划、不注入,不强迫角色发言', async () => {
  const calls = []
  const director = expression.createExpressionDirector({ rng: () => 0, prefs: null })
  const clock = makeClock()
  const journal = createRoomJournal(clock)
  const committed = []
  const router = createRoomRouter({
    journal,
    clock,
    configs: () => allApi,
    onCommitted: (a, result, meta) => committed.push({ result, meta }),
  })
  const adapter = createFakeActorAdapter([{ listen: true }])
  const worker = createActorWorker({
    actor: 'A',
    router,
    journal,
    adapter,
    clock,
    identity: () => identityFor('A'),
    expression: () => spyOf(director, calls),
  })
  const { chain } = router.appendUser({
    text: '今天炸了',
    epoch: router.currentEpoch(),
    primaryActor: 'A',
    primaryAutonomy: 'natural',
  })
  chain.remainingPublicReplies = 0 // 预算耗尽 → maySpeak hint = false
  worker.wake()
  await clock.settle()
  assert.equal(adapter.calls.length, 1)
  assert.ok(!adapter.calls[0].req.prompt.includes('本轮表达策略'))
  assert.equal(calls.length, 0, 'maySpeak=false 不得进入导演规划')
  assert.equal(committed[0].result.outcome, 'committed-listen')
  assert.equal(committed[0].meta?.expression, undefined)
})

test('maySpeak=true 对照:导演被调用,limits 携带协议上限 80', async () => {
  const calls = []
  const director = expression.createExpressionDirector({ rng: () => 0, prefs: null })
  await runTurn({ director: () => spyOf(director, calls), script: [{ speak: '来了来了' }] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].limits.maySpeak, true)
  assert.equal(calls[0].limits.maxChars, 80)
  assert.equal(calls[0].channel, 'group-chat')
})

test('质量闸:超长文本按计划截长后才提交,截后无问题', async () => {
  // rng=0 → A(mixed 档)取 micro,maxChars=12
  const director = expression.createExpressionDirector({ rng: () => 0, prefs: null })
  const longText = '这句话远远超过了micro档位十二个字的长度限制必须被截断才行啊'
  const { journal, committed } = await runTurn({
    director: () => director,
    script: [{ speak: longText }],
  })
  const reply = journal.list().at(-1)
  assert.equal(committed[0].result.outcome, 'committed-speak')
  assert.ok(reply.text.length <= 12, `修复后长度 ${reply.text.length} 应 ≤ 12`)
  assert.deepEqual(committed[0].meta.gateIssues, [], '截长后超长问题消除')
  assert.notEqual(reply.text, longText)
})

test('质量闸:不可修复的重复照常提交(不阻断),gateIssues 穿出,router 重复判定降级 listen', async () => {
  const director = expression.createExpressionDirector({ rng: () => 0, prefs: null })
  const clock = makeClock()
  const journal = createRoomJournal(clock)
  const committed = []
  const router = createRoomRouter({
    journal,
    clock,
    configs: () => allApi,
    onCommitted: (a, result, meta) => committed.push({ result, meta }),
  })
  const adapter = createFakeActorAdapter([{ speak: '今晚又是炸服的一天' }, { speak: '今晚又是炸服的一天' }])
  const worker = createActorWorker({
    actor: 'A',
    router,
    journal,
    adapter,
    clock,
    identity: () => identityFor('A'),
    expression: () => director,
  })
  router.appendUser({ text: '今天炸服了', epoch: router.currentEpoch(), primaryActor: 'A', primaryAutonomy: 'natural' })
  worker.wake()
  await clock.settle()
  assert.equal(committed.length, 1)
  assert.equal(committed[0].result.outcome, 'committed-speak')
  // 第二轮说同样的话:质量闸记 repetition(不可修),router 重复判定降级 listen
  router.appendUser({ text: '再说一遍试试', epoch: router.currentEpoch(), primaryActor: 'A', primaryAutonomy: 'natural' })
  worker.wake()
  await clock.settle()
  assert.equal(committed.length, 2)
  assert.equal(committed[1].result.outcome, 'committed-listen', 'router 重复判定降级')
  assert.deepEqual(committed[1].meta.gateIssues, ['repetition'])
})

test('网页增量轮(prefersFullContext=false)与恢复重建同样携带表达指令', async () => {
  const director = expression.createExpressionDirector({ rng: () => 0, prefs: null })
  const clock = makeClock()
  const journal = createRoomJournal(clock)
  const router = createRoomRouter({ journal, clock, configs: () => allApi })
  const adapter = createFakeActorAdapter([{ speak: '来了来了' }])
  adapter.prefersFullContext = () => false
  const worker = createActorWorker({
    actor: 'A',
    router,
    journal,
    adapter,
    clock,
    identity: () => identityFor('A'),
    expression: () => director,
  })
  router.appendUser({ text: '今天炸了', epoch: router.currentEpoch(), primaryActor: 'A', primaryAutonomy: 'natural' })
  worker.wake()
  await clock.settle()
  const req = adapter.calls[0].req
  assert.equal(req.fullContext, false)
  assert.ok(req.prompt.includes('本轮表达策略'))
  const rebuilt = req.rebuildPrompt({ fullContext: true, recovery: true })
  assert.ok(rebuilt.prompt.includes('本轮表达策略'))
  assert.ok(rebuilt.prompt.includes('刚才连接断了一下'))
})

test('extras 里的旧梗候选/personaText 进入导演输入', async () => {
  const seen = []
  const director = expression.createExpressionDirector({ rng: () => 0, prefs: null })
  await runTurn({
    director: () => spyOf(director, seen),
    script: [{ speak: '来了来了' }],
    extraDeps: {
      prepareExtras: async () => ({ gags: [{ id: 'g1', text: '半夜上线炸了那次' }], diagTurnId: 't1' }),
    },
  })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].context.gags, [{ id: 'g1', text: '半夜上线炸了那次' }])
  assert.equal(seen[0].personaText, '测试人设文本')
  assert.equal(seen[0].channel, 'group-chat')
})
