// 临时诊断:连上 CDP,把 DeepSeek 标签页里输入框相关的真实 DOM 摸出来
const pageWs = process.argv[2]
if (!pageWs) {
  console.log('usage: node probe.mjs <webSocketDebuggerUrl>')
  process.exit(1)
}
const ws = new WebSocket(pageWs)
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data))
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error)))
    else p.res(msg.result)
  }
}
ws.onopen = async () => {
  const expr = `(() => {
    const short = (el) => el ? el.outerHTML.replace(/\\s+/g, ' ').slice(0, 300) : null;
    return JSON.stringify({
      href: location.href,
      readyState: document.readyState,
      chatInput: !!document.querySelector('#chat-input'),
      testidInput: !!document.querySelector('textarea[data-testid="chat_input_input"]'),
      textareas: [...document.querySelectorAll('textarea')].slice(0, 3).map(short),
      editables: [...document.querySelectorAll('[contenteditable="true"]')].slice(0, 3).map(short),
      dsMarkdown: document.querySelectorAll('.ds-markdown').length,
      loginHint: short(document.querySelector('[class*="login"], [class*="sign"]')),
    });
  })()`
  const res = await new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  })
  console.log(res?.result?.value)
  ws.close()
  process.exit(0)
}
ws.onerror = () => {
  console.log('WS 连接失败')
  process.exit(1)
}
setTimeout(() => {
  console.log('探测超时')
  process.exit(1)
}, 15000)
