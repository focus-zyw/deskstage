// OCR 连败熔断回归:AI 免费档经常失效(429/超时),连败 2 次即进入 10 分钟冷却,
// 期间不再反复白等超时——直接本地识别;冷却结束放行探测,成功即复位。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let ocr

before(async () => {
  ocr = await import('../src/translation/ocr.ts')
})


const T0 = 1_700_000_000_000

test('单次失败只计数,不熔断', () => {
  assert.equal(ocr.aiBreakerShouldTry(T0), true)
  assert.equal(ocr.aiBreakerOnFailure(T0), 'counting')
  assert.equal(ocr.aiBreakerShouldTry(T0 + 1), true) // 仍尝试 AI
})

test('连败 2 次进入冷却:冷却期内不再尝试,到期放行探测', () => {
  assert.equal(ocr.aiBreakerOnFailure(T0), 'tripped') // 第二次失败触发
  assert.equal(ocr.aiBreakerShouldTry(T0 + 1), false)
  assert.equal(ocr.aiBreakerShouldTry(T0 + 10 * 60_000 - 1), false) // 冷却未满不放行
  assert.equal(ocr.aiBreakerShouldTry(T0 + 10 * 60_000), true) // 到期放行探测
})

test('成功复位熔断;复位后再单败从零计数', () => {
  ocr.aiBreakerOnSuccess()
  assert.equal(ocr.aiBreakerShouldTry(T0), true)
  assert.equal(ocr.aiBreakerOnFailure(T0), 'counting') // 复位后单败只计数
  assert.equal(ocr.aiBreakerShouldTry(T0 + 1), true)
})
