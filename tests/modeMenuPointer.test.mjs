import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('模式菜单是轻量原生热区，打开时不能恢复全屏 WebView 交互', () => {
  assert.match(
    appSource,
    /const interactivePanelsOpen\s*=\s*rt\.overlays\.some\(\(overlay\)\s*=>\s*overlay\s*!==\s*'mode-menu'\)/,
  )
  assert.match(appSource, /setPanelsOpen\(interactivePanelsOpen\)/)

  const modeMenu = appSource.match(/id:\s*'mode-menu',[\s\S]*?\n\s*},/)?.[0] ?? ''
  assert.match(modeMenu, /nativePointerTarget:/, '菜单选项必须由原生钩子派发点击')

  const outside = appSource.match(/id:\s*'outside',[\s\S]*?\n\s*},/)?.[0] ?? ''
  assert.match(outside, /nativePointerTarget:/, '菜单外点击也不能恢复全屏 WebView 交互')
})
