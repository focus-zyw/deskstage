// 快捷键绑定解析回归测试:锁定 resolveHotkeyBindings 的三条规则——
// 1) 空串跳过(未设置的动作不注册,默认全空配置不占任何系统按键)
// 2) 同组合键先到先得(清单顺序 = 让位顺序,后者视为未设置)
// 3) 与截屏快捷键撞车的让位截屏(截屏已有独立的注册链路,同一键不能双方都抢)
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let resolveHotkeyBindings

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ resolveHotkeyBindings } = await server.ssrLoadModule('/src/hotkeys.ts'))
})

after(async () => {
  await server?.close()
})

const HK = (partial) => ({
  generate: '',
  stop: '',
  replayRandom: '',
  toggleChars: '',
  rateUp: '',
  rateDown: '',
  rateFav: '',
  toggleVoice: '',
  pushToTalk: '',
  ...partial,
})

test('空串跳过:默认全空时解析结果为空,不占任何系统按键', () => {
  assert.deepEqual(resolveHotkeyBindings(HK({}), 'Ctrl+Alt+A'), [])
})

test('正常解析:非空组合键按清单顺序映射到动作', () => {
  const out = resolveHotkeyBindings(
    HK({ generate: 'Ctrl+Alt+G', stop: 'Ctrl+Alt+S' }),
    'Ctrl+Alt+A',
  )
  assert.deepEqual(out, [
    { shortcut: 'CTRL+ALT+G', action: 'generate' },
    { shortcut: 'CTRL+ALT+S', action: 'stop' },
  ])
})

test('同组合键先到先得:清单靠前的动作留下,靠后的视为未设置', () => {
  const out = resolveHotkeyBindings(
    HK({ generate: 'Ctrl+Alt+X', replayRandom: 'ctrl+alt+x' }),
    '',
  )
  assert.deepEqual(out, [{ shortcut: 'CTRL+ALT+X', action: 'generate' }])
})

test('与截屏快捷键撞车的动作让位截屏,其余照常', () => {
  const out = resolveHotkeyBindings(
    HK({ generate: 'Ctrl+Alt+A', stop: 'Ctrl+Alt+S' }),
    'Ctrl+Alt+A',
  )
  assert.deepEqual(out, [{ shortcut: 'CTRL+ALT+S', action: 'stop' }])
})

test('组合键规范化只做去空白与大写,大小写差异视为同一组合', () => {
  const out = resolveHotkeyBindings(
    HK({ generate: 'Ctrl+Alt+G', stop: '  ctrl+alt+g  ' }),
    '',
  )
  assert.deepEqual(out, [{ shortcut: 'CTRL+ALT+G', action: 'generate' }])
})

test('评价动作可绑定:rateUp/rateDown/rateFav 走同一解析与冲突规则', () => {
  const out = resolveHotkeyBindings(
    HK({ rateUp: 'Ctrl+Alt+U', rateFav: 'ctrl+alt+u', rateDown: 'Ctrl+Alt+J' }),
    '',
  )
  // 同组合键先到先得:rateUp 在配置键序中先于 rateFav
  assert.deepEqual(out, [
    { shortcut: 'CTRL+ALT+U', action: 'rateUp' },
    { shortcut: 'CTRL+ALT+J', action: 'rateDown' },
  ])
})

test('语音热键:toggleVoice/pushToTalk 正常解析,同键冲突按清单顺序让位', () => {
  const out = resolveHotkeyBindings(
    HK({ toggleVoice: 'Ctrl+Alt+V', pushToTalk: 'Ctrl+Shift+V' }),
    'Ctrl+Alt+A',
  )
  assert.deepEqual(out, [
    { shortcut: 'CTRL+ALT+V', action: 'toggleVoice' },
    { shortcut: 'CTRL+SHIFT+V', action: 'pushToTalk' },
  ])
  // 清单顺序 = 让位顺序:toggleVoice 在 pushToTalk 之前注册
  const conflict = resolveHotkeyBindings(
    HK({ toggleVoice: 'Ctrl+Alt+H', pushToTalk: 'ctrl+alt+h' }),
    '',
  )
  assert.deepEqual(conflict, [{ shortcut: 'CTRL+ALT+H', action: 'toggleVoice' }])
})
