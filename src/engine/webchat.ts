// 网页版生成通道 · CDP 客户端(Plan B)。
// 应用内嵌第二 WebView2 在本机渲染层损坏(详见 src-tauri/src/webchat.rs 头注释),
// 改为遥控系统 Edge:Rust 拉起 Edge(独立 profile + --remote-debugging-port=9223),
// 本文件经 CDP 驱动页面:填 prompt → 发送 → 抓回复。
//
// 发送与收回复的逻辑移植自 D:/web-tool 的浏览器扩展(content/runtime.js,
// 经实战校验),关键点:
//   · 复用常驻站点标签页,不新增标签页(会话内发送为纯 SPA,无跨页导航)
//   · 发送优先点发送按钮(aria-label 发送/Send message),Enter 兜底
//   · 完成判定 = 至少见过一次"生成中"(停止按钮可见)且当前不忙、文本
//     非思考态、非 JSON 截断、并稳定 2.5 秒
//   · 回复读取剥掉思考块与工具栏按钮,outermost 去嵌套重复
// 选择器为 2026-09 时点快照,站点改版只需改各 JS 顶部的选择器常量。
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

// ---------- 页面内共享 JS 片段(移植自 web-tool content/runtime.js + read-utils.js) ----------

// 可见性 + 去嵌套:所有驱动/抓取的基础
const UTILS_JS = `
  const visible = (el) => {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  const outermost = (nodes) => nodes.filter((n) => !nodes.some((o) => o !== n && n.contains(o)));
`

// 助手回复根节点(web-tool deepseek 适配器的 messageRoots)
const ROOT_SELS_JS = `[
  '[data-message-author-role="assistant"]',
  '.ds-message',
  '[class*="ds-assistant"]',
  '.ds-markdown',
]`

/** 发送阶段:填 prompt 并优先点发送按钮,Enter 兜底;返回发送前的回复根数量/文本
 *  (供应用侧判定"回复区增长了")。若执行中页面跳转,evaluate 随上下文销毁报错,
 *  调用方把这类错误视为"已发出"。 */
const SEND_JS = `async (prompt) => {
  ${UTILS_JS}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const roots = () => outermost(
    ${ROOT_SELS_JS}.flatMap((s) => [...document.querySelectorAll(s)]).filter(visible)
  );
  const beforeRoots = roots();
  const beforeCount = beforeRoots.length;
  const beforeText = beforeRoots.length ? (beforeRoots[beforeRoots.length - 1].innerText || '').trim() : '';
  const composerSels = [
    '#chat-input',
    'textarea[name="search"]',
    'textarea[data-testid="chat_input_input"]',
    'textarea',
    'div[contenteditable][role="textbox"]',
  ];
  const sendBtnSels = [
    'button[aria-label="Send message"]',
    'button[aria-label*="发送"]',
    '[data-testid="send-button"]',
  ];
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    for (;;) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      if (Date.now() - t0 > ms) return null;
      await sleep(500);
    }
  };
  await waitFor(() => (document.readyState === 'complete' ? true : null), 20000);
  let ta = null;
  for (const s of composerSels) {
    const el = document.querySelector(s);
    if (el && visible(el)) { ta = el; break; }
  }
  if (!ta) ta = await waitFor(() => composerSels.map((s) => document.querySelector(s)).find(visible) || null, 45000);
  if (!ta) return { sent: false, why: '页面上找不到输入框(可能未登录,或站点改版需更新选择器)', beforeCount, beforeText };
  const setInput = (el, text) => {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = '';
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  let setOk = false;
  for (let i = 0; i < 5 && !setOk; i++) {
    setInput(ta, prompt);
    await sleep(400);
    setOk = ta.value === prompt;
  }
  if (!setOk) return { sent: false, why: '提示词未能写入输入框(站点可能改版)', beforeCount, beforeText };
  // 优先点发送按钮(与 web-tool 一致),Enter 兜底
  let sendBtn = null;
  for (const s of sendBtnSels) {
    const b = document.querySelector(s);
    if (b && visible(b) && !b.disabled) { sendBtn = b; break; }
  }
  if (sendBtn) sendBtn.click();
  else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  await sleep(1500);
  if (ta.value !== '' && document.contains(ta)) {
    const circle = document.querySelector('button[class*="ds-button--circle"]:not([class*="disa"])');
    if (circle) circle.click();
    await sleep(1500);
  }
  const sent = ta.value === '' || !document.contains(ta);
  return { sent, why: sent ? '' : '已填入但发送失败', beforeCount, beforeText };
}`

