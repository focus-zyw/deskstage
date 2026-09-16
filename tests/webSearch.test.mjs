// 聊天联网搜索(方案 docs/联网搜索设计方案.md):
// 传输判定谓词(智谱/DeepSeek/自定义端点)/ Responses 请求体与响应提取 /
// actorPrompt webLine 注入(两种形态都带)/ 配置字段清洗。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let ws
let prompt
let configStore

before(async () => {
  ws = await import('../src/engine/webSearch.ts')
  prompt = await import('../src/groupChat/actorPrompt.ts')
  configStore = await import('../src/storage/configStore.ts')
})

// ---------- 传输判定 ----------

test('传输判定:智谱走 chat tools,DeepSeek 走 Responses,其他一律不支持', () => {
  assert.equal(ws.webSearchTransportOf('https://open.bigmodel.cn/api/paas/v4'), 'zhipu-tools')
  assert.equal(ws.webSearchTransportOf('https://api.deepseek.com/v1'), 'deepseek-responses')
  assert.equal(ws.webSearchTransportOf('https://api.deepseek.com'), 'deepseek-responses')
  // 子域伪造不通过:host 必须是指定域本身或其子域
  assert.equal(ws.webSearchTransportOf('https://bigmodel.cn.evil.example.com/v1'), null)
  assert.equal(ws.webSearchTransportOf('http://127.0.0.1:8080/v1'), null)
  assert.equal(ws.webSearchTransportOf('https://api.deepseek.com.evil.example/v1'), null)
  assert.equal(ws.webSearchTransportOf(''), null)
  assert.equal(ws.webSearchTransportOf('不是网址'), null)
})

test('联网总闸:开关开 + 端点支持才算开;开关关/端点不支持都是关', () => {
  assert.equal(
    ws.webSearchOnOf({ webSearch: true, baseUrl: 'https://api.deepseek.com/v1' }),
    true,
  )
  assert.equal(ws.webSearchOnOf({ webSearch: true, baseUrl: 'http://localhost:11434/v1' }), false)
  assert.equal(
    ws.webSearchOnOf({ webSearch: false, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }),
    false,
  )
  assert.equal(ws.webSearchOnOf({ baseUrl: 'https://api.deepseek.com/v1' }), false)
})

// ---------- Responses 请求体与响应提取 ----------

test('Responses 请求体:system 并入 instructions,tools 仅联网档携带', () => {
  const messages = [
    { role: 'system', content: '人设A' },
    { role: 'user', content: '今天天气' },
  ]
  const on = JSON.parse(ws.buildResponsesBody('deepseek-v4-flash', messages, { temperature: 1, webSearch: true }))
  assert.equal(on.instructions, '人设A')
  assert.deepEqual(on.input, [{ role: 'user', content: '今天天气' }])
  assert.deepEqual(on.tools, [{ type: 'web_search' }])
  assert.equal(on.tool_choice, 'auto')
  assert.equal(on.max_output_tokens, 4096, '联网档固定 4096:小预算会被检索结果挤截')
  assert.equal(on.stream, false)
  const off = JSON.parse(ws.buildResponsesBody('deepseek-v4-flash', messages, { temperature: 1, webSearch: false }))
  assert.equal('tools' in off, false)
  assert.equal('tool_choice' in off, false)
})

test('Responses 响应提取:output_text 直取;output 数组拼 message 内容;剥 think', () => {
  assert.equal(ws.extractResponsesText({ output_text: '答案' }), '答案')
  assert.equal(
    ws.extractResponsesText({
      output: [
        { type: 'reasoning' },
        { type: 'message', content: [{ type: 'output_text', text: '今' }] },
        { type: 'message', content: [{ type: 'output_text', text: '天晴' }] },
      ],
    }),
    '今天晴',
  )
  assert.equal(ws.extractResponsesText({}), '')
  assert.equal(ws.extractResponsesText(null), '')
  assert.equal(ws.stripThinkBlocks('<think>推理</think>正文'), '正文')
  assert.equal(ws.stripThinkBlocks('<think>未闭合'), '')
})

// ---------- actorPrompt 注入 ----------

const identity = {
  actor: 'A',
  names: { A: '甲', B: '乙', C: '丙' },
  persona: '人设',
  rosterLine: '乙(speaker "B")',
  userName: '店长',
  direct: true,
}
const baseInput = () => ({
  actor: 'A',
  batch: { id: 'b1', throughSeq: 3, messages: [{ id: 'm1', kind: 'chat', author: 'user', text: 'hi', createdAt: 1, causalRootId: 'm1', depth: 0, replyTo: [], roomSeq: 1, epoch: 1 }] },
  recentContext: [],
  maySpeak: true,
  remainingReplies: null,
  fullContext: true,
})

test('webLine 注入:单聊与群聊两种形态的 system 都携带;缺省不出现', () => {
  const direct = prompt.buildReactionMessages(identity, { ...baseInput(), webLine: ws.WEB_SEARCH_LINE })
  assert.match(direct[0].content, /联网搜索已开启/)
  const group = prompt.buildReactionMessages({ ...identity, direct: false }, { ...baseInput(), webLine: ws.WEB_SEARCH_LINE })
  assert.match(group[0].content, /联网搜索已开启/)
  const plain = prompt.buildReactionMessages(identity, baseInput())
  assert.ok(!String(plain[0].content).includes('联网搜索'), '未开启时规则行绝不出现(不许诺搜不到的能力)')
})

test('webLine 常驻网页增量轮(fullContext=false 也带)', () => {
  const inc = prompt.buildReactionMessages(identity, { ...baseInput(), fullContext: false, webLine: ws.WEB_SEARCH_LINE })
  assert.match(inc[0].content, /联网搜索已开启/)
})

// ---------- 配置清洗 ----------

test('config 清洗:webSearch 只认布尔 true,缺省回落 false', () => {
  const cfg = configStore.sanitizeConfig({})
  assert.equal(cfg.webSearch, false)
  const on = configStore.sanitizeConfig({ webSearch: true })
  assert.equal(on.webSearch, true)
  const weird = configStore.sanitizeConfig({ webSearch: 'yes' })
  assert.equal(weird.webSearch, false)
  const partial = configStore.sanitizePartial({ webSearch: true })
  assert.deepEqual(partial, { webSearch: true })
})
