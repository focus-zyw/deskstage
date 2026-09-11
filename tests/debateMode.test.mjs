// 辩论模式注册表回归:注册可查、prompt 注入、自然语言路由命中。
// 沿用仓库测试原则:依赖注入、不碰网络与磁盘(vite ssrLoadModule 直载 TS 源码)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let MODES
let modeOf
let buildMessages
let nlRoute

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ MODES, modeOf } = await server.ssrLoadModule('/src/performer/modes/index.ts'))
  ;({ buildMessages } = await server.ssrLoadModule('/src/engine/promptBuilder.ts'))
  ;({ nlRoute } = await server.ssrLoadModule('/src/features/commands/commands.ts'))
})

after(async () => {
  await server?.close()
})

test('debate 已注册:id/label/prompt/兜底剧本完整', () => {
  assert.equal(MODES.debate.id, 'debate')
  assert.equal(MODES.debate.label, '辩论')
  assert.ok(MODES.debate.prompt.includes('辩论'))
  assert.ok(MODES.debate.script.length >= 2)
  assert.ok(typeof MODES.debate.gap === 'number' && MODES.debate.gap > 0)
})

test('modeOf 认识 debate;未知 id 仍回退日常', () => {
  assert.equal(modeOf('debate').id, 'debate')
  assert.equal(modeOf('no-such-mode').id, 'daily')
})

test('buildMessages 注入辩论编剧指令', () => {
  const messages = buildMessages(
    'debate',
    '熬夜算不算自由',
    [],
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  )
  const joined = messages.map((m) => m.content).join('\n')
  assert.match(joined, /辩论/)
  assert.match(joined, /正方|反方/)
})

test('自然语言"来一段关于XX的辩论"路由到 debate 并抽出话题', async () => {
  const route = await nlRoute('来一段关于熬夜的辩论', [])
  assert.equal(route.kind, 'perform')
  assert.equal(route.mode, 'debate')
  assert.equal(route.topic, '熬夜')
})
