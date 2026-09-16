// RelayDirector 行为矩阵(深模块验收):假 ask 适配器 + 注入时钟,零网络。
// 覆盖:PreparedRelaySource 契约与流水线预发 / 双角色固定交替 / maxTurns 收尾
// 指令 / intent:end 的 minTurns 门槛 / 整场时间预算 / 连续重复收场 /
// 两段式失败恢复与本地收尾 / 用户取消无新请求 / speaker 忽略 / 会话释放。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let createRelayDirector
let aiTheaterTurnPolicy

before(async () => {
  ;({ createRelayDirector } = await import('../src/relay/relayDirector.ts'))
  ;({ AI_THEATER_TURN_POLICY: aiTheaterTurnPolicy } = await import('../src/relay/relayPolicy.ts'))
})


/** 台词步骤:字符串 = 原样回传;{fail:true} = 抛错(计入该演员失败) */
function makeDeps(script, over = {}) {
  const calls = []
  const released = []
  let clock = over.clock ?? 0
  const deps = {
    ask: async (req) => {
      calls.push({ speaker: req.actor.speaker, prompt: req.prompt, reset: !!req.reset })
      const step = script[calls.length - 1]
      if (over.advance) clock = over.advance(clock, calls.length)
      if (!step || step.fail) throw new Error('网页失败')
      return typeof step === 'string' ? step : (step.raw ?? JSON.stringify(step))
    },
    release: (key) => released.push(key),
    now: () => clock,
  }
  return { deps, calls, released }
}

function makeReq(over = {}) {
  return {
    eid: 'e1',
    scene: {
      topic: '谁偷吃了蛋糕',
      hook: '蛋糕盒上写着名字',
      focus: '当面对质',
      stage: '矛盾升级',
      allowedBranches: [],
      avoid: [],
      relationship: '熟悉的长期伙伴',
      goalA: '证明自己没吃',
      goalB: '找出真相',
    },
    actors: [
      { speaker: 'A', site: 'deepseek', conversationKey: 'relay:e1:A', name: '甲', persona: '甲:爱逞强,心虚' },
      { speaker: 'B', site: 'doubao', conversationKey: 'relay:e1:B', name: '乙', persona: '乙:精明,嘴快' },
    ],
    minTurns: 3,
    maxTurns: 4,
    timeBudgetMs: 60_000,
    perTurnTimeoutMs: 5_000,
    signal: new AbortController().signal,
    ...over,
  }
}

const say = (text, intent = 'continue') => JSON.stringify({ text, intent })

async function consume(prepared) {
  const it = prepared.rest
  const lines = [prepared.first]
  while (true) {
    const r = await it.next()
    if (r.done) return { lines, result: r.value }
    lines.push(r.value)
  }
}

test('PreparedRelaySource 契约:first 已产出,第二角色请求已预发(流水线)', async () => {
  const { deps, calls } = makeDeps([say('我没吃!'), say('盒子上写着你的名字'), say('那是恶作剧'), say('行,算你狠')])
  const director = createRelayDirector(deps)
  const prepared = await director.prepareRelay(makeReq())
  assert.equal(prepared.first.speaker, 'A')
  assert.equal(calls.length, 2, '返回 first 前已预发第二角色请求')
  assert.match(calls[0].prompt, /本场由你先开口/)
  assert.match(calls[1].prompt, /开场至今发生了/)
  assert.match(calls[1].prompt, /1\. 甲:我没吃!/)
})

test('双角色固定交替;maxTurns 收束且末轮 prompt 带收尾指令;两会话都释放', async () => {
  const { deps, calls, released } = makeDeps([
    say('我没吃!'),
    say('盒子上写着你的名字'),
    say('那是恶作剧'),
    say('行,算你狠'),
  ])
  const director = createRelayDirector(deps)
  const { lines, result } = await consume(await director.prepareRelay(makeReq()))
  assert.deepEqual(lines.map((l) => l.speaker), ['A', 'B', 'A', 'B'])
  assert.equal(result.natural, true)
  assert.equal(result.reason, 'max-turns')
  assert.match(calls[3].prompt, /末句/)
  assert.deepEqual([...released].sort(), ['relay:e1:A', 'relay:e1:B'])
})

