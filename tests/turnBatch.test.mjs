// 聊天短期窗口与 TurnBatch 轻校验回归(P3)。
// 窗口:最近 10 个 turn,超出淘汰最旧;校验:1~3 句、speaker 合法、被@角色首答。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let turnWindow
let llm

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  turnWindow = await server.ssrLoadModule('/src/dialogue/turnWindow.ts')
  llm = await server.ssrLoadModule('/src/engine/llmClient.ts')
})

after(async () => {
  await server?.close()
})

const line = (speaker, text) => ({ speaker, text, action: '' })

test('短期窗口:环形上限 10,超出淘汰最旧;resetChatWindow 清空', () => {
  turnWindow.resetChatWindow()
  for (let i = 1; i <= 12; i++) turnWindow.pushTurn({ who: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'A' : 'B', text: `第${i}句` })
  const win = turnWindow.chatWindow()
  assert.equal(win.length, 10)
  assert.equal(win[0].text, '第3句') // 最旧的两句被淘汰
  assert.equal(win[9].text, '第12句')
  turnWindow.resetChatWindow()
  assert.equal(turnWindow.chatWindow().length, 0)
})

test('短期窗口:空白文本不入列', () => {
  turnWindow.resetChatWindow()
  turnWindow.pushTurn({ who: 'user', text: '   ' })
  assert.equal(turnWindow.chatWindow().length, 0)
})

test('TurnBatch 校验:被@角色必须首答,speaker 只能 A/B/C,最多 3 句', () => {
  assert.equal(llm.validateTurnBatch([line('B', '先答')], 'A'), null) // 首答不是被@角色
  assert.ok(llm.validateTurnBatch([line('A', '先答')], 'A'))
  assert.ok(llm.validateTurnBatch([line('A', '先答'), line('B', '补刀')], 'A'))
  assert.equal(llm.validateTurnBatch([line('A', '1'), line('B', '2'), line('A', '3'), line('B', '4')], 'A'), null) // 超 3 句
  assert.equal(llm.validateTurnBatch([line('C', '先答')], 'A'), null) // 被@的是 A,C 抢首答不行
})

test('TurnBatch 校验:@C 时 C 首答,三人合法(常驻第三人接入聊天)', () => {
  assert.ok(llm.validateTurnBatch([line('C', '先答')], 'C'))
  assert.ok(llm.validateTurnBatch([line('C', '先答'), line('A', '补刀')], 'C'))
  assert.equal(llm.validateTurnBatch([line('C', '先答'), line('D', '非法角色')], 'C'), null) // D 不在词表
})
