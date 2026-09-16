// 相声互动版验收(用户裁决:解绑+极简+角色互动模板):装置字段彻底退场、自动选题零
// 注入、仅点播题材以可弃用灵感行出现;beats/goalC/engine 场景卡别名映射;其他模式回归不动。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let promptBuilder
let dialogSchema

before(async () => {
  promptBuilder = await import('../src/engine/promptBuilder.ts')
  dialogSchema = await import('../src/performer/dialogSchema.ts')
})


const tp = (title, mode = 'crosstalk') => ({
  planId: `tp-${title}`,
  createdAt: 0,
  expiresAt: 9e15,
  baseRevision: 0,
  lane: 'dynamic',
  mode,
  intent: 'new',
  card: {
    id: `tc-${title}`,
    title,
    hook: title,
    category: 'life',
    tags: [],
    source: 'curated',
    fingerprint: `fp-${title}`,
    sensitivity: 'normal',
    generatedAt: 0,
  },
  policy: 'strict',
  stage: 'open',
  episodeFocus: `切口:${title}`,
  allowedBranches: [],
  avoid: [],
  duration: 'once',
  compatibility: { sessionRevision: 0, banHash: '', modeHash: '', plannerVersion: 1 },
})

const systemOf = (mode, plan) => promptBuilder.buildMessages(mode, plan, [])[0].content

test('相声互动版:模板自含原则与自由宣告,装置字段彻底退场', () => {
  const sys = systemOf('crosstalk', tp('减肥这件事', 'crosstalk'))
  assert.ok(sys.includes('## 核心目标'))
  assert.ok(sys.includes('## 趣味生成原则'))
  assert.ok(sys.includes('不要求必须有传统包袱或响底'))
  assert.ok(sys.includes('题材、人物、情境完全自由'))
  assert.ok(!sys.includes('"secret"'), '互动版协议无 secret 字段')
  assert.ok(!sys.includes('callback'), '互动版协议无 callback 字段')
  assert.ok(!sys.includes('secret 是反转的底气'), '旧装置说教必须退场')
  assert.ok(!sys.includes('callback 是本集自己的梗'), '旧回收义务必须退场')
})

test('相声互动版:协议使用 beats/goalC/engine,按 beats 推进', () => {
  const sys = systemOf('crosstalk', tp('减肥这件事', 'crosstalk'))
  assert.ok(sys.includes('"beats":["节拍1","节拍2","节拍3"]'))
  assert.ok(sys.includes('"goalC"'))
  assert.ok(sys.includes('dialog 必须按照 card.beats 推进'))
  assert.ok(sys.includes('## 最后自检'))
})

test('相声解绑:自动选题零注入,仅用户点播题材以灵感行出现', () => {
  // dynamic(导演自动选题)——话题零注入:连"可弃用的灵感行"都没有(锚定效应不在乎标注)
  const auto = promptBuilder.buildMessages('crosstalk', tp('减肥这件事', 'crosstalk'), [])
  const autoUser = auto[1].content
  assert.ok(!autoUser.includes('话题'), '自动选题不进 user 消息(连灵感行都没有)')
  assert.ok(!autoUser.includes('减肥这件事'))
  assert.ok(!autoUser.includes('用户点播的题材'), '非点播不带题材注记')
  // manual(用户点播题材)——灵感行出现,但明示可弃用(点播是用户权威,不是导演束缚)
  const manual = promptBuilder.buildMessages('crosstalk', { ...tp('减肥这件事', 'crosstalk'), lane: 'manual' }, [])
  const manualUser = manual[1].content
  assert.ok(manualUser.includes('用户点播的题材（可选灵感，可用、可用一半、也可完全弃用'))
  assert.ok(manualUser.includes('减肥这件事'))
})

test('相声解绑:模式风格后缀换自由版,观众抉择点亦不注入(极简)', () => {
  const sys = promptBuilder.buildMessages('crosstalk', tp('减肥这件事', 'crosstalk'), [], undefined, undefined, undefined, undefined, true)[0].content
  assert.ok(sys.includes('## 最后自检'), '互动版自检清单在场')
  assert.ok(!sys.includes('模式风格与上述默认喜剧手法(互怼/包袱/secret反转/逗弄)冲突时'))
  assert.ok(!sys.includes('观众互动'), '极简相声连抉择点也不注入(用户裁决)')
})

