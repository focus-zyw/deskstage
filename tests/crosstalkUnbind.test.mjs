// 相声解绑版验收(设计:docs/生活线系统设计方案.md 讨论 + 用户裁决"解绑版本不需要
// secret 或 callback"):crosstalk 模式 craft/协议/模式风格后缀三处退场装置,
// 话题降级为可弃用灵感;其他喜剧模式与校验层回归不动。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let promptBuilder
let dialogSchema

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  promptBuilder = await server.ssrLoadModule('/src/engine/promptBuilder.ts')
  dialogSchema = await server.ssrLoadModule('/src/performer/dialogSchema.ts')
})

after(async () => {
  await server?.close()
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

test('相声解绑:话题降级为可弃用灵感,strict 策略不再全文绑定', () => {
  const msgs = promptBuilder.buildMessages('crosstalk', tp('减肥这件事', 'crosstalk'), [])
  const user = msgs[1].content
  assert.ok(user.includes('话题灵感（可用、可用一半、也可完全弃用'))
  assert.ok(user.includes('减肥这件事'), '点播题材仍可见(软灵感)')
  assert.ok(user.includes('切口:减肥这件事'))
  assert.ok(!user.includes('约束强度'), 'renderTopicPlan 的 strict 绑定全文不进相声')
  assert.ok(!user.includes('必须全程围绕中心话题展开'), '严格围绕义务退场')
})

test('相声解绑:模式风格后缀换自由版,观众抉择点保留(身份层不动)', () => {
  const sys = promptBuilder.buildMessages('crosstalk', tp('减肥这件事', 'crosstalk'), [], undefined, undefined, undefined, undefined, true)[0].content
  assert.ok(sys.includes('secret/callback 不使用'))
  assert.ok(!sys.includes('模式风格与上述默认喜剧手法(互怼/包袱/secret反转/逗弄)冲突时'))
  assert.ok(sys.includes('观众互动'), '抉择点属于产品身份层,不解绑')
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
