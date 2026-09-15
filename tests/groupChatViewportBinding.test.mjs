import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('群聊消息流绑定滚动 ref，打开时才能执行消息定位', async () => {
  const source = await readFile(
    new URL('../src/settings/tabs/ChatLogSettings.tsx', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /<div\s*\n\s*ref=\{feedRef\}\s*\n\s*className="chatlog-feed"/,
    'chatlog-feed 未绑定 feedRef，scroll-bottom/scroll-message 会静默失效',
  )
})
