import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('模式菜单是轻量原生热区，打开时不能恢复全屏 WebView 交互', () => {
  // 轻交互浮层(mode-menu / c-menu)都排除在 interactivePanelsOpen 之外:
  // 打开它们只注册原生热区,绝不把整窗切成可点击(否则底层视频退出硬件合成)
  assert.match(
    appSource,
    /const interactivePanelsOpen\s*=\s*rt\.overlays\.some\([\s\S]*?overlay\s*!==\s*'mode-menu'[\s\S]*?overlay\s*!==\s*'c-menu'[\s\S]*?\)/,
  )
  // 固定(📌)的翻译面板同样不强制整窗交互(固定 = 挂着边看边用,桌面必须可操作)
  assert.match(appSource, /!\(overlay === 'translation' && translationPinnedRef\.current\)/)
  // 只剩固定翻译面板时,全屏「点外部收起」兜底区必须撤掉(否则整窗拦截桌面)
  assert.match(appSource, /active: overlaysOpen && !pinnedTranslationOnly/)
  // 设置窗(独立 WebView)打开期间也要让位:全局钩子按屏幕坐标吞事件,不认光标下
  // 是哪个窗口,设置窗与角色热区重叠时会截胡对设置窗本身的点击/滚轮
  assert.match(appSource, /setPanelsOpen\(interactivePanelsOpen \|\| settingsOpen\)/)

  const modeMenu = appSource.match(/id:\s*'mode-menu',[\s\S]*?\n\s*},/)?.[0] ?? ''
  assert.match(modeMenu, /nativePointerTarget:/, '菜单选项必须由原生钩子派发点击')

  const cMenu = appSource.match(/id:\s*'c-menu',[\s\S]*?\n\s*},/)?.[0] ?? ''
  assert.match(cMenu, /nativePointerTarget:/, 'C 点播菜单也必须由原生钩子派发点击')

  const outside = appSource.match(/id:\s*'outside',[\s\S]*?\n\s*},/)?.[0] ?? ''
  assert.match(outside, /nativePointerTarget:/, '菜单外点击也不能恢复全屏 WebView 交互')
  assert.match(outside, /cMenuOpen/, 'C 菜单打开时,菜单外点击同样走原生钩子')
})