test('每个角色只在会话首轮接收完整设定,后续轮只收增量台词', async () => {
  const { deps, calls } = makeDeps([
    say('我没吃!'),
    say('盒子上写着你的名字'),
    say('那是恶作剧'),
    say('行,算你狠'),
  ])
  const director = createRelayDirector(deps)
  await consume(await director.prepareRelay(makeReq()))

  assert.match(calls[0].prompt, /你的角色:甲:爱逞强,心虚/)
  assert.match(calls[1].prompt, /你的角色:乙:精明,嘴快/)
  assert.match(calls[0].prompt, /只输出一个 JSON 对象/)
  assert.match(calls[1].prompt, /只输出一个 JSON 对象/)
  assert.doesNotMatch(calls[2].prompt, /场景:|你的角色:|两人关系:|你的目标:/)
  assert.doesNotMatch(calls[2].prompt, /只输出一个 JSON 对象|action 词表/)
  assert.match(calls[2].prompt, /2\. 乙:盒子上写着你的名字/)
  assert.doesNotMatch(calls[3].prompt, /场景:|你的角色:|两人关系:|你的目标:/)
  assert.doesNotMatch(calls[3].prompt, /只输出一个 JSON 对象|action 词表/)
  assert.match(calls[3].prompt, /3\. 甲:那是恶作剧/)
})

test('网页已有回复但解析失败:同一标签页补发格式纠错,不重建会话', async () => {
  const { deps, calls } = makeDeps([
    say('我没吃!'),
    '盒子上明明写着你的名字', // B 有回复,但不是 JSON
    say('盒子上明明写着你的名字'), // B 按纠错消息重写
    say('那是恶作剧'),
    say('行,算你狠'),
  ])
  const director = createRelayDirector(deps)
  const { lines, result } = await consume(await director.prepareRelay(makeReq()))

  assert.deepEqual(lines.map((l) => l.text), [
    '我没吃!',
    '盒子上明明写着你的名字',
    '那是恶作剧',
    '行,算你狠',
  ])
  assert.equal(result.reason, 'max-turns')
  assert.equal(calls[2].speaker, 'B')
  assert.equal(calls[2].reset, false, '格式纠错必须复用刚才回复所在的标签页')
  assert.match(calls[2].prompt, /上一条回复无法解析|只输出一个 JSON 对象/)
})

test('intent:end 在 minTurns 前被忽略,达到后生效(model-ended)', async () => {
  const { deps } = makeDeps([
    say('开场', 'continue'),
    say('我要结束', 'end'), // 第 2 轮 < minTurns 3:忽略
    say('继续啊', 'continue'),
    say('真的该散了', 'end'), // 第 4 轮 ≥ 3:生效
  ])
  const director = createRelayDirector(deps)
  const { lines, result } = await consume(await director.prepareRelay(makeReq({ maxTurns: 10 })))
  assert.equal(lines.length, 4)
  assert.equal(result.reason, 'model-ended')
  assert.equal(result.natural, true)
})

test('AI 剧场默认策略不会在约 5 句时因模型 end 提前收场', async () => {
  const replies = Array.from({ length: 16 }, (_, i) => say(`第${i + 1}句`, 'end'))
  const { deps, calls } = makeDeps(replies)
  const director = createRelayDirector(deps)
  const { lines, result } = await consume(
    await director.prepareRelay(makeReq({
      minTurns: aiTheaterTurnPolicy.minTurns,
      maxTurns: aiTheaterTurnPolicy.maxTurns,
    })),
  )

  assert.ok(lines.length >= 8, `默认场次至少应有 8 句,实际 ${lines.length} 句`)
  assert.equal(result.reason, 'model-ended')
  assert.match(calls[0].prompt, /展开:.*intent 填 continue/)
})

test('整场时间预算:超时按 timeout 中止(natural=false)', async () => {
  let clock = 0
  const { deps } = makeDeps(
    [say('一'), say('二'), say('三'), say('四'), say('五')],
    { advance: () => (clock += 30_000) },
  )
  const director = createRelayDirector(deps)
  const { lines, result } = await consume(
    await director.prepareRelay(makeReq({ maxTurns: 10, timeBudgetMs: 100_000 })),
  )
  assert.ok(lines.length < 5, `超时应提前收场,实际 ${lines.length} 句`)
  assert.equal(result.reason, 'timeout')
  assert.equal(result.natural, false)
})

