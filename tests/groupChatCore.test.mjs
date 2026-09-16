// GroupChat 纯状态模型行为矩阵(P0 验收):假 Adapter + 注入手动时钟,零网络。
// 覆盖:批次连续前缀与上限 / 合并等待与用户抢占 / ACK 校验拒删队列(I2) /
// listen 也 ACK / 旧 epoch 迟到回复降级(I6)/ 重复回复按 listen / 预算并发争抢
// 只成功一条(I4)/ awaiting-user 不发言(clarify 语义)/ 停止与恢复 / 用户抢占 /
// 重启游标对齐绝不重答(I5)/ disabled 游标跟尾 / presentationHold 阻塞静止 /
// 调用限流统计所有 invocation / 快照 busy 语义。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let createRoomJournal
let createRoomRouter
let createGroupChatRuntime
let createFakeActorAdapter
let autonomyPolicy

before(async () => {
  ;({ createRoomJournal } = await import('../src/groupChat/roomJournal.ts'))
  ;({ createRoomRouter } = await import('../src/groupChat/roomRouter.ts'))
  ;({ createGroupChatRuntime } = await import('../src/groupChat/runtime.ts'))
  ;({ createFakeActorAdapter } = await import('../src/groupChat/adapters/fakeActor.ts'))
  ;(autonomyPolicy = await import('../src/groupChat/autonomyPolicy.ts'))
})



// ---------- 测试基建 ----------

/** 手动手钟:advance 按到期顺序触发定时器(每步后让异步链排空) */
function makeClock(start = 1_000_000) {
  let now = start
  const jobs = new Set()
  const settle = async (n = 6) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
  }
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const job = { at: now + ms, fn }
      jobs.add(job)
      return () => jobs.delete(job)
    },
    async advance(ms) {
      const target = now + ms
      for (;;) {
        await settle(4) // 先排空微任务:让在飞循环把下一批定时器排上,再判定到期
        const due = [...jobs].filter((j) => j.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        jobs.delete(due)
        now = Math.max(now, due.at)
        due.fn()
      }
      now = target
      await settle()
    },
    settle,
  }
}

const allApi = {
  A: { binding: { kind: 'api' }, autonomy: 'natural' },
  B: { binding: { kind: 'api' }, autonomy: 'natural' },
  C: { binding: { kind: 'api' }, autonomy: 'natural' },
}

function makeRouter(clock, configs = allApi) {
  const journal = createRoomJournal(clock)
  const router = createRoomRouter({ journal, clock, configs: () => configs })
  router.alignCursorsToTail()
  return { journal, router }
}

function userSay(router, text, over = {}) {
  return router.appendUser({
    text,
    epoch: router.currentEpoch(),
    primaryActor: 'A',
    primaryAutonomy: 'natural',
    ...over,
  })
}

function makeRuntime(adapters, over = {}) {
  const onCommitCalls = []
  const clock = over.clock ?? makeClock()
  const rt = createGroupChatRuntime({
    clock,
    config: () => ({
      names: { A: '甲', B: '乙', C: '丙' },
      userName: '你',
      personaOf: () => '测试人设',
      actors: over.actors ?? allApi,
    }),
    adapters,
    onCommit: (msg, meta) => onCommitCalls.push({ msg, meta }),
  })
  return { rt, onCommitCalls, clock }
}

// ---------- Router 纯逻辑 ----------

test('批次 = 未读 FIFO 的连续前缀,受条数上限约束;primary 取批内最后一条用户消息', () => {
  const clock = makeClock()
  const { router } = makeRouter(clock)
  for (let i = 1; i <= 15; i++) userSay(router, `消息${i}`)
  const info = router.nextBatchInfo('A', clock.now())
  assert.equal(info.status, 'ready')
  assert.equal(info.batch.messages.length, autonomyPolicy.BATCH_MAX_MESSAGES)
  assert.equal(info.batch.fromSeq, 1)
  assert.equal(info.batch.throughSeq, 12)
  assert.equal(info.batch.primaryUserMessageId, 'm12')
})

