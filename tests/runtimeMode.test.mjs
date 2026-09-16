// 统一运行态测试:mode 单槽进出与恢复语义、overlays 栈、能力派生。
// 关键不变量:框选/录音是"临时态",结束后必须恢复底下的演出态(演出在遮罩下继续播不能丢)。
import assert from 'node:assert/strict'
import { before, beforeEach, test } from 'node:test'

let rm

before(async () => {
  rm = await import('../src/runtime/runtimeMode.ts')
})


beforeEach(() => {
  rm.setMode({ type: 'idle' })
  rm.closeAllOverlays()
  rm.setDnd(false)
  rm.setCharHidden(false)
})

test('演出中框选截图:结束后恢复演出态(遮罩下继续播)', () => {
  rm.beginPerforming()
  const performing = rm.getRuntime().mode
  rm.beginCapture('save')
  assert.equal(rm.getRuntime().mode.type, 'capturing')
  rm.endCapture()
  assert.deepEqual(rm.getRuntime().mode, performing)
})

test('空闲时框选:结束后回到 idle,不凭空造出演出态', () => {
  rm.beginCapture('translate')
  assert.equal(rm.getRuntime().mode.type, 'capturing')
  rm.endCapture()
  assert.equal(rm.getRuntime().mode.type, 'idle')
})

test('框选期间重复 beginCapture 不覆盖恢复点(嵌套防护)', () => {
  rm.beginPerforming()
  rm.beginCapture('save')
  rm.beginCapture('translate')
  rm.endCapture()
  assert.equal(rm.getRuntime().mode.type, 'performing')
})

test('音色录制同理:结束后恢复底下的演出态', () => {
  rm.beginPerforming()
  rm.beginRecording()
  assert.equal(rm.getRuntime().mode.type, 'recording')
  rm.endRecording()
  assert.equal(rm.getRuntime().mode.type, 'performing')
})

test('overlays 栈:重复打开去重,exclusive 整组替换,Esc 关栈顶', () => {
  rm.openOverlay('settings')
  rm.openOverlay('settings') // 去重
  rm.openOverlay('chat')
  assert.deepEqual(rm.getRuntime().overlays, ['settings', 'chat'])
  assert.equal(rm.getCaps().escapeTarget, 'chat')
  rm.closeOverlay('chat')
  assert.equal(rm.getCaps().escapeTarget, 'settings')
  rm.openOverlayExclusive('tools')
  assert.deepEqual(rm.getRuntime().overlays, ['tools'])
  rm.closeOverlay('settings') // 关不存在的面板是空操作
  assert.deepEqual(rm.getRuntime().overlays, ['tools'])
  rm.closeAllOverlays()
  assert.equal(rm.getCaps().escapeTarget, null)
})

test('mode-menu 参与 overlays 语义:exclusive 整组替换、Esc 关栈顶、关闭后栈清空', () => {
  rm.openOverlayExclusive('mode-menu')
  assert.deepEqual(rm.getRuntime().overlays, ['mode-menu'])
  assert.equal(rm.getCaps().escapeTarget, 'mode-menu')
  // 其他面板经 exclusive 打开会替换掉模式菜单(工具栏上点工具 → 菜单自动关)
  rm.openOverlayExclusive('tools')
  assert.deepEqual(rm.getRuntime().overlays, ['tools'])
  assert.equal(rm.getRuntime().overlays.includes('mode-menu'), false)
  rm.openOverlayExclusive('mode-menu')
  rm.closeAllOverlays()
  assert.equal(rm.getRuntime().overlays.includes('mode-menu'), false)
})

test('caps 派生:主动行为闸门 = 空闲 && 无面板 && 非勿扰', () => {
  assert.equal(rm.getCaps().proactiveAllowed, true)
  rm.openOverlay('chat')
  assert.equal(rm.getCaps().proactiveAllowed, false)
  rm.closeAllOverlays()
  rm.setDnd(true)
  assert.equal(rm.getCaps().proactiveAllowed, false)
  rm.setDnd(false)
  rm.beginPerforming()
  assert.equal(rm.getCaps().proactiveAllowed, false)
  assert.equal(rm.getCaps().canPoke, true) // 演出中可戳走 interrupt
})

test('streaming 占演出态:生成/聊天全不可用', () => {
  rm.beginStreaming()
  assert.equal(rm.getCaps().streaming, true)
  assert.equal(rm.getCaps().canStartPerformance, false)
  assert.equal(rm.getCaps().canChat, false)
})