test('连续两轮明显重复:丢弃重复句,按 repetitive 收场', async () => {
  const { deps } = makeDeps([say('嗯嗯嗯'), say('嗯嗯嗯'), say('嗯嗯嗯')])
  const director = createRelayDirector(deps)
  const { lines, result } = await consume(await director.prepareRelay(makeReq()))
  assert.equal(lines.length, 2, '第二句重复句已上台,第三句被丢弃')
  assert.equal(result.reason, 'repetitive')
  assert.equal(result.natural, false)
})

test('两段式失败:首次失败 reset 重建重发,二次失败本地收尾(natural=false)', async () => {
  const { deps, calls, released } = makeDeps([
    say('我没吃!'),
    { fail: true }, // B 首次失败
    say('盒子上写着你的名字'), // B reset 重试成功
    { fail: true }, // A 失败
    { fail: true }, // A 重试仍失败 → 本地收尾
  ])
  const director = createRelayDirector(deps)
  const { lines, result } = await consume(await director.prepareRelay(makeReq({ maxTurns: 8 })))
  assert.equal(calls[2].reset, true, '恢复重试必须重建会话')
  assert.match(calls[2].prompt, /连接断了一下|演出继续/)
  assert.match(calls[2].prompt, /你的角色:乙:精明,嘴快/, '重建 B 会话必须恢复完整人设')
  assert.match(calls[4].prompt, /1\. 甲:我没吃!/, '重建 A 会话必须带回完整已演历史')
  assert.match(calls[4].prompt, /2\. 乙:盒子上写着你的名字/)
  const last = lines[lines.length - 1]
  assert.equal(last.speaker, 'B', '由最近成功发言的角色(失败者的搭档)本地收尾')
  assert.equal(result.natural, false)
  assert.equal(result.reason, 'failed')
  assert.deepEqual([...released].sort(), ['relay:e1:A', 'relay:e1:B'])
})

test('首句即失败:prepareRelay 抛错(调用方回退兜底剧本)', async () => {
  const { deps } = makeDeps([{ fail: true }, { fail: true }])
  const director = createRelayDirector(deps)
  await assert.rejects(director.prepareRelay(makeReq()), /首句生成失败/)
})

test('用户取消:不再发起新请求,按 cancelled 收场', async () => {
  const ctrl = new AbortController()
  const { deps, calls } = makeDeps([say('一'), say('二'), say('三')])
  const director = createRelayDirector(deps)
  const prepared = await director.prepareRelay(makeReq({ signal: ctrl.signal }))
  const it = prepared.rest
  const r2 = await it.next() // 消费第二句(此刻第三角色的请求已预发,共 3 次)
  assert.equal(r2.value.speaker, 'B')
  ctrl.abort()
  const r3 = await it.next()
  assert.equal(r3.done, true)
  assert.equal(r3.value.reason, 'cancelled')
  assert.equal(r3.value.natural, false)
  const afterAbort = calls.length
  await it.next().catch(() => {})
  assert.equal(calls.length, afterAbort, '取消后不再有新请求')
})

test('模型输出的 speaker 被忽略:本地轮转决定谁发言', async () => {
  const { deps } = makeDeps([
    '{"text":"我说的","speaker":"Z","action":"wave"}',
    '{"text":"接一句","speaker":"A"}',
    say('再来'),
    say('收'),
  ])
  const director = createRelayDirector(deps)
  const { lines } = await consume(await director.prepareRelay(makeReq()))
  assert.deepEqual(lines.map((l) => l.speaker), ['A', 'B', 'A', 'B'])
  assert.equal(lines[0].action, 'wave')
})

test('双角色强制:actors 数量不对直接抛错', async () => {
  const { deps } = makeDeps([])
  const director = createRelayDirector(deps)
  const req = makeReq({ actors: [makeReq().actors[0]] })
  await assert.rejects(director.prepareRelay(req), /双角色/)
})