test('语音来源的用户消息:含它的批次 channel=voice;普通消息无通道标记', () => {
  const clock = makeClock()
  const { router } = makeRouter(clock)
  userSay(router, '普通文字消息')
  const info = router.nextBatchInfo('A', clock.now())
  assert.equal(info.status, 'ready')
  assert.equal(info.batch.channel, undefined)

  const clock2 = makeClock()
  const { router: router2 } = makeRouter(clock2)
  userSay(router2, '语音说的一句话', { voice: true })
  const info2 = router2.nextBatchInfo('A', clock2.now())
  assert.equal(info2.status, 'ready')
  assert.equal(info2.batch.channel, 'voice')
})

test('批次受字符上限约束,但不跳过中间消息', () => {
  const clock = makeClock()
  const { router } = makeRouter(clock)
  for (let i = 1; i <= 5; i++) userSay(router, '很'.repeat(2000))
  const info = router.nextBatchInfo('B', clock.now())
  assert.equal(info.status, 'ready')
  assert.equal(info.batch.messages.length, 2)
  assert.equal(info.batch.messages[0].text.length + info.batch.messages[1].text.length <= autonomyPolicy.BATCH_MAX_CHARS, true)
})

test('合并等待:角色消息刚到返回 wait,窗后 ready;用户消息立即抢占', async () => {
  const clock = makeClock()
  const { journal, router } = makeRouter(clock)
  journal.append({ author: 'B', kind: 'chat', text: '乙随口一句', epoch: 0, causalRootId: 'm0', depth: 0 })
  let info = router.nextBatchInfo('A', clock.now())
  assert.equal(info.status, 'wait')
  await clock.advance(autonomyPolicy.MERGE_WAIT_MS + 1)
  info = router.nextBatchInfo('A', clock.now())
  assert.equal(info.status, 'ready')
  // 用户消息:跳过等待立即 ready
  journal.append({ author: 'B', kind: 'chat', text: '又一句', epoch: 0, causalRootId: 'm0', depth: 0 })
  userSay(router, '用户插话')
  info = router.nextBatchInfo('A', clock.now())
  assert.equal(info.status, 'ready')
  assert.equal(info.batch.primaryUserMessageId, 'm3')
})

test('ACK 校验:batchId/ackThrough/空文本/越批 replyTo 任一非法 = invalid 且游标不动(I2)', async () => {
  const clock = makeClock()
  const { router } = makeRouter(clock)
  userSay(router, '问题')
  const batch = router.nextBatchInfo('A', clock.now()).batch
  const base = { protocolVersion: 1, decision: 'listen' }

  let res = await router.commitActorResult('A', batch, { ...base, batchId: 'A-0-0', ackThrough: batch.throughSeq })
  assert.equal(res.outcome, 'invalid')
  res = await router.commitActorResult('A', batch, { ...base, batchId: batch.id, ackThrough: batch.throughSeq + 3 })
  assert.equal(res.outcome, 'invalid')
  res = await router.commitActorResult('A', batch, {
    protocolVersion: 1, batchId: batch.id, ackThrough: batch.throughSeq, decision: 'speak',
    reply: { text: '', replyTo: [], action: 'talk' },
  })
  assert.equal(res.outcome, 'invalid')
  res = await router.commitActorResult('A', batch, {
    protocolVersion: 1, batchId: batch.id, ackThrough: batch.throughSeq, decision: 'speak',
    reply: { text: '回答', replyTo: ['m99'], action: 'talk' },
  })
  assert.equal(res.outcome, 'invalid')
  assert.equal(router.cursors('A').ackedThrough, 0)

  // listen 也必须 ACK:合法 listen 推进游标(FIFO 只进不退)
  res = await router.commitActorResult('A', batch, { ...base, batchId: batch.id, ackThrough: batch.throughSeq })
  assert.equal(res.outcome, 'committed-listen')
  assert.equal(router.cursors('A').ackedThrough, batch.throughSeq)
})

