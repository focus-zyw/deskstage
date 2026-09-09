// 网页版生成通道 · CDP 客户端(Plan B)。
// 应用内嵌第二 WebView2 在本机渲染层损坏(详见 src-tauri/src/webchat.rs 头注释),
// 改为遥控系统 Edge:Rust 拉起 Edge(独立 profile + --remote-debugging-port=9223),
// 本文件经 CDP 开标签页、在页面里执行驱动函数(填 prompt/点发送/抓回复)拿回文本。
//
// 与嵌入 WebView 时代的差异:不需要回环中继(Runtime.evaluate 直接返回值),
// 每轮生成一个新标签页(等价新会话,无历史污染),用完即关。
import { invoke } from '@tauri-apps/api/core'
import { fetch as rustFetch } from '@tauri-apps/plugin-http'
import { getConfig, inTauri } from '../storage/configStore'

export type WebchatSite = 'deepseek' | 'doubao'

export const WEBCHAT_SITES: { id: WebchatSite; label: string }[] = [
  { id: 'deepseek', label: 'DeepSeek 网页版' },
  { id: 'doubao', label: '豆包网页版' },
]

const CDP_PORT = 9223 // 与 webchat.rs 的 CDP_PORT 保持一致
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`

const SITE_URLS: Record<WebchatSite, string> = {
  deepseek: 'https://chat.deepseek.com/',
  doubao: 'https://www.doubao.com/chat/',
}

const SITE_HOSTS: Record<WebchatSite, string> = {
  deepseek: 'chat.deepseek.com',
  doubao: 'www.doubao.com',
}

/** 网页聊天没有 system role:合并成单条文本注入(与手动验证测试包同款拼法) */
export function mergeMessages(messages: { role: string; content: string }[]): string {
  return messages.map((m) => m.content).join('\n\n')
}

/** 页面内驱动函数源码:经 Runtime.evaluate(awaitPromise)在 Edge 标签页里执行。
 *  选择器按 2026-09 实测校准(经 CDP 探针验证):DeepSeek 的 #chat-input 已废弃,
 *  现为无 id 的唯一 textarea(name="search",placeholder"给 DeepSeek 发送消息"),
 *  回复容器仍是 .ds-markdown;发送必须先 focus 再派发 Enter。站点改版改 PROFILES 一处。 */
const DRIVE_JS = `async (prompt, timeoutMs) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PROFILES = [
    { name: 'deepseek', inputs: ['#chat-input', 'textarea[name="search"]', 'textarea'], replies: '.ds-markdown', sendBtn: null },
    { name: 'doubao', inputs: ['textarea[data-testid="chat_input_input"]', 'textarea'], replies: '[data-testid="receive_message"]', sendBtn: '[data-testid="chat_input_send_button"]' }
  ];
  const findProfile = () => {
    for (const p of PROFILES) {
      for (const sel of p.inputs) {
        const el = document.querySelector(sel);
        if (el) return { p, el };
      }
    }
    return null;
  };
  const setInput = (el, text) => {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    } else {
      el.textContent = '';
      document.execCommand('insertText', false, text);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const clickSend = (p, el) => {
    if (p.sendBtn) {
      const btn = document.querySelector(p.sendBtn);
      if (btn && !btn.disabled && btn.getAttribute('disabled') == null && btn.getAttribute('aria-disabled') !== 'true') { btn.click(); return; }
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  };
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    for (;;) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      if (Date.now() - t0 > ms) return null;
      await sleep(500);
    }
  };
  // 等页面真正加载完(刚开的标签页可能还在导航/水合,早填的值会被清掉)
  await waitFor(() => (document.readyState === 'complete' ? true : null), 20000);
  const found = await waitFor(findProfile, 45000);
  if (!found) return { ok: false, text: '页面上找不到输入框(可能未登录,或站点改版需更新选择器)' };
  // 填入并校验"粘住":标签页刚开时 React 可能尚未接管,早填的值会被清掉,重试 + execCommand 兜底
  let setOk = false;
  for (let i = 0; i < 4 && !setOk; i++) {
    setInput(found.el, prompt);
    await sleep(350);
    setOk = found.el.value === prompt;
  }
  if (!setOk) {
    found.el.focus();
    document.execCommand('insertText', false, prompt);
    await sleep(300);
    setOk = found.el.value === prompt;
  }
  if (!setOk) return { ok: false, text: '提示词未能写入输入框(站点可能改版)' };
  // 发送:Enter 后校验已清空;没清空就点圆形主按钮(DeepSeek 的发送钮)兜底
  found.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  await sleep(1200);
  if (found.el.value !== '') {
    const circle = document.querySelector('button[class*="ds-button--circle"]:not([class*="disa"])');
    if (circle) circle.click();
    await sleep(1200);
  }
  if (found.el.value !== '') return { ok: false, text: '已填入但发送失败(站点可能改版)' };
  const base = document.querySelectorAll(found.p.replies).length;
  const grab = () => {
    const blocks = document.querySelectorAll(found.p.replies);
    const last = blocks.length > base ? blocks[blocks.length - 1] : null;
    return last ? String(last.innerText || '').trim() : '';
  };
  let lastText = '';
  let lastChange = Date.now();
  const t0 = lastChange;
  for (;;) {
    const text = grab();
    if (text && text !== lastText) { lastText = text; lastChange = Date.now(); }
    if (lastText && Date.now() - lastChange >= 4000) return { ok: true, text: lastText };
    if (Date.now() - t0 >= timeoutMs) return { ok: false, text: '网页生成超时' };
    await new Promise((r) => setTimeout(r, 600));
  }
}`

/** 就绪检查表达式:输入框可见即可发消息(未登录站点通常没有输入框)。
 *  与 DRIVE_JS 的 PROFILES 输入选择器保持同源 */
const READY_JS = `(() => {
  const sels = ['#chat-input', 'textarea[name="search"]', 'textarea[data-testid="chat_input_input"]', 'textarea'];
  return sels.some((s) => !!document.querySelector(s));
})()`

// ---------- CDP 连接 ----------

class CdpConn {
  private ws: WebSocket
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl)
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number
        error?: { message?: string }
        result?: unknown
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
    }
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
    })
  }

  call(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* 已断 */
    }
  }
}

async function cdpAlive(): Promise<boolean> {
  try {
    const r = await rustFetch(`${CDP_BASE}/json/version`)
    return r.ok
  } catch {
    return false
  }
}

/** Edge 没跑就拉起,并等调试端口就绪。
 *  若实例在跑但 WS 被拒(旧实例没带 --remote-allow-origins),自动杀掉带新参数重启 */
async function ensureEdge(site: WebchatSite): Promise<void> {
  if (await cdpAlive()) {
    if (await wsAttachable()) return
    await invoke('webchat_edge_kill').catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
  }
  await invoke('webchat_edge_launch', { url: SITE_URLS[site] })
  const t0 = Date.now()
  while (Date.now() - t0 < 20_000) {
    if (await cdpAlive()) {
      if (await wsAttachable()) return
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  throw new Error('Edge 调试通道 20 秒未就绪')
}

/** 探测应用页面能否真正 attach 到标签页 WS(Chromium 111+ 会 403 拒绝带 Origin 的连接) */
async function wsAttachable(): Promise<boolean> {
  try {
    const res = await rustFetch(`${CDP_BASE}/json/list`)
    if (!res.ok) return false
    const tabs = (await res.json()) as { webSocketDebuggerUrl?: string }[]
    const tab = tabs.find((t) => t.webSocketDebuggerUrl)
    if (!tab?.webSocketDebuggerUrl) return true // 没有可连目标时先放行
    const c = new CdpConn(tab.webSocketDebuggerUrl)
    await c.open()
    c.close()
    return true
  } catch {
    return false
  }
}

/** 开一个新标签页(等价新会话),返回 target。
 *  注意:/json/new 不解析 URL 编码,query 必须是原始 URL(与 Puppeteer 同款做法),
 *  编码后 Edge 会导航到字面量字符串并落在 about:blank */
async function newTab(url: string): Promise<{ id: string; wsUrl: string }> {
  const target = `${CDP_BASE}/json/new?${url}`
  let res = await rustFetch(target, { method: 'PUT' })
  if (!res.ok) res = await rustFetch(target) // 旧版内核只认 GET
  if (!res.ok) throw new Error(`打开 CDP 标签页失败: HTTP ${res.status}`)
  const t = (await res.json()) as { id: string; webSocketDebuggerUrl?: string }
  return { id: t.id, wsUrl: t.webSocketDebuggerUrl ?? `ws://127.0.0.1:${CDP_PORT}/devtools/page/${t.id}` }
}

