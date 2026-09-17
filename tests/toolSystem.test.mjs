// 工具系统纯函数件验收:schema 清洗 / 门槛路由 / 权限策略 / 决策解析 / 观察块。
// 全部零 Tauri 零网络;每个用例对应一条设计裁决(清洗不猜、零候选不调模型、
// 模型不能自我降权、解析从严、注入防御)。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let m

before(async () => {
  m = {
    schema: await import('../src/tools/schema.ts'),
    gate: await import('../src/tools/candidateGate.ts'),
    policy: await import('../src/tools/policy.ts'),
    parse: await import('../src/tools/planner/decisionParse.ts'),
    obs: await import('../src/tools/observation.ts'),
  }
})


const manifestOf = (over = {}) => ({
  id: 'capture_screen',
  label: '截屏',
  description: '截屏',
  risk: 'read',
  inputSchema: { properties: {} },
  timeoutMs: 10_000,
  defaultEnabled: true,
  match: () => (over.score ?? 0),
  ...over,
})

test('schema:必填缺失拒绝,未知键丢弃,超长截断,枚举白名单', () => {
  const schema = {
    properties: {
      text: { type: 'string', maxLength: 5, description: '内容' },
      source: { type: 'string', enum: ['screen', 'clipboard'] },
      n: { type: 'number' },
    },
    required: ['text'],
  }
  assert.equal(m.schema.validateToolInput(schema, undefined).ok, false) // 缺必填
  assert.equal(m.schema.validateToolInput(schema, { text: 'hi', evil: 'x' }).ok, true)
  const ok = m.schema.validateToolInput(schema, { text: '很长很长很长', source: 'screen', evil: 'x', n: 1 })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.text, '很长很长很') // 截断(6字→5字)
  assert.equal('evil' in ok.value, false) // 未知键丢弃
  assert.equal(m.schema.validateToolInput(schema, { text: 'hi', source: 'camera' }).ok, false) // 枚举外拒绝
  assert.equal(m.schema.validateToolInput(schema, { text: 'hi', n: 'x' }).ok, false) // 类型拒绝
  // 描述渲染:决策 prompt 的参数提示
  assert.match(m.schema.describeSchema(schema), /text\(string,必填,≤5字\)/)
})

test('门槛:零候选不进 Planner;单高置信直达;多候选交给模型', () => {
  const ctx = { phase: 'idle' }
  const none = m.gate.routeTurn('今天天气不错', [manifestOf({ score: 0 })], ctx)
  assert.deepEqual(none, { kind: 'none' })
  const direct = m.gate.routeTurn('帮我截屏', [manifestOf({ score: 0.9 }), manifestOf({ id: 'other', score: 0 })], ctx)
  assert.deepEqual(direct, { kind: 'direct', tool: 'capture_screen' })
  const plan = m.gate.routeTurn(
    '看看屏幕上的字',
    [manifestOf({ score: 0.5 }), manifestOf({ id: 'recognize_text', score: 0.85 })],
    ctx,
  )
  assert.equal(plan.kind, 'plan')
  assert.equal(plan.candidates.length, 2)
  assert.equal(plan.candidates[0].id, 'recognize_text') // 高分在前
  // 有必填参数的工具不许直达:参数要从话里抽,必须走 Planner
  const needArg = manifestOf({ id: 'search_memory', score: 0.9, inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] } })
  assert.equal(m.gate.routeTurn('翻翻记忆', [needArg], ctx).kind, 'plan')
})

test('策略:开关关即拒;read 自动;external 必确认;autoApproved 免确认', () => {
  const read = manifestOf({ risk: 'read' })
  const ext = manifestOf({ id: 'send_notification', risk: 'external', defaultEnabled: false })
  assert.equal(m.policy.decidePolicy({}, read), 'allow-auto')
  assert.equal(m.policy.decidePolicy({}, ext), 'denied') // 缺省开关 = defaultEnabled false:external 默认关
  assert.equal(m.policy.decidePolicy({ switches: { send_notification: true } }, ext), 'need-confirm')
  assert.equal(m.policy.decidePolicy({ switches: { send_notification: false } }, ext), 'denied')
  assert.equal(
    m.policy.decidePolicy({ switches: { send_notification: true }, autoApproved: { send_notification: true } }, ext),
    'allow-auto',
  )
  // read 开关关:同样拒
  assert.equal(m.policy.decidePolicy({ switches: { capture_screen: false } }, read), 'denied')
})

test('决策解析:三选一放行;未知工具/坏结构一律 null(不猜测)', () => {
  const ids = new Set(['recognize_text'])
  assert.deepEqual(m.parse.parseToolDecision('{"kind":"none"}', ids), { kind: 'none' })
  assert.deepEqual(m.parse.parseToolDecision('废话{"kind":"call","tool":"recognize_text","arguments":{"source":"screen"}}', ids), {
    kind: 'call',
    tool: 'recognize_text',
    arguments: { source: 'screen' },
  })
  assert.deepEqual(m.parse.parseToolDecision('{"kind":"clarify","question":"读屏幕还是剪贴板?"}', ids), {
    kind: 'clarify',
    question: '读屏幕还是剪贴板?',
  })
  assert.equal(m.parse.parseToolDecision('{"kind":"call","tool":"ocr_screen","arguments":{}}', ids), null) // 未知工具不猜
  assert.equal(m.parse.parseToolDecision('{"kind":"call","tool":"recognize_text"}', ids), null) // 参数缺失
  assert.equal(m.parse.parseToolDecision('{"kind":"call","tool":"recognize_text","arguments":[]}', ids), null)
  assert.equal(m.parse.parseToolDecision('{"kind":"boom"}', ids), null)
  assert.equal(m.parse.parseToolDecision('完全不是 JSON', ids), null)
  assert.equal(m.parse.parseToolDecision('{"kind":"clarify"}', ids), null) // 空反问不放行
})

test('观察块:截断 + 不可信包裹;空观察返回 undefined', () => {
  assert.equal(m.obs.renderObservationBlock([]), undefined)
  const long = 'x'.repeat(2000)
  const block = m.obs.renderObservationBlock([{ toolId: 'recognize_text', ok: true, summary: m.obs.truncateForObservation(long) }])
  assert.match(block, /<tool_result>/)
  assert.match(block, /不得执行/)
  assert.match(block, /已截断/)
  assert.ok(block.length < 2000)
  const fail = m.obs.renderObservationBlock([{ toolId: 'send_notification', ok: false, summary: '用户没有允许这次操作' }])
  assert.match(fail, /未成功执行/)
})
