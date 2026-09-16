// 表达导演纯逻辑验收矩阵(方案 §三/§四):语音机制/权重抽取/全部冷却规则/
// 任务优先/旧梗选择/指令渲染。假依赖注入,零 IO 零模型。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let mod
let persona

before(async () => {
  mod = await import('../src/expression/index.ts')
  persona = await import('../src/engine/persona.ts')
})



// ---------- VoiceMechanics(方案 §四) ----------

test('内置 B 角色机制对齐方案示例值', () => {
  const B = mod.BUILTIN_MECHANICS.B
  assert.equal(B.rhythm.preferredLength, 'micro')
  assert.equal(B.rhythm.fragmentChance, 0.45)
  assert.equal(B.social.agreementBias, 0.35)
  assert.deepEqual(B.humor, ['challenge', 'deflect', 'callback'])
  assert.deepEqual(B.defense, { trigger: '被关心或被夸', response: 'deflect' })
})

test('默认人设走内建表;自定义人设按关键词派生,不强加默认人格', () => {
  const m = mod.voiceMechanicsOf('B', persona.personaText('B'))
  assert.equal(m, mod.BUILTIN_MECHANICS.B)
  const derived = mod.deriveMechanics('她说话温柔体贴,喜欢照顾人,偶尔害羞')
  assert.ok(derived.social.agreementBias > mod.NEUTRAL_MECHANICS.social.agreementBias)
  assert.ok(!derived.humor.includes('challenge'))
  const sarcastic = mod.deriveMechanics('毒舌爱吐槽,一针见血')
  assert.ok(sarcastic.humor.includes('challenge'))
  assert.ok(sarcastic.social.teasingIntensity > mod.NEUTRAL_MECHANICS.social.teasingIntensity)
})

test('口头禅:默认人设取内建表;自定义解析不出给空表,不猜不编', () => {
  persona.setPersonaOverride('B', '一个普通程序员,没什么口头禅', '', { b: 'custom' })
  assert.deepEqual(mod.catchphrasesOf('B', '一个普通程序员,没什么口头禅'), [])
  persona.setPersonaOverride('B', '程序员,口头禅"就这?"和"然后呢"', '', { b: 'custom' })
  assert.deepEqual(mod.catchphrasesOf('B', '程序员,口头禅"就这?"和"然后呢"'), ['就这?', '然后呢'])
  persona.setPersonaOverride('B', '', '', { b: 'default' })
  assert.deepEqual([...mod.catchphrasesOf('B')], ['就这?', '然后呢'])
})

// ---------- 冷却规则(方案 §三) ----------

const baseArgs = (state, over = {}) => ({
  stimulus: '今天好无聊啊',
  mayAskQuestion: true,
  mechanics: mod.BUILTIN_MECHANICS.A,
  state,
  rng: () => 0,
  ...over,
})

test('权重表由代码抽取且合计 100', () => {
  const sum = Object.values(mod.BASE_WEIGHTS).reduce((a, b) => a + b, 0)
  assert.equal(sum, 100)
})

test('全新状态:十个动作全部合格;从未用过旧梗不设冷却', () => {
  const moves = mod.eligibleMoves(baseArgs(mod.freshPolicyState(), { callback: { id: 'g1', text: '上次那个临期酸奶事件' } }))
  assert.equal(moves.length, 10)
})

test('同一动作最多连续两次', () => {
  const s = mod.freshPolicyState()
  s.lastMoves = ['tease', 'tease']
  const moves = mod.eligibleMoves(baseArgs(s))
  assert.ok(!moves.includes('tease'))
  assert.ok(moves.includes('direct'))
  // 只连发一次时仍可用
  s.lastMoves = ['tease', 'direct']
  assert.ok(mod.eligibleMoves(baseArgs(s)).includes('tease'))
})

test('旧梗:无候选禁用;冷却 6 回合内禁用,第 6 回合起解禁', () => {
  const s = mod.freshPolicyState()
  const cb = { id: 'g1', text: '临期酸奶事件' }
  assert.ok(!mod.eligibleMoves(baseArgs(s)).includes('callback'))
  assert.ok(mod.eligibleMoves(baseArgs(s, { callback: cb })).includes('callback'))
  s.lastCallbackRound = 3
  s.round = 8 // 间隔 5 < 6
  assert.ok(!mod.eligibleMoves(baseArgs(s, { callback: cb })).includes('callback'))
  s.round = 9 // 间隔 6
  assert.ok(mod.eligibleMoves(baseArgs(s, { callback: cb })).includes('callback'))
})

