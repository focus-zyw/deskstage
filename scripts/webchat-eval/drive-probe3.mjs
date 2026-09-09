// 实测一轮对话:发送短消息,等回复渲染后,解剖 ds-markdown 各块的用户/助手区分特征
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
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ta = document.querySelector('textarea[name="search"], #chat-input, textarea');
    if (!ta) return 'NO_TEXTAREA';
    ta.focus();
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '用一句话介绍你自己');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await sleep(2000);
    if (ta.value !== '') {
      const circle = document.querySelector('button[class*="ds-button--circle"]:not([class*="disa"])');
      if (circle) circle.click();
      await sleep(2000);
    }
    // 轮询等回复块出现,最多 60 秒
    const t0 = Date.now();
    for (;;) {
      const blocks = [...document.querySelectorAll('.ds-markdown')];
      if (blocks.length >= 2 && Date.now() - t0 > 8000) break;
      if (Date.now() - t0 > 60000) break;
      await sleep(1000);
    }
    return JSON.stringify([...document.querySelectorAll('.ds-markdown')].map((e) => ({
      cls: String(e.className).slice(0, 140),
      text: (e.innerText || '').trim().slice(0, 50),
      parentCls: String(e.parentElement?.className ?? '').slice(0, 110),
      grandCls: String(e.parentElement?.parentElement?.className ?? '').slice(0, 110),
    })), null, 1);
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
}, 90000)