async function closeTab(targetId: string): Promise<void> {
  try {
    const ver = (await (await rustFetch(`${CDP_BASE}/json/version`)).json()) as {
      webSocketDebuggerUrl?: string
    }
    if (!ver.webSocketDebuggerUrl) return
    const browser = new CdpConn(ver.webSocketDebuggerUrl)
    await browser.open()
    await browser.call('Target.closeTarget', { targetId }, 5000).catch(() => {})
    browser.close()
  } catch {
    /* 关不掉就留着,不影响正确性 */
  }
}

// ---------- 对外接口 ----------

/** 一轮网页生成:整段 prompt 进,网页模型原始回复出(与嵌入版签名一致) */
export async function webchatAsk(
  prompt: string,
  signal?: AbortSignal,
  timeoutMs = 180_000,
): Promise<string> {
  if (!inTauri) throw new Error('网页版生成仅桌面端可用')
  if (signal?.aborted) throw new DOMException('已中止', 'AbortError')
  const cfg = await getConfig()
  const site = cfg.webchatSite
  await ensureEdge(site)
  const tab = await newTab(SITE_URLS[site])
  const cdp = new CdpConn(tab.wsUrl)

  let onAbort: () => void = () => {}
  const abortPromise = new Promise<never>((_, rej) => {
    onAbort = () => {
      cdp.close()
      void closeTab(tab.id)
      rej(new DOMException('已中止', 'AbortError'))
    }
  })
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await cdp.open()
    // 等目标从 about:blank 导航到站点并稳定:导航会销毁旧执行上下文,过早执行
    // 驱动会随上下文一起被销毁。以 https 页面为稳定标志,约 30 秒上界
    for (let i = 0; i < 30; i++) {
      try {
        const probe = (await cdp.call(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true },
          5000,
        )) as { result?: { value?: string } }
        if ((probe?.result?.value ?? '').startsWith('https://')) break
      } catch {
        /* 上下文随导航销毁,属预期,稍后重试 */
      }
      await new Promise((r) => setTimeout(r, 800))
    }
    const expr = `(${DRIVE_JS})(${JSON.stringify(prompt)}, ${timeoutMs})`
    const raced = await Promise.race([
      cdp.call(
        'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true },
        timeoutMs + 15_000,
      ),
      abortPromise,
    ])
    const value = (raced as { result?: { value?: { ok?: boolean; text?: string } } })?.result?.value
    if (!value) throw new Error('驱动函数没有返回结果')
    if (!value.ok) throw new Error(value.text || '网页生成失败')
    return value.text ?? ''
  } finally {
    signal?.removeEventListener('abort', onAbort)
    cdp.close()
    void closeTab(tab.id)
  }
}

