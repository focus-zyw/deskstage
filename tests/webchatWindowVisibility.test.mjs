import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('打开网页模型登录窗口不得隐藏主角色窗口', async () => {
  const source = await readFile(new URL('../src-tauri/src/webchat.rs', import.meta.url), 'utf8')
  const start = source.indexOf('pub async fn webchat_login(')
  const end = source.indexOf('// ---------- 就绪探测', start)
  assert.ok(start >= 0 && end > start, '应能定位 webchat_login 命令')
  const loginCommand = source.slice(start, end)
  assert.doesNotMatch(
    loginCommand,
    /show_main\(&app,\s*false\)/,
    '连接 ChatGPT 等站点时，角色窗口必须继续显示',
  )
})
