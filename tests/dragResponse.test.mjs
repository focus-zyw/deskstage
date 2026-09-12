// 拖拽回应池回归:拖拽是布局操作,不是冒犯——
// 1) 三种落地情形都有轻松的一句回应,C 也有小管家专属句
// 2) 文案不出现抱怨/记仇字眼(旧的"欠/清账/捣乱"系全部退役)
// 3) 按关系档位的旧接口 reactBonded 已删除,防止回归
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let rules

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  rules = await server.ssrLoadModule('/src/engine/interactionRules.ts')
})

after(async () => {
  await server?.close()
})

test('三种落地情形都有非空的轻松回应', () => {
  for (const kind of ['close', 'far', 'overlap']) {
    const line = rules.dragDropLine(kind)
    assert.ok(line && line.length > 0, `${kind} 应有回应文案`)
  }
  assert.ok(rules.dragDropLineC().length > 0)
})

test('回应文案不出现抱怨/记仇字眼', () => {
  for (const kind of ['close', 'far', 'overlap']) {
    for (let i = 0; i < 10; i++) {
      const line = rules.dragDropLine(kind)
      assert.doesNotMatch(line, /欠|清账|记仇|捣乱|惩罚|滚/)
    }
  }
})

test('旧接口 reactBonded 已删除(按关系档位的拖拽文案整体退役)', () => {
  assert.equal('reactBonded' in rules, false)
})