/** 打开可见的 Edge 窗口给用户登录(隐藏主覆盖层让路);就绪轮询由设置面板负责。
 *  先杀旧实例再启动,保证 --remote-allow-origins 等新参数生效 */
export async function webchatLogin(site: WebchatSite): Promise<void> {
  await invoke('webchat_edge_kill').catch(() => {})
  await new Promise((r) => setTimeout(r, 1200))
  await invoke('webchat_edge_launch', { url: SITE_URLS[site] })
  await invoke('webchat_main_visible', { show: false })
}

/** 逐级探测目标站点可否发消息,detail 说明断点位置(未就绪时展示给用户/排查用) */
export async function webchatProbe(): Promise<{ ready: boolean; detail: string }> {
  if (!inTauri) return { ready: false, detail: '非桌面端' }
  if (!(await cdpAlive())) return { ready: false, detail: '连不上 Edge 调试端口(9223):Edge 未启动或端口不对' }
  const cfg = await getConfig()
  const host = SITE_HOSTS[cfg.webchatSite]
  let tabs: { url?: string; webSocketDebuggerUrl?: string }[]
  try {
    const res = await rustFetch(`${CDP_BASE}/json/list`)
    if (!res.ok) return { ready: false, detail: `拉取标签页列表失败: HTTP ${res.status}` }
    tabs = (await res.json()) as { url?: string; webSocketDebuggerUrl?: string }[]
  } catch (e) {
    return { ready: false, detail: `拉取标签页列表异常: ${String(e)}` }
  }
  const tab = [...tabs].reverse().find((t) => (t.url ?? '').includes(host))
  if (!tab?.webSocketDebuggerUrl) return { ready: false, detail: 'Edge 里没有目标站点标签页' }
  const cdp = new CdpConn(tab.webSocketDebuggerUrl)
  try {
    await cdp.open()
    const r = (await cdp.call(
      'Runtime.evaluate',
      { expression: READY_JS, returnByValue: true },
      8000,
    )) as { result?: { value?: boolean } }
    const ok = r?.result?.value === true
    if (ok) await invoke('webchat_main_visible', { show: true })
    return {
      ready: ok,
      detail: ok ? '已就绪' : '输入框未出现(未登录,或站点改版需更新选择器)',
    }
  } catch (e) {
    return { ready: false, detail: `附加到页面失败: ${String(e)}` }
  } finally {
    cdp.close()
  }
}

/** 查询目标站点是否可发消息(已登录且选择器命中);顺手恢复主覆盖层 */
export async function webchatReady(): Promise<boolean> {
  return (await webchatProbe()).ready
}

/** 手动恢复主覆盖层(角色回屏) */
export async function webchatRestoreMain(): Promise<void> {
  await invoke('webchat_main_visible', { show: true })
}
