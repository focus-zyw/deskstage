// 角色语音关闭时不进入 TTS 生命周期：不请求供应商，也不让诊断面板误报 TTS 分段。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

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
  store = await import('../src/diag/store.ts')
  tts = await import('../src/engine/tts/index.ts')
})


test('voice.enabled=false 时诊断不记录 TTS 请求或分段', async () => {
  store.resetDiagForTest()
  const id = store.diag.beginTurn({ id: 'voice-off', source: 'performance', text: 'x' })
  tts.speak('A', '不会合成', undefined, 'performance', { turnId: id, segIndex: 0 })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const events = store.getDiagSnapshot().sessions[0].events.filter((event) => event.kind.startsWith('tts_'))
  assert.deepEqual(events, [])
})
