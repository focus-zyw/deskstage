// choice 抉择点气泡不出现的复现环:在 parse→validate 缝隙上断言
// "这个本最终会不会弹出抉择面板"(判据 = script.choice 存在且无 fatal),
// 另加 player 层运行时断言(onChoice 触发/中止路径)。
// 全部确定性:不碰网络/磁盘,LLM 原始输出用真实形状的固定用例。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let parseGeneratedDialog
let validatePerformanceScript
let PerformancePlayer
let evaluateChoiceAsk
let getConfig
let DEFAULT_CONFIG

before(async () => {
  ;({ parseGeneratedDialog, validatePerformanceScript } = await import('../src/performer/dialogSchema.ts'))
  ;({ PerformancePlayer } = await import('../src/performer/player.ts'))
  ;({ evaluateChoiceAsk } = await import('../src/dialogue/choiceGate.ts'))
  ;({ getConfig, DEFAULT_CONFIG } = await import('../src/storage/configStore.ts'))
})


const line = (speaker, text, extra = {}) => ({ speaker, text, action: 'talk', ...extra })
const CHOICE = { prompt: '谁先道歉?', options: [{ id: 'a', label: '甲先' }, { id: 'b', label: '乙先' }] }

/** 判据 = 用户可见结果:面板会弹(choice 存在且无 fatal)。raw 对象先序列化成 LLM 原始输出形态 */
function outcome(raw) {
  const script = parseGeneratedDialog(JSON.stringify(raw))
  const v = validatePerformanceScript(script)
  return { script, fatal: v.fatal, panelShows: script.choice != null && v.fatal.length === 0 }
}

test('契约:规范的 choice(两选项+branch 标记齐全)通过且面板会弹', () => {
  const r = outcome({
    dialog: [
      line('A', '我们把项目搞砸了。'),
      line('B', '材料是你写的,数字是我算的。'),
      line('A', '那这锅谁背?'),
      line('B', '总有一个人要出头。'),
      { choice: CHOICE },
      line('A', '好吧,数字问题算我的。', { branch: 'a' }),
      line('B', '行,那口径问题我来补。', { branch: 'a' }),
      line('A', '等下,材料其实是我抄的模板。', { branch: 'b' }),
      line('B', '我就说数字对不上!', { branch: 'b' }),
    ],
  })
  assert.equal(r.fatal.length, 0)
  assert.ok(r.panelShows, '规范 choice 必须弹面板')
})

test('静默丢弃:模型只给 1 个选项 → choice 被丢、无 fatal、不弹面板', () => {
  const r = outcome({
    dialog: [
      line('A', '我们把项目搞砸了。'),
      line('B', '材料是你写的,数字是我算的。'),
      line('A', '那这锅谁背?'),
      line('B', '总有一个人要出头。'),
      { choice: { prompt: '谁先道歉?', options: [{ id: 'a', label: '甲先' }] } },
      line('A', '好吧,算我的。'),
      line('B', '下不为例。'),
      line('A', '撸串去?'),
      line('B', '走。'),
    ],
  })
  // 现状(parse 层):坏 choice 行被当普通台词丢弃,其余台词照常进 before,
  // 结构校验零 fatal → 静默播出、无气泡。修复后此行为不变,但原文会经
  // onChoiceRejected 钩子上交,由 generateDialog 的软修复链路救一次。
  assert.equal(r.script.choice, undefined)
  assert.equal(r.fatal.length, 0)
  assert.equal(r.panelShows, false, '模型明明写了 choice,面板却不会出现')
})

test('parse 钩子:choice 写坏时必须回调原文(软修复链路的输入)', () => {
  const rejected = []
  const raw = {
    dialog: [
      line('A', '一'), line('B', '二'), line('A', '三'), line('B', '四'),
      { choice: { prompt: '谁先道歉?', options: [{ id: 'a', label: '甲先' }] } },
      line('A', '五'), line('B', '六'), line('A', '七'), line('B', '八'),
    ],
  }
  const script = parseGeneratedDialog(JSON.stringify(raw), 4, {
    onChoiceRejected: (v) => rejected.push(v),
  })
  assert.equal(script.choice, undefined)
  assert.equal(rejected.length, 1, '写坏的 choice 原文必须上交,否则修复链路无从救起')
  assert.deepEqual(rejected[0].options, [{ id: 'a', label: '甲先' }])
})

test('parse 钩子:规范 choice 不触发回调;无 choice 也不触发', () => {
  const rejected = []
  const good = parseGeneratedDialog(
    JSON.stringify({
      dialog: [
        line('A', '一'), line('B', '二'), line('A', '三'), line('B', '四'),
        { choice: CHOICE },
        line('A', '五', { branch: 'a' }), line('B', '六', { branch: 'a' }),
        line('A', '七', { branch: 'b' }), line('B', '八', { branch: 'b' }),
      ],
    }),
    4,
    { onChoiceRejected: (v) => rejected.push(v) },
  )
  assert.ok(good.choice)
  const none = parseGeneratedDialog(
    JSON.stringify({ dialog: [line('A', '一'), line('B', '二'), line('A', '三'), line('B', '四')] }),
    4,
    { onChoiceRejected: (v) => rejected.push(v) },
  )
  assert.ok(!none.choice)
  assert.equal(rejected.length, 0)
})