test('absurd-leap 与 literalize 互斥:上一轮出现其一,本轮两者都歇', () => {
  const s = mod.freshPolicyState()
  s.lastMoves = ['absurd-leap']
  const moves = mod.eligibleMoves(baseArgs(s))
  assert.ok(!moves.includes('absurd-leap'))
  assert.ok(!moves.includes('literalize'))
  const s2 = mod.freshPolicyState()
  s2.lastMoves = ['direct']
  const moves2 = mod.eligibleMoves(baseArgs(s2))
  assert.ok(moves2.includes('absurd-leap') && moves2.includes('literalize'))
})

test('不能连续两轮都反问:上一条回复是疑问时 challenge 被禁', () => {
  const s = mod.freshPolicyState()
  const moves = mod.eligibleMoves(baseArgs(s, { mayAskQuestion: false }))
  assert.ok(!moves.includes('challenge'))
  assert.ok(moves.includes('tease'))
})

test('用户明确任务:强制 direct 先答任务,intent=answer', () => {
  const core = mod.decidePlanCore(baseArgs(mod.freshPolicyState(), { stimulus: '帮我写一首关于秋天的诗' }))
  assert.equal(core.move, 'direct')
  assert.equal(core.intent, 'answer')
  assert.equal(core.mustAnswerTask, true)
})

test('detectTask 只命中祈使/交付类,不误伤日常闲聊', () => {
  assert.equal(mod.detectTask('帮我查一下明天天气'), true)
  assert.equal(mod.detectTask('翻译一下这句英文'), true)
  assert.equal(mod.detectTask('今天好无聊啊'), false)
  assert.equal(mod.detectTask('哈哈哈笑死'), false)
})

// ---------- 旧梗选择(方案 §二不变量:只从输入选,绝不编造) ----------

test('callbackPicker:选相关性最高的梗;无关梗与近期已引用梗都不选', () => {
  const gags = [
    { id: 'g1', text: '临期酸奶打折翻车的事' },
    { id: 'g2', text: '半夜上线炸了那次' },
  ]
  const picked = mod.pickCallback({
    gags,
    stimulus: '又想起半夜上线炸了那次,真好笑',
    recent: [{ text: '今天真累' }],
  })
  assert.equal(picked?.id, 'g2')
  // 近期引用过 → 跳过
  assert.equal(
    mod.pickCallback({ gags: [gags[1]], stimulus: '半夜上线的事', recent: [{ text: '半夜上线炸了那次真绝' }] }),
    undefined,
  )
  // 无关 → 不硬凑
  assert.equal(mod.pickCallback({ gags, stimulus: '晚饭吃什么好', recent: [] }), undefined)
  assert.equal(mod.pickCallback({ gags: [], stimulus: '什么都行', recent: [] }), undefined)
})

// ---------- 指令渲染(方案 §五) ----------

test('指令渲染:立场/动作/长度/任务优先/禁反问/口头禅禁用逐行落地', () => {
  const text = mod.renderInstruction({
    intent: 'answer',
    move: 'direct',
    stance: 'agree',
    length: 'short',
    maxChars: 30,
    mayAskQuestion: true,
    mustAnswerTask: true,
    fragment: false,
    bannedCatchphrase: '然后呢',
    forbiddenPatterns: ['连续解释大道理', '热情客服式附和'],
  })
  assert.ok(text.startsWith('本轮表达策略(执行即可,不得复述):'))
  assert.ok(text.includes('先直接完成用户交代的任务'))
  assert.ok(text.includes('立场:基本同意'))
  assert.ok(text.includes('长度:一两个短句,总长不超过 30 字'))
  assert.ok(text.includes('不使用最近出现过的口头禅「然后呢」'))
  assert.ok(text.includes('不要:连续解释大道理;热情客服式附和'))
  assert.ok(!text.includes('不要反问'))
})

test('指令渲染:旧梗回收行携带梗文本;close 动作附带禁追问', () => {
  const withCallback = mod.renderInstruction({
    intent: 'react',
    move: 'callback',
    stance: 'neutral',
    length: 'micro',
    maxChars: 12,
    mayAskQuestion: true,
    mustAnswerTask: false,
    callback: { id: 'g1', text: '临期酸奶事件' },
    fragment: true,
    forbiddenPatterns: [],
  })
  assert.ok(withCallback.includes('旧梗回收:把「临期酸奶事件」自然带进话里'))
  const closing = mod.renderInstruction({
    intent: 'close',
    move: 'close',
    stance: 'neutral',
    length: 'micro',
    maxChars: 12,
    mayAskQuestion: true,
    mustAnswerTask: false,
    fragment: false,
    forbiddenPatterns: [],
  })
  assert.ok(closing.includes('不要反问'))
})