test('旧 epoch 迟到回复降级 listen + stale(I6):不产生公开消息但游标推进', async () => {
  const clock = makeClock()
  const { journal, router } = makeRouter(clock)
  userSay(router, '旧话题')
  const batch = router.nextBatchInfo('B', clock.now()).batch
  router.bumpEpoch()
  const res = await router.commitActorResult('B', batch, {
    protocolVersion: 1, batchId: batch.id, ackThrough: batch.throughSeq, decision: 'speak',
    reply: { text: '迟到的回答', replyTo: [batch.messages[0].id], action: 'talk' },
  })
  assert.equal(res.outcome, 'committed-listen')
  assert.equal(res.stale, true)
  assert.equal(res.reply, undefined)
  assert.equal(router.cursors('B').ackedThrough, batch.throughSeq)
  const authors = journal.list().map((m) => m.author)
  assert.equal(authors.includes('B'), false)
})

test('重复回复按 listen 提交:不烧调用、不刷屏', async () => {
  const clock = makeClock()
  const { router } = makeRouter(clock)
  const speak = (text) => ({
    protocolVersion: 1, decision: 'speak',
    reply: { text, replyTo: [], action: 'talk' },
  })
  userSay(router, '话题一')
  let batch = router.nextBatchInfo('A', clock.now()).batch
  let res = await router.commitActorResult('A', batch, { ...speak('好家伙'), batchId: batch.id, ackThrough: batch.throughSeq })
  assert.equal(res.outcome, 'committed-speak')
  userSay(router, '话题二')
  batch = router.nextBatchInfo('A', clock.now()).batch
  res = await router.commitActorResult('A', batch, { ...speak('好,家伙'), batchId: batch.id, ackThrough: batch.throughSeq })
  // 归一化去标点后与上一条相同 → 降级 listen
  assert.equal(res.outcome, 'committed-listen')
})

test('并发争抢最后一点预算:互斥区内只成功一条公开回复(I4)', async () => {
  const clock = makeClock()
  const { journal, router } = makeRouter(clock)
  userSay(router, '难得的话题', { primaryAutonomy: 'quiet' })
  const chain = router.activeChain()
  chain.remainingPublicReplies = 1
  const batches = {}
  for (const id of ['A', 'B', 'C']) {
    batches[id] = router.nextBatchInfo(id, clock.now()).batch
  }
  const speakOn = (id, text) => router.commitActorResult(id, batches[id], {
    protocolVersion: 1, batchId: batches[id].id, ackThrough: batches[id].throughSeq, decision: 'speak',
    reply: { text, replyTo: [batches[id].messages[0].id], action: 'talk' },
  })
  const results = await Promise.all([speakOn('A', '甲抢先'), speakOn('B', '乙跟帖'), speakOn('C', '丙补刀')])
  const speaks = results.filter((r) => r.outcome === 'committed-speak')
  assert.equal(speaks.length, 1)
  const replies = journal.list().filter((m) => m.author !== 'user')
  assert.equal(replies.length, 1)
  // roomSeq 唯一且严格递增
  const seqs = journal.list().map((m) => m.roomSeq)
  assert.deepEqual(seqs, [1, 2])
  // 输家也 ACK(游标推进,队列不堆积)
  for (const id of ['A', 'B', 'C']) {
    assert.equal(router.cursors(id).ackedThrough, batches[id].throughSeq)
  }
})

