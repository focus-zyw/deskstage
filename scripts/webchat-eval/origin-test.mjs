// 模拟应用主窗口(带 Origin 头)对 CDP 页面 WS 发起 upgrade,看握手是否被拒
import http from 'node:http'
import crypto from 'node:crypto'

const origin = process.argv[2] || 'http://localhost:5173'

async function getPageWs() {
  const res = await fetch('http://127.0.0.1:9223/json/list')
  const tabs = await res.json()
  const tab = tabs.find((t) => t.type === 'page' && (t.url || '').includes('deepseek'))
  return tab?.webSocketDebuggerUrl?.replace('ws://127.0.0.1:9223', '') // -> /devtools/page/<id>
}

const path = await getPageWs()
if (!path) {
  console.log('未找到 deepseek 标签页')
  process.exit(1)
}
console.log('目标路径:', path)

const key = crypto.randomBytes(16).toString('base64')
const req = http.request({
  host: '127.0.0.1',
  port: 9223,
  path,
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
    Origin: origin,
  },
})
req.on('upgrade', () => {
  console.log(`Origin=${origin} → 101 握手成功(白名单生效)`)
  process.exit(0)
})
req.on('response', (res) => {
  console.log(`Origin=${origin} → HTTP ${res.statusCode} 被拒绝`)
  process.exit(0)
})
req.on('error', (e) => {
  console.log('连接错误:', e.message)
  process.exit(1)
})
req.end()
setTimeout(() => {
  console.log('无响应超时')
  process.exit(1)
}, 8000)
