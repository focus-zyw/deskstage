// 临时诊断第三步:带 focus 的完整发送尝试 + 输出 composer 区域按钮清单
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
    const short = (el) => el ? (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24) + ' :: ' + String(el.className).replace(/\\s+/g, ' ').slice(0, 120) + ' :: disabled=' + (el.disabled ?? el.getAttribute('aria-disabled')) : null;
    const ta = document.querySelector('textarea');
    if (!ta) return 'NO_TEXTAREA';
    const href0 = location.href;
    ta.focus();
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '你好');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 2500));
    const sentByEnter = ta.value === '' || location.href !== href0;
    // 摸 composer 里的按钮(输入框祖先容器内)
    const composer = ta.closest('div[class*="_"]')?.parentElement || ta.parentElement;
    const btns = composer ? [...composer.querySelectorAll('button, [role="button"]')].map(short) : [];
    // 类名/aria 含 send 的候选
    const sendLike = composer ? [...composer.querySelectorAll('button, [role="button"], div')]
      .filter((el) => /send/i.test(String(el.className) + (el.getAttribute('aria-label') ?? '')))
      .map((el) => short(el)) : [];
    return JSON.stringify({
      href0,
      href1: location.href,
      taValueAfterEnter: ta.value,
      sentByEnter,
      composerBtns: btns.slice(0, 8),
      sendLike,
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
