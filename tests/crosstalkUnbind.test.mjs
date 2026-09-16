// 相声解绑版验收(设计:docs/生活线系统设计方案.md 讨论 + 用户裁决"解绑版本不需要
// secret 或 callback"):crosstalk 模式 craft/协议/模式风格后缀三处退场装置,
// 话题降级为可弃用灵感;其他喜剧模式与校验层回归不动。
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

test('相声解绑:craft 宣告装置退场与人设限权', () => {
  const sys = systemOf('crosstalk', tp('减肥这件事', 'crosstalk'))
  assert.ok(sys.includes('不需要秘密反转，不需要回收铺垫，不需要任何预设装置'))
  assert.ok(sys.includes('题材、人物、情境完全自由：人设只决定语气与相互姿态'))
  assert.ok(sys.includes('secret/callback 两字段一律省略'))
  assert.ok(!sys.includes('secret 是反转的底气'), '旧装置说教必须退场')
  assert.ok(!sys.includes('callback 是本集自己的梗'), '旧回收义务必须退场')
})

test('相声解绑:协议要求省略 secret/callback,不再命令反转与回收', () => {
  const sys = systemOf('crosstalk', tp('减肥这件事', 'crosstalk'))
  assert.ok(sys.includes('这两个字段一律省略'))
  assert.ok(!sys.includes('secret 在结尾反转揭晓'), '协议不得命令反转')
  assert.ok(!sys.includes('callback 必须回收本集前面埋的线'), '协议不得命令回收')
  assert.ok(!sys.includes('收底回收 callback 的句子标最后一拍'), 'beatId 收底指令随装置退场')
})

test('相声解绑:自动选题零注入,仅用户点播题材以灵感行出现', () => {
  // dynamic(导演自动选题)——话题零注入:连"可弃用的灵感行"都没有(锚定效应不在乎标注)
  const auto = promptBuilder.buildMessages('crosstalk', tp('减肥这件事', 'crosstalk'), [])
  const autoSys = auto[0].content
  const autoUser = auto[1].content
  assert.ok(!autoUser.includes('话题'), '自动选题不进 user 消息(连灵感行都没有)')
  assert.ok(!autoUser.includes('减肥这件事'))
  assert.ok(!autoSys.includes('用户点播了题材'), '非点播不带题材注记')
  assert.ok(!autoSys.includes('话题只是可选灵感'), 'craft 的题材注记仅点播时出现')
  // manual(用户点播题材)——灵感行出现,但明示可弃用(点播是用户权威,不是导演束缚)
  const manual = promptBuilder.buildMessages('crosstalk', { ...tp('减肥这件事', 'crosstalk'), lane: 'manual' }, [])
  const manualSys = manual[0].content
  const manualUser = manual[1].content
  assert.ok(manualUser.includes('用户点播的题材（可选灵感，可用、可用一半、也可完全弃用'))
  assert.ok(manualUser.includes('减肥这件事'))
  assert.ok(manualSys.includes('用户点播了题材'), 'craft 带点播题材注记')
})

test('相声解绑:模式风格后缀换自由版,观众抉择点亦不注入(极简)', () => {
  const sys = promptBuilder.buildMessages('crosstalk', tp('减肥这件事', 'crosstalk'), [], undefined, undefined, undefined, undefined, true)[0].content
  assert.ok(sys.includes('secret/callback 不使用'))
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