test('awaiting-user(clarify 语义):链挂起后 speak 一律降级 listen', async () => {
  const clock = makeClock()
  const { journal, router } = makeRouter(clock)
  const { chain } = userSay(router, '你是做什么工作的?')
  router.markAwaitingUser(chain.rootMessageId)
  const batch = router.nextBatchInfo('A', clock.now()).batch
  const res = await router.commitActorResult('A', batch, {
    protocolVersion: 1, batchId: batch.id, ackThrough: batch.throughSeq, decision: 'speak',
    reply: { text: '便利店店员', replyTo: [batch.messages[0].id], action: 'talk' },
  })
  assert.equal(res.outcome, 'committed-listen')
  assert.equal(journal.list().filter((m) => m.author === 'A').length, 0)
})

test('停止态:在飞 speak 收尾按 listen,不再产生公开回复', async () => {
  const clock = makeClock()
  const { journal, router } = makeRouter(clock)
  userSay(router, '聊着')
  const batch = router.nextBatchInfo('A', clock.now()).batch
  router.pause()
  const res = await router.commitActorResult('A', batch, {
    protocolVersion: 1, batchId: batch.id, ackThrough: batch.throughSeq, decision: 'speak',
    reply: { text: '还想说', replyTo: [], action: 'talk' },
  })
  assert.equal(res.outcome, 'committed-listen')
  assert.equal(journal.list().filter((m) => m.author === 'A').length, 0)
})

test('catch-up 摘要:超阈值积压折叠,用户消息原文进摘要、游标显式推过历史(I7)', () => {
  const clock = makeClock()
  const { journal, router } = makeRouter(clock)
  router.alignCursorsToTail()
  for (let i = 1; i <= 105; i++) userSay(router, `消息${i}`)
  assert.equal(router.unreadCount('B'), 105)
  assert.equal(router.catchUpDigest('B'), true)
  const digestSeq = journal.maxSeq()
  assert.equal(router.cursors('B').ackedThrough, digestSeq - 1, '游标越过被摘要历史,摘要本身未读')
  const info = router.nextBatchInfo('B', clock.now())
  assert.equal(info.status, 'ready')
  assert.equal(info.batch.messages.length, 1, '下一批只含摘要')
  assert.equal(info.batch.messages[0].kind, 'control')
  assert.ok(info.batch.messages[0].text.includes('消息105'), '最新用户消息原文进摘要(绝不丢)')
  assert.ok(info.batch.messages[0].text.includes('105 条消息'), '积压总数进摘要')
  assert.equal(router.catchUpDigest('B'), false, '未达阈值不再折叠')
  // 其他角色不受影响(摘要同样入列,未读 = 105 历史 + 1 摘要)
  assert.equal(router.unreadCount('A'), 106)
})

test('连续失败 paused 的角色:每条用户消息都复位重试(§13 恢复,不再永久沉默)', async () => {
  const clock = makeClock()
  const adA = createFakeActorAdapter([
    { fail: true }, { fail: true }, { fail: true }, { fail: true },
    { speak: '甲恢复了' }, { listen: true },
  ])
  const { rt } = makeRuntime({ A: adA }, { clock })
  await rt.sendUser('第一次')
  await clock.advance(20_000) // 1s+2s+4s 退避后第 4 次失败 → paused
  assert.equal(adA.calls.length, 4)
  assert.equal(rt.getSnapshot().actors.A.status, 'paused')
  // 新用户消息:失败计数复位,角色重试成功——而不是沉默到"停止→恢复"
  await rt.sendUser('再说一次')
  await clock.advance(autonomyPolicy.MERGE_WAIT_MS + 500)
  const replies = rt.journal().list().filter((m) => m.author === 'A')
  assert.equal(replies.length, 1)
  assert.equal(rt.getSnapshot().actors.A.status, 'idle')
})

test('调用限流统计所有 invocation,60s 滑窗后恢复', () => {
  const limiter = autonomyPolicy.createInvocationLimiter(3)
  const t0 = 1_000_000
  limiter.count('A', t0)
  limiter.count('A', t0 + 1000)
  assert.equal(limiter.canInvoke('A', t0 + 2000), true)
  limiter.count('A', t0 + 2000)
  assert.equal(limiter.canInvoke('A', t0 + 3000), false)
  // 最早一条 59s 后滑出窗口即可再调用
  assert.equal(limiter.canInvoke('A', t0 + 1000 + 60_000), true)
})

