import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('控制栏全部热区使用原生指针，不能把透明 WebView 切成可点击', async () => {
  const source = await readFile(new URL('../src/ui/ControlBar.tsx', import.meta.url), 'utf8')
  const ids = ['grip', 'mode', 'perform', 'tools', 'chat', 'dnd', 'settings']

  for (const id of ids) {
    const registration = source.match(
      new RegExp(`registerHitRegion\\('${id}', \\{([\\s\\S]*?)\\}\\)`),
    )?.[1]
    assert.match(registration ?? '', /nativePointerTarget:/, `${id} 仍会触发整窗交互`)
  }
})
