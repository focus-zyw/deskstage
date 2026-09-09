// 临时诊断第二步:真实填入一条消息并发送,摸清发送链路与回复容器类名
const pageWs = process.argv[2]
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
  const expr = `(async () => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'NO_TEXTAREA';
    const short = (el) => el ? String(el.className).replace(/\\s+/g, ' ').slice(0, 140) : null;
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '你好');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 12000));
    const mds = [...document.querySelectorAll('[class*="markdown"]')];
    return JSON.stringify({
      taValueAfter: ta.value,
      markdownLike: mds.length,
      lastMarkdownClasses: mds.slice(-3).map(short),
      dsMarkdown: document.querySelectorAll('.ds-markdown').length,
      bodyTail: document.body.innerText.slice(-300).replace(/\\n+/g, ' | '),
    });
  })()`
  const res = await new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
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
}, 30000)