// ---------- Runtime 集成 ----------

test('自由聊一轮:三角色各一条,roomSeq 唯一,静止后零新调用(I3)', async () => {
  const clock = makeClock()
  const adA = createFakeActorAdapter([{ speak: '甲的话' }, { listen: true }, { listen: true }])
  const adB = createFakeActorAdapter([{ speak: '乙的话' }, { listen: true }, { listen: true }])
  const adC = createFakeActorAdapter([{ speak: '丙的话' }, { listen: true }, { listen: true }])
  const { rt } = makeRuntime({ A: adA, B: adB, C: adC }, { clock })
  assert.equal(await rt.sendUser('你们今天怎么样'), 'accepted')
  await clock.advance(autonomyPolicy.MERGE_WAIT_MS + 500)
  const msgs = rt.journal().list()
  assert.deepEqual(msgs.map((m) => m.roomSeq), [1, 2, 3, 4])
  assert.deepEqual(msgs.slice(1).map((m) => m.author), ['A', 'B', 'C'])
  // 全员游标消化他人回复(A/B 看到全部四条;C 不收自己的 m4,游标停在 3——
  // FIFO 过滤自己消息的必然结果,新消息到达后照样正确前进)
  const snap = rt.getSnapshot()
  assert.equal(snap.actors.A.ackedThrough, 4)
  assert.equal(snap.actors.B.ackedThrough, 4)
  assert.equal(snap.actors.C.ackedThrough, 3)
  await rt.whenQuiescent()
  const calls = () => adA.calls.length + adB.calls.length + adC.calls.length
  const before = calls()
  await clock.advance(2000)
  assert.equal(calls(), before, '静止后不得再有任何模型调用')
})

test('用户抢占:在飞请求被取消,重新收集的批次包含新消息,旧结果不上屏', async () => {
  const clock = makeClock()
  const adA = createFakeActorAdapter([{ listen: true }, { listen: true }])
  const adB = createFakeActorAdapter([{ defer: true }, { speak: '乙的合并回答', replyTo: [] }, { listen: true }])
  const adC = createFakeActorAdapter([{ listen: true }, { listen: true }])
  const { rt } = makeRuntime({ A: adA, B: adB, C: adC }, { clock })
  await rt.sendUser('第一个问题')
  await clock.settle()
  assert.equal(adB.deferred.length, 1)
  await rt.sendUser('算了换个问题,乙回答我')
  await clock.settle()
  // 在飞请求被 abort(用户抢占)
  assert.equal(adB.signalsOf(0)?.aborted, true)
  await clock.advance(autonomyPolicy.MERGE_WAIT_MS + 500)
  // B 的新批次包含第二条用户消息(未跳过旧消息,连续前缀)
  assert.equal(adB.calls.length >= 2, true)
  const second = adB.calls[1].req.batch
  assert.equal(second.primaryUserMessageId, 'm2')
  assert.deepEqual(second.messages.map((m) => m.id), ['m1', 'm2'])
  const msgs = rt.journal().list()
  assert.equal(msgs.filter((m) => m.author === 'B').length, 1, '被抢占的旧请求不得产生回复')
  assert.equal(msgs[msgs.length - 1].author, 'B')
})

