// 工具注册表验收:加载真实 5 适配器(Tauri 模块 mock 掉),验证——
// · manifest 形状齐备(id/label/description/risk/schema/超时/缺省开关/呈现);
// · 打分规则:明确命令高分、含糊中分、直播门槛(send_live_message 非直播 0 分);
// · validate 清洗:超长截断、缺参拒绝(安全事实源的两道闸之一)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

let mod

before(async () => {
  globalThis.__toolRegistryMock = { invoke: async () => null }
  mod = await import('../src/tools/registry.ts')
})

after(async () => {
  delete globalThis.__toolRegistryMock
})

const ctx = { isLive: true, phase: 'idle' }

test('注册表形状:十二个工具,id 即键,manifest 齐备', () => {
  const ids = Object.keys(mod.TOOLS)
  assert.deepEqual(
    [...ids].sort(),
    [
      'capture_screen',
      'list_desktop_files',
      'media_control',
      'open_target',
      'read_clipboard',
      'recognize_text',
      'run_app',
      'search_memory',
      'send_live_message',
      'send_notification',
      'set_volume',
      'window_action',
    ],
  )
  for (const t of Object.values(mod.TOOLS)) {
    const m = t.manifest
    assert.ok(m.label && m.description)
    assert.ok(['read', 'local-write', 'external'].includes(m.risk))
    assert.ok(m.inputSchema && typeof m.inputSchema === 'object')
    assert.ok(m.timeoutMs > 0)
    assert.equal(typeof m.defaultEnabled, 'boolean')
    assert.equal(typeof m.match('', ctx), 'number')
    if (m.presentation) assert.ok(['A', 'B', 'C'].includes(m.presentation.actor))
  }
  // 风险分级裁决:read 三件自动,external 两件默认关
  assert.equal(mod.TOOLS.capture_screen.manifest.risk, 'read')
  assert.equal(mod.TOOLS.recognize_text.manifest.risk, 'read')
  assert.equal(mod.TOOLS.search_memory.manifest.risk, 'read')
  assert.equal(mod.TOOLS.send_live_message.manifest.risk, 'external')
  assert.equal(mod.TOOLS.send_live_message.manifest.defaultEnabled, false)
})

test('打分:明确命令高分直达,弱关联挡在候选外,非直播发弹幕 0 分', () => {
  const cap = mod.TOOLS.capture_screen.manifest
  const rec = mod.TOOLS.recognize_text.manifest
  assert.ok(cap.match('帮我截个屏', ctx) >= 0.9)
  assert.ok(cap.match('截屏', ctx) >= 0.9)
  assert.ok(cap.match('今天讲个笑话', ctx) === 0)
  assert.ok(rec.match('看看屏幕上写的什么', ctx) >= 0.7)
  assert.ok(rec.match('提取文字', ctx) >= 0.9)
  const dm = mod.TOOLS.send_live_message.manifest
  assert.equal(dm.match('发个弹幕:大家好', { ...ctx, isLive: false }), 0) // 非直播不候选
  assert.ok(dm.match('发个弹幕:大家好', { ...ctx, isLive: true }) >= 0.9)
})

test('validate:发弹幕 30 字上限截断;识字来源枚举', () => {
  const dm = mod.TOOLS.send_live_message
  const long = dm.validate({ text: 'x'.repeat(50) })
  assert.equal(long.ok, true)
  assert.equal(long.value.text.length, 30) // 截断而非拒绝(明确意图)
  const rec = mod.TOOLS.recognize_text
  assert.equal(rec.validate({ source: 'camera' }).ok, false) // 枚举外拒绝
  assert.equal(rec.validate({ source: 'clipboard' }).value.source, 'clipboard')
})