test('相声极简:画像/怪癖纪律/现实时间/角色世界全部不进,名册行在场', () => {
  const sys = promptBuilder.buildMessages(
    'crosstalk',
    tp('减肥这件事', 'crosstalk'),
    [],
    '小说',
    { profile: { userName: 'focus', likes: '小说', banTopics: '相亲' }, facts: ['用户通宵薅羊毛'] },
    undefined,
    '观众戳了小哀 1 次',
    true,
    undefined,
    '内存快占满了',
    '两人关系很铁',
    '乙情绪稍紧绷',
  )[0].content
  assert.ok(sys.includes('speaker 只能取括号里的值'), '极简名册行在场')
  assert.ok(!sys.includes('便利店店员') && !sys.includes('温柔捧场型'), '人设文本不进')
  assert.ok(!sys.includes('怪癖使用纪律'), '怪癖块不进')
  assert.ok(!sys.includes('使用者画像'), '观众画像不进')
  assert.ok(!sys.includes('雷区'), '雷区行随画像一并退出(用户裁决)')
  assert.ok(!sys.includes('现实时间'), '时间语境不进')
  assert.ok(!sys.includes('长期关系背景'), '关系底色不进')
  assert.ok(!sys.includes('本集关系状态'), '本集关系卡不进')
  assert.ok(!sys.includes('角色分工'), 'C 分工不进')
  assert.ok(!sys.includes('观众互动'), '抉择点不进')
})

test('回归:日常模式(非喜剧)不受解绑影响,strict 话题绑定原样', () => {
  const msgs = promptBuilder.buildMessages('daily', tp('周末计划', 'daily'), [])
  const sys = msgs[0].content
  const user = msgs[1].content
  assert.ok(sys.includes('本集基调：日常闲聊'), 'daily 走非喜剧 craft,基调原文在')
  assert.ok(!sys.includes('不需要秘密反转'), 'daily 不带相声解绑 craft')
  assert.ok(user.includes('本段话题计划'), 'daily 保留完整话题计划')
  assert.ok(user.includes('严格（必须全程围绕中心话题展开'), 'daily 的 strict 绑定原样')
})

test('校验降档:crosstalk 卡缺 secret/callback 不再 fatal,纯喜剧仍 fatal', () => {
  const line = () => ({ speaker: 'A', text: '测试台词一句', action: 'talk', target: 'B', beatId: '拍一' })
  const script = {
    before: [line(), line(), line(), line()],
    card: { relationship: '伙伴', scene: '测试场景', goalA: 'a', goalB: 'b', escalation: ['拍一', '拍二'] },
    after: {},
  }
  const unbound = dialogSchema.validatePerformanceScript(script, 4, { comedy: true, crosstalk: true })
  assert.ok(!unbound.fatal.some((f) => f.includes('secret')), '解绑版不因缺 secret 判死')
  assert.ok(!unbound.fatal.some((f) => f.includes('callback')), '解绑版不因缺 callback 判死')
  const strict = dialogSchema.validatePerformanceScript(script, 4, { comedy: true })
  assert.ok(strict.fatal.some((f) => f.includes('secret')), '纯喜剧回归:缺 secret 仍 fatal')
  assert.ok(strict.fatal.some((f) => f.includes('callback')), '纯喜剧回归:缺 callback 仍 fatal')
})

test('schema 别名映射:beats→escalation、goalC→roleC、engine 保留,节拍覆盖校验通过', () => {
  const raw = JSON.stringify({
    card: {
      relationship: '老友',
      scene: '凌晨的电脑桌前',
      engine: '一个普通问题被越来越认真地讨论',
      goalA: '小哀此刻想做什么',
      goalB: '柯南此刻想做什么',
      goalC: '大肥鱼此刻想做什么',
      beats: ['发现异常', '开始较真', '意外转折'],
    },
    dialog: [
      { speaker: 'A', text: '第一条台词', action: 'talk', target: 'B', beatId: '发现异常' },
      { speaker: 'B', text: '第二条台词', action: 'talk', target: 'A', beatId: '开始较真' },
      { speaker: 'C', text: '第三条台词', action: 'talk', target: 'A', beatId: '意外转折' },
      { speaker: 'A', text: '第四条台词', action: 'talk', target: 'B', beatId: '意外转折' },
    ],
  })
  const script = dialogSchema.parseGeneratedDialog(raw, 4)
  assert.deepEqual(script.card.escalation, ['发现异常', '开始较真', '意外转折'], 'beats 落到 canonical escalation')
  assert.equal(script.card.roleC, '大肥鱼此刻想做什么', 'goalC 落到 canonical roleC')
  assert.equal(script.card.engine, '一个普通问题被越来越认真地讨论', 'engine 随卡保留')
  const v = dialogSchema.validatePerformanceScript(script, 4, { comedy: true, crosstalk: true })
  assert.deepEqual(v.fatal, [], '新卡节拍覆盖校验通过')
})
