// 主按钮状态纯函数回归测试:RuntimeMode → 按钮 label/kind/disabled 的映射表全锁。
// 合并播放/停止按钮后的不变量:生成中必须能停止(kind=stop),工具占用必须禁用。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let performanceButton

before(async () => {
  ;({ performanceButton } = await import('../src/ui/performButton.ts'))
})


test('idle + 普通模式:开始一段(generate)', () => {
  assert.deepEqual(performanceButton('idle'), {
    label: '开始一段',
    kind: 'generate',
    disabled: false,
    title: '开始一段(按当前模式点播)',
  })
})

test('idle-live:开播(generate)', () => {
  const v = performanceButton('idle-live')
  assert.equal(v.label, '开播')
  assert.equal(v.kind, 'generate')
  assert.equal(v.disabled, false)
})

test('generating:取消生成(stop,不禁用)——生成中必须能停止', () => {
  const v = performanceButton('generating')
  assert.equal(v.label, '取消生成')
  assert.equal(v.kind, 'stop')
  assert.equal(v.disabled, false)
})

test('performing 与 choosing:停止演出(stop)', () => {
  for (const state of ['performing', 'choosing']) {
    const v = performanceButton(state)
    assert.equal(v.label, '停止演出')
    assert.equal(v.kind, 'stop')
    assert.equal(v.disabled, false)
  }
})

test('streaming:下播(stop)', () => {
  const v = performanceButton('streaming')
  assert.equal(v.label, '下播')
  assert.equal(v.kind, 'stop')
  assert.equal(v.disabled, false)
})

test('locked(截屏/录音占用):禁用', () => {
  const v = performanceButton('locked')
  assert.equal(v.disabled, true)
  assert.equal(v.kind, 'stop')
})
