//! 站点适配:每个网页模型站点一份 adapter(站点 URL/宿主/页面内驱动脚本)。
//! 选择器是 2026-09 时点快照(移植自 web-tool 扩展,经实战校验),站点改版
//! 只改本文件,调度器(webchat.rs)不动。两站当前共用同一份选择器快照
//! (历史上就是一份通用脚本,豆包选择器混在兜底列表里);某站改版需要专属
//! 选择器时,把对应 const 拆成两份即可,adapter 接口不变。

/// 调度器只认这四个字段与方法,不出现 if site 分支
pub struct SiteAdapter {
    /// 站点入口页(直达登录/会话页)
    pub url: &'static str,
    /// 标签页归属判定:页面 URL 包含此宿主即视为本站标签页
    pub host: &'static str,
}

/// 页面内共享 JS 片段:可见性 + 去嵌套(所有驱动/抓取的基础)
const UTILS_JS: &str = r#"
  const visible = (el) => {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  const outermost = (nodes) => nodes.filter((n) => !nodes.some((o) => o !== n && n.contains(o)));
"#;

/// 助手回复根节点选择器(web-tool deepseek 适配器的 messageRoots)
const ROOT_SELS: &str = r#"[
  '[data-message-author-role="assistant"]',
  '.ds-message',
  '[class*="ds-assistant"]',
  '.ds-markdown',
]"#;

/// 发送阶段:填 prompt 并优先点发送按钮,Enter 兜底;返回发送前的回复根数量/文本
/// (供应用侧判定"回复区增长了")。若执行中页面跳转,evaluate 随上下文销毁报错,
/// 调度器把这类错误视为"已发出"。__UTILS__ / __ROOT_SELS__ 由调度器替换注入。
const SEND_JS: &str = r#"async (prompt) => {
  __UTILS__
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const roots = () => outermost(
    __ROOT_SELS__.flatMap((s) => [...document.querySelectorAll(s)]).filter(visible)
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
}"#;

/// 快照阶段:无状态读取"最后一个回复根"的 {count,busy,text,truncated,turnError}。
/// 上下文被导航销毁后重连即可继续,不依赖任何页面内遗留状态。
const SNAP_JS: &str = r#"(head) => {
  __UTILS__
  const stripThinking = (el) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[class*="ds-think"], [class*="think-content"], [class*="thinking"], [data-think], details').forEach((n) => n.remove());
    clone.querySelectorAll('.ds-markdown, .markdown, .markdown-body, details').forEach((n) => {
      if (n === clone) return;
      const start = (n.innerText || '').trim().slice(0, 24);
      if (/^(思考中|已深度思考|思考过程|Thought for|Thinking…|Thinking\.\.\.)/i.test(start)) n.remove();
    });
    clone.querySelectorAll('button, [role="button"]').forEach((n) => n.remove());
    return clone;
  };
  const allRoots = [];
  for (const s of __ROOT_SELS__) {
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
    const lastLine = t.split('\n').pop().trim();
    if (lastLine.startsWith('{') && !lastLine.endsWith('}')) truncated = true;
    if (lastLine.startsWith('[') && !lastLine.endsWith(']')) truncated = true;
  }
  const turnError = /something went wrong|出错了|发送失败|发生错误|出现了问题|再生失败/i.test(text.slice(0, 120));
  return JSON.stringify({ count: roots.length, busy, text, truncated, turnError });
}"#;

/// 就绪检查表达式:输入框可见即可发消息(未登录站点通常没有输入框)
const READY_JS: &str = r#"(() => {
  const sels = ['#chat-input', 'textarea[name="search"]', 'textarea[data-testid="chat_input_input"]', 'textarea'];
  return sels.some((s) => !!document.querySelector(s));
})()"#;

impl SiteAdapter {
    /// 发送脚本(注入共享片段后返回)
    pub fn send_js(&self) -> String {
        SEND_JS
            .replace("__UTILS__", UTILS_JS)
            .replace("__ROOT_SELS__", ROOT_SELS)
    }

    /// 快照脚本(注入共享片段后返回)
    pub fn snap_js(&self) -> String {
        SNAP_JS
            .replace("__UTILS__", UTILS_JS)
            .replace("__ROOT_SELS__", ROOT_SELS)
    }

    /// 就绪检查脚本
    pub fn ready_js(&self) -> String {
        READY_JS.to_string()
    }
}

pub fn adapter(id: &str) -> Option<&'static SiteAdapter> {
    const DEEPSEEK: SiteAdapter = SiteAdapter {
        url: "https://chat.deepseek.com/",
        host: "chat.deepseek.com",
    };
    const DOUBAO: SiteAdapter = SiteAdapter {
        url: "https://www.doubao.com/chat/",
        host: "www.doubao.com",
    };
    match id {
        "deepseek" => Some(&DEEPSEEK),
        "doubao" => Some(&DOUBAO),
        _ => None,
    }
}
