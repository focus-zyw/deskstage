// 台词呈现计划的回归测试:气泡在任何首声结果下都必须展示(P1 修复的回归防线)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let planLinePresentation

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ planLinePresentation } = await server.ssrLoadModule('/src/performer/player.ts'))
})

after(async () => {
  await server?.close()
})

test('语音关闭(silent):气泡仍按纯文本估时展示,不误取消 TTS', () => {
  const plan = planLinePresentation('silent', 2800)
  assert.deepEqual(plan, { stopTts: false, textDurationMs: 2800 })
})

test('首声超时(timeout):气泡仍展示,并取消本句 TTS 防迟到语音插入', () => {
  const plan = planLinePresentation('timeout', 2800)
  assert.deepEqual(plan, { stopTts: true, textDurationMs: 2800 })
})

test('正常出声(audible):不取消、不用纯文本估时,交给语音结束驱动', () => {
  const plan = planLinePresentation('audible', 2800)
  assert.deepEqual(plan, { stopTts: false, textDurationMs: null })
})