test('停止词:全员暂停 + 在飞作废 + 零新调用;恢复后新 epoch', async () => {
  const clock = makeClock()
  const adA = createFakeActorAdapter([{ defer: true }, { speak: '甲回来了' }, { listen: true }])
  const adB = createFakeActorAdapter([{ listen: true }, { listen: true }, { listen: true }])
  const { rt } = makeRuntime({ A: adA, B: adB }, { clock })
  await rt.sendUser('甲我们来聊会天')
  await clock.settle()
  assert.equal(rt.getSnapshot().busy, true)
  await rt.sendUser('都别说了')
  await clock.settle()
  // 停止:在飞作废、不再唤醒、消息本身留痕
  assert.equal(adA.signalsOf(0)?.aborted, true)
  assert.equal(rt.getSnapshot().busy, false)
  const stopMsg = rt.journal().list().at(-1)
  assert.equal(stopMsg.author, 'user')
  const callsNow = adA.calls.length + adB.calls.length
  await clock.advance(3000)
  assert.equal(adA.calls.length + adB.calls.length, callsNow, '暂停期不得有新调用')
  // 恢复:用户新消息开启新 epoch
  await rt.sendUser('那继续聊点别的吧')
  await clock.advance(autonomyPolicy.MERGE_WAIT_MS + 500)
  const reply = rt.journal().list().filter((m) => m.author === 'A').at(-1)
  assert.ok(reply, '恢复后甲重新发言')
  assert.equal(reply.epoch >= 1, true, '恢复后回复属于新 epoch')
})

test('重启(I5):引导历史后游标对齐尾部,绝不重答旧批次', async () => {
  const clock = makeClock()
  const adA = createFakeActorAdapter([{ speak: '新问题的回答' }])
  const { rt } = makeRuntime({ A: adA }, { clock })
  rt.bootstrapHistory([
    { author: 'user', text: '昨天的问题', ts: 1 },
    { author: 'A', text: '昨天的回答', ts: 2 },
  ])
  const snap = rt.getSnapshot()
  assert.equal(snap.actors.A.ackedThrough, 2)
  await rt.sendUser('新问题')
  await clock.advance(autonomyPolicy.MERGE_WAIT_MS + 500)
  const batch = adA.calls[0].req.batch
  assert.deepEqual(batch.messages.map((m) => m.id), ['m3'], '新批次只含新消息,不重答历史')
})

test('C 关闭:不被唤醒、状态 disabled、游标始终跟尾(不回写持久配置)', async () => {
  const clock = makeClock()
  const adC = createFakeActorAdapter([])
  const { rt } = makeRuntime(
    { A: createFakeActorAdapter([{ speak: '甲的话' }, { listen: true }]), B: createFakeActorAdapter([{ listen: true }, { listen: true }]), C: adC },
    {
      clock,
      actors: {
        A: { binding: { kind: 'api' }, autonomy: 'natural' },
        B: { binding: { kind: 'api' }, autonomy: 'natural' },
        C: { binding: { kind: 'disabled' }, autonomy: 'quiet' },
      },
    },
  )
  await rt.sendUser('你们俩说说')
  await clock.advance(autonomyPolicy.MERGE_WAIT_MS + 500)
  assert.equal(adC.calls.length, 0)
  const snap = rt.getSnapshot()
  assert.equal(snap.actors.C.status, 'disabled')
  assert.equal(
    snap.actors.C.ackedThrough,
    rt.journal().list().at(-1).roomSeq,
    'disabled 游标跟尾(重新启用不洪水补答)',
  )
})

test('presentationHold 阻塞静止:播完(释放)才 quiescent(whenIdle 语义)', async () => {
  const clock = makeClock()
  const { rt } = makeRuntime({}, { clock })
  const release = rt.presentationHold()
  let done = false
  void rt.whenQuiescent().then(() => {
    done = true
  })
  await clock.settle()
  assert.equal(done, false)
  release()
  await clock.settle()
  assert.equal(done, true)
  assert.equal(rt.getSnapshot().busy, false)
})

test('dispose 后 sendUser 明确返回 backpressure(不伪装 accepted)', async () => {
  const clock = makeClock()
  const { rt } = makeRuntime({}, { clock })
  await rt.dispose()
  assert.equal(await rt.sendUser('还有人吗'), 'backpressure')
})