/** 快照阶段:无状态读取"最后一个回复根"的 {count,busy,text,truncated,turnError}。
 *  上下文被导航销毁后重连即可继续,不依赖任何页面内遗留状态。 */
const SNAP_JS = `(head) => {
  ${UTILS_JS}
  const stripThinking = (el) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[class*="ds-think"], [class*="think-content"], [class*="thinking"], [data-think], details').forEach((n) => n.remove());
    clone.querySelectorAll('.ds-markdown, .markdown, .markdown-body, details').forEach((n) => {
      if (n === clone) return;
      const start = (n.innerText || '').trim().slice(0, 24);
      if (/^(思考中|已深度思考|思考过程|Thought for|Thinking…|Thinking\\.\\.\\.)/i.test(start)) n.remove();
    });
    clone.querySelectorAll('button, [role="button"]').forEach((n) => n.remove());
    return clone;
  };
  const allRoots = [];
  for (const s of ${ROOT_SELS_JS}) {
    document.querySelectorAll(s).forEach((n) => {
      if (visible(n) && !allRoots.includes(n)) allRoots.push(n);
    });
  }
  const roots = outermost(allRoots);
  roots.sort((a, b) => (a.compareDocumentPosition(b) & 2 ? 1 : -1));
  const stop = [...document.querySelectorAll('button')].find(
    (b) => visible(b) && /stop|停止/i.test(b.getAttribute('aria-label') || '')
  );
  const last = roots[roots.length - 1] || null;
  const busy = !!stop || /思考中|正在思考|深度思考中/.test((last?.innerText || '').slice(0, 80));
  let text = '';
  let truncated = false;
  if (last) {
    text = (stripThinking(last).innerText || '').trim();
    // 过滤自己的提问气泡(prompt 头 20 字即足以识别回显)
    if (head && (text === head || text.startsWith(head.slice(0, 20)))) text = '';
  }
  if (text) {
    const t = text.trimEnd();
    if (/[{[,:]$/.test(t)) truncated = true;
    const lastLine = t.split('\\n').pop().trim();
    if (lastLine.startsWith('{') && !lastLine.endsWith('}')) truncated = true;
    if (lastLine.startsWith('[') && !lastLine.endsWith(']')) truncated = true;
  }
  const turnError = /something went wrong|出错了|发送失败|发生错误|出现了问题|再生失败/i.test(text.slice(0, 120));
  return JSON.stringify({ count: roots.length, busy, text, truncated, turnError });
}`

/** 就绪检查表达式:输入框可见即可发消息(未登录站点通常没有输入框) */
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

/** 复用常驻站点标签页(web-tool 同款:不新增标签页,会话内发送纯 SPA);没有才创建 */
async function ensureTab(site: WebchatSite): Promise<{ id: string; wsUrl: string }> {
  const findTab = async (): Promise<{ id: string; wsUrl: string } | null> => {
    const res = await rustFetch(`${CDP_BASE}/json/list`)
    if (!res.ok) return null
    const tabs = (await res.json()) as {
      type?: string
      url?: string
      id?: string
      webSocketDebuggerUrl?: string
    }[]
    const tab = tabs.find(
      (t) => t.type === 'page' && (t.url ?? '').includes(SITE_HOSTS[site]) && t.webSocketDebuggerUrl,
    )
    return tab ? { id: tab.id!, wsUrl: tab.webSocketDebuggerUrl! } : null
  }
  const existing = await findTab()
  if (existing) return existing
  await ensureEdge(site)
  const after = await findTab()
  if (after) return after
  const target = `${CDP_BASE}/json/new?${SITE_URLS[site]}`
  let res = await rustFetch(target, { method: 'PUT' })
  if (!res.ok) res = await rustFetch(target) // 旧版内核只认 GET
  if (!res.ok) throw new Error(`打开 CDP 标签页失败: HTTP ${res.status}`)
  const t = (await res.json()) as { id: string; webSocketDebuggerUrl?: string }
  return { id: t.id, wsUrl: t.webSocketDebuggerUrl ?? `ws://127.0.0.1:${CDP_PORT}/devtools/page/${t.id}` }
}

