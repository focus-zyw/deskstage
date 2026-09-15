// 角色语音关闭时不进入 TTS 生命周期：不请求供应商，也不让诊断面板误报 TTS 分段。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let store
let tts

before(async () => {
  const values = new Map([['vc-config', JSON.stringify({ voice: { enabled: false } })]])
  globalThis.window = globalThis
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  }
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  store = await server.ssrLoadModule('/src/diag/store.ts')
  tts = await server.ssrLoadModule('/src/engine/tts/index.ts')
})

after(async () => server?.close())

test('voice.enabled=false 时诊断不记录 TTS 请求或分段', async () => {
  store.resetDiagForTest()
  const id = store.diag.beginTurn({ id: 'voice-off', source: 'performance', text: 'x' })
  tts.speak('A', '不会合成', undefined, 'performance', { turnId: id, segIndex: 0 })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const events = store.getDiagSnapshot().sessions[0].events.filter((event) => event.kind.startsWith('tts_'))
  assert.deepEqual(events, [])
})
