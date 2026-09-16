// 聊天短期窗口与 TurnBatch 轻校验回归(P3)。
// 窗口:最近 10 个 turn,超出淘汰最旧;校验:1~3 句、speaker 合法、被@角色首答。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let turnWindow
let llm

before(async () => {
  turnWindow = await import('../src/dialogue/turnWindow.ts')
  llm = await import('../src/engine/llmClient.ts')
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

test('TurnBatch 校验:被@角色必须首答,speaker 只能 A/B/C,硬上限 3 句', () => {
  assert.equal(llm.validateTurnBatch([line('B', '先答')], 'A'), null) // 首答不是被@角色
  assert.ok(llm.validateTurnBatch([line('A', '先答')], 'A'))
  assert.ok(llm.validateTurnBatch([line('A', '先答'), line('B', '补刀')], 'A'))
  assert.equal(llm.validateTurnBatch([line('A', '1'), line('B', '2'), line('A', '3'), line('B', '4')], 'A'), null) // 超 3 句硬上限
  assert.equal(llm.validateTurnBatch([line('C', '先答')], 'A'), null) // 被@的是 A,C 抢首答不行
})

test('TurnBatch 校验:普通消息默认最多 2 句(超出截断),群体提问 maxLines=3', () => {
  const three = [line('A', '先答'), line('B', '补一句'), line('C', '也凑一句')]
  const normal = llm.validateTurnBatch(three, 'A')
  assert.equal(normal.length, 2, '默认截到目标先答+一人补充,第三人不上台')
  assert.equal(normal[0].speaker, 'A')
  assert.equal(normal[1].speaker, 'B')
  assert.equal(llm.validateTurnBatch(three, 'A', { maxLines: 3 }).length, 3, '明确群体提问放开三句')
  assert.equal(llm.validateTurnBatch([line('A', '先答')], 'A', { maxLines: 3 }).length, 1)
})

test('TurnBatch 校验:@C 时 C 首答,三人合法(常驻第三人接入聊天)', () => {
  assert.ok(llm.validateTurnBatch([line('C', '先答')], 'C'))
  assert.ok(llm.validateTurnBatch([line('C', '先答'), line('A', '补刀')], 'C'))
  assert.equal(llm.validateTurnBatch([line('C', '先答'), line('D', '非法角色')], 'C'), null) // D 不在词表
})

test('窗口去重:当前这句观众消息从窗口尾部摘掉,不再双份进 prompt', () => {
  const win = [
    { who: 'user', text: '给我买个礼物' },
    { who: 'A', text: '那你倒是买啊' },
    { who: 'user', text: '我买不起' },
  ]
  const trimmed = llm.windowTrimCurrent(win, '我买不起')
  assert.equal(trimmed.length, 2)
  assert.equal(trimmed.some((t) => t.text === '我买不起'), false)
  // 同一句在中间出现(历史里观众曾说过同样的话)不受影响:只看尾部
  const mid = [
    { who: 'user', text: '我买不起' },
    { who: 'B', text: '那没办法了' },
  ]
  assert.equal(llm.windowTrimCurrent(mid, '我买不起').length, 2)
  // 尾部不是观众、或文本不等:原样返回
  const tailChar = [{ who: 'user', text: '早' }, { who: 'A', text: '早啊' }]
  assert.equal(llm.windowTrimCurrent(tailChar, '早').length, 2)
  assert.equal(llm.windowTrimCurrent(win, '另一句话').length, 3)
  assert.equal(llm.windowTrimCurrent([], '任意').length, 0)
})

test('解围纪律:存在且覆盖关键约束(拉扯两轮必须解围)', () => {
  const d = llm.rescueDiscipline()
  assert.match(d, /解围纪律/)
  assert.match(d, /不得连续重复同一条件/)
  assert.match(d, /最近两轮/)
  assert.match(d, /赊账|虚拟道具|降低条件/)
  assert.match(d, /递台阶/)
  assert.match(d, /绝不要求观众提供现实中无法交给虚拟角色的实物/)
})

test('解围纪律分档:单人版自己换方案,不安排"其他角色递台阶"', () => {
  const solo = llm.soloRescueDiscipline()
  assert.match(solo, /解围纪律/)
  assert.match(solo, /不得连续重复同一条件/)
  assert.match(solo, /赊账|虚拟道具|降低条件/)
  assert.match(solo, /绝不要求观众提供现实中无法交给虚拟角色的实物/)
  assert.doesNotMatch(solo, /递台阶|其他角色/, '单句协议里没有其他角色可调度')
})