async function pageWsOf(targetId: string): Promise<string> {
  const res = await rustFetch(`${CDP_BASE}/json/list`)
  if (!res.ok) throw new Error(`拉取标签页失败: HTTP ${res.status}`)
  const tabs = (await res.json()) as { id?: string; webSocketDebuggerUrl?: string }[]
  const t = tabs.find((x) => x.id === targetId)
  if (!t?.webSocketDebuggerUrl) throw new Error('标签页已关闭')
  return t.webSocketDebuggerUrl
}

async function closeTab(_targetId: string): Promise<void> {
  /* 常驻标签页复用模式:不再关标签,保留会话 */
}

// ---------- 对外接口 ----------

/** 一轮网页生成:整段 prompt 进,网页模型原始回复出(与嵌入版签名一致)。
 *  发送(可殉职)+ 应用侧轮询快照(抗导航),完成判定移植 web-tool:
 *  见过生成中 → 不忙 → 有答案(非思考/非截断)→ 稳定 2.5 秒 */
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
  const tab = await ensureTab(site)
  let cdp = new CdpConn(tab.wsUrl)

  const onAbort = () => {
    cdp.close()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await cdp.open()
    // 等目标页面上下文稳定(首次创建的标签页要从 about:blank 导航过来)
    for (let i = 0; i < 30; i++) {
      try {
        const probe = (await cdp.call(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true },
          5000,
        )) as { result?: { value?: string } }
        if ((probe?.result?.value ?? '').startsWith('https://')) break
      } catch {
        /* 上下文随导航销毁,属预期 */
      }
      await new Promise((r) => setTimeout(r, 800))
    }
    // 发送阶段:随导航殉职 = 已发出的强信号,放行
    let beforeCount: number | null = null
    let beforeText: string | null = null
    try {
      const r = (await cdp.call(
        'Runtime.evaluate',
        {
          expression: `(${SEND_JS})(${JSON.stringify(prompt)})`,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        },
        60_000,
      )) as { result?: { value?: { sent?: boolean; why?: string; beforeCount?: number; beforeText?: string } } }
      const v = r?.result?.value
      if (typeof v?.beforeCount === 'number') beforeCount = v.beforeCount
      if (typeof v?.beforeText === 'string') beforeText = v.beforeText
      if (v && v.sent === false) throw new Error(v.why || '未能发送')
    } catch (e) {
      if (!/context|destroyed|cannot find|target closed|session/i.test(String(e))) throw e
    }
    // 抓取阶段:应用侧轮询无状态快照,上下文随导航销毁就重连同标签页的新上下文
    const watchExpr = `(${SNAP_JS})(${JSON.stringify(prompt.slice(0, 20))})`
    const t0 = Date.now()
    let sawGenerating = false
    let last: string | undefined = ''
    let stableSince = 0
    for (;;) {
      if (signal?.aborted) throw new DOMException('已中止', 'AbortError')
      if (Date.now() - t0 >= timeoutMs) throw new Error('网页生成超时')
      try {
        const r = (await cdp.call(
          'Runtime.evaluate',
          { expression: watchExpr, returnByValue: true },
          8000,
        )) as { result?: { value?: string } }
        const snap = JSON.parse(r?.result?.value ?? '{}') as {
          count?: number
          busy?: boolean
          text?: string
          truncated?: boolean
          turnError?: boolean
        }
        if (snap.busy) sawGenerating = true
        if (snap.turnError) throw new Error('站点返回了错误提示(发送失败)')
        const grew = beforeCount !== null && typeof snap.count === 'number' && snap.count > beforeCount
        const changed = beforeText !== null && !!snap.text && snap.text !== beforeText
        const hasAnswer = !!snap.text && !snap.truncated
        if ((sawGenerating || grew || changed) && !snap.busy && hasAnswer) {
          if (snap.text === last) {
            if (!stableSince) stableSince = Date.now()
            if (Date.now() - stableSince >= 2500) return snap.text
          } else {
            last = snap.text ?? ''
            stableSince = Date.now()
          }
        } else {
          stableSince = 0
          last = snap.text ?? ''
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e
        // 上下文随导航销毁:重连同一标签页的新上下文,轮询状态保留
        try {
          cdp.close()
        } catch {
          /* 已断 */
        }
        await new Promise((r) => setTimeout(r, 1000))
        cdp = new CdpConn(await pageWsOf(tab.id))
        await cdp.open()
      }
      await new Promise((r) => setTimeout(r, 300))
    }
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

/** 手动恢复主覆盖层(角色回屏) */
export async function webchatRestoreMain(): Promise<void> {
  await invoke('webchat_main_visible', { show: true })
}