test('fatal 路径:branch 标记缺失/错位/每支不足两句 → 校验拦截(修复或重试,choice 大概率保不住)', () => {
  const untagged = outcome({
    dialog: [
      line('A', '一'), line('B', '二'), line('A', '三'), line('B', '四'),
      { choice: CHOICE },
      line('A', '好吧算我的'), line('B', '下不为例'),
    ],
  })
  assert.ok(untagged.fatal.length > 0)
  assert.equal(untagged.panelShows, false)

  const mismatch = outcome({
    dialog: [
      line('A', '一'), line('B', '二'), line('A', '三'), line('B', '四'),
      { choice: CHOICE },
      line('A', '好吧算我的', { branch: 'jiashang' }),
      line('B', '下不为例', { branch: 'jiashang' }),
      line('A', '其实是我抄的', { branch: 'yibang' }),
      line('B', '数字对不上!', { branch: 'yibang' }),
    ],
  })
  assert.ok(mismatch.fatal.length > 0)

  const thin = outcome({
    dialog: [
      line('A', '一'), line('B', '二'), line('A', '三'), line('B', '四'),
      { choice: CHOICE },
      line('A', '好吧算我的', { branch: 'a' }),
      line('B', '下不为例', { branch: 'b' }),
    ],
  })
  assert.ok(thin.fatal.length > 0)
})

test('choice 放在数组开头 → before 为空,直接 fatal(不会出现诡异空面板)', () => {
  const r = outcome({
    dialog: [
      { choice: CHOICE },
      line('A', '好吧算我的', { branch: 'a' }),
      line('B', '下不为例', { branch: 'a' }),
      line('A', '其实是我抄的', { branch: 'b' }),
      line('B', '数字对不上!', { branch: 'b' }),
    ],
  })
  assert.ok(r.fatal.length > 0)
})

// ---------- choiceGate:掷中后的软修复议题 ----------

test('choiceGate:未掷中或已有合格 choice → 无议题', () => {
  assert.deepEqual(evaluateChoiceAsk({ allowChoice: false, script: {} }), [])
  assert.deepEqual(evaluateChoiceAsk({ allowChoice: false, script: { choice: CHOICE }, rejectedRaw: { x: 1 } }), [])
  assert.deepEqual(evaluateChoiceAsk({ allowChoice: true, script: { choice: CHOICE } }), [])
})

test('choiceGate:掷中但没写 → 议题要求补出;写坏 → 议题带原文', () => {
  const missing = evaluateChoiceAsk({ allowChoice: true, script: {} })
  assert.equal(missing.length, 1)
  assert.match(missing[0], /缺失观众抉择点/)

  const badChoice = { prompt: '谁先道歉?', options: [{ id: 'a', label: '甲先' }] }
  const rejected = evaluateChoiceAsk({ allowChoice: true, script: {}, rejectedRaw: badChoice })
  assert.equal(rejected.length, 1)
  assert.match(rejected[0], /不完整/)
  assert.match(rejected[0], /甲先/, '原文要带给修复模型')
})

// ---------- choiceChance 配置:清洗钳位 ----------

test('choiceChance:非法值钳位 0~1,缺省 0.3', async () => {
  assert.equal(DEFAULT_CONFIG.choiceChance, 0.3)
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
  values.set('vc-config', JSON.stringify({ choiceChance: 5 }))
  const cfg = await getConfig()
  assert.equal(cfg.choiceChance, 1)
  delete globalThis.localStorage
})

// ---------- player 层:onChoice 的触发与中止 ----------

/** 立即完成的语音相位回调桩;600ms 最短可读时间是真实 sleep,用例控制在最少句数 */
function makePlayer(events) {
  return new PerformancePlayer({
    onStart: (l) => events.push(['start', l.text]),
    onLineStart: (l) => {
      events.push(['line', l.text])
      return { speechPhase: Promise.resolve() }
    },
    onSpeechEnd: (s) => events.push(['end', s]),
    onLineEnd: (s) => events.push(['lineEnd', s]),
    onChoice: (cp) => events.push(['choice', cp.prompt]),
    onDone: () => events.push(['done']),
    onStopped: (played) => events.push(['stopped', played.length]),
  })
}

const BEFORE = [line('A', '一'), line('B', '二'), line('A', '三')]
const AFTER = { a: [line('A', '甲线')], b: [line('B', '乙线')] }

test('player:choice+after 齐备时,播完 before 触发 onChoice,resume 后播对应分支', async () => {
  const events = []
  const p = makePlayer(events)
  p.play(BEFORE, { gap: 1, choice: CHOICE, after: AFTER })
  await new Promise((r) => setTimeout(r, 2400))
  assert.ok(events.some((e) => e[0] === 'choice' && e[1] === '谁先道歉?'), 'onChoice 必须触发')
  p.resume('b')
  await new Promise((r) => setTimeout(r, 1200))
  assert.ok(events.some((e) => e[0] === 'line' && e[1] === '乙线'), '选中的分支要播')
  assert.ok(events.some((e) => e[0] === 'done'))
})

test('player:等待选边期间 stop() → 走中止路径,分支不播、onDone 不触发', async () => {
  const events = []
  const p = makePlayer(events)
  p.play(BEFORE, { gap: 1, choice: CHOICE, after: AFTER })
  await new Promise((r) => setTimeout(r, 2400))
  assert.ok(events.some((e) => e[0] === 'choice'))
  p.stop()
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(events.some((e) => e[0] === 'stopped'))
  assert.ok(!events.some((e) => e[0] === 'done'))
  assert.ok(!events.some((e) => e[0] === 'line' && (e[1] === '甲线' || e[1] === '乙线')))
})
