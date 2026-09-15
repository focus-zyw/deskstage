//! 站点适配:每个网页模型站点一份 adapter(站点 URL/宿主/页面内驱动脚本)。
//! 选择器是 2026-09 时点快照:deepseek/doubao 移植自 D:/web-tool 的站点适配器
//! 并经实战校验;chatgpt/gemini/qianwen 移植自同一仓库 extension/content 下的
//! 同名单站点脚本(ChatGPT 的 Lexical 粘贴、Gemini 的 Quill ql-blank、千问的
//! React 受控输入框都各有各的提交条件,所以填充/提交/收尾判定都做成 adapter 字段)。
//! 站点改版只改本文件,调度器(webchat.rs)不动。输入框与回复 DOM 按站点隔离,
//! 避免一个站点改版拖坏另一个站点的就绪探测与回复抓取。

/// 输入框填充策略(站点编辑器差异,不能一刀切)
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FillMode {
    /// 通用:textarea/input 走原生 value setter,contenteditable 走
    /// select-all + execCommand insertText
    Standard,
    /// 合成粘贴:Lexical(ChatGPT 的 #prompt-textarea)对上千字的 insertText
    /// 会逐字建节点并冻死标签页,粘贴是单次事务,长 prompt 必须走这条
    Paste,
}

impl FillMode {
    fn as_js(self) -> &'static str {
        match self {
            FillMode::Standard => "standard",
            FillMode::Paste => "paste",
        }
    }
}

/// 调度器只认 adapter 字段与方法,不出现 if site 分支
pub struct SiteAdapter {
    /// 站点入口页(直达登录/会话页)
    pub url: &'static str,
    /// 标签页归属判定:页面 URL 包含此宿主即视为本站标签页
    pub host: &'static str,
    /// 可发送消息的输入框(顺序即优先级)
    composer_sels: &'static [&'static str],
    /// 发送按钮(Enter 仅作兜底)
    send_button_sels: &'static [&'static str],
    /// 发送后再补点一次的兜底按钮(填入后输入框仍未清空时)。
    /// 原实现把 deepseek 的圆形发送键写死在共享脚本里,现改为站点数据
    send_retry_sels: &'static [&'static str],
    /// 助手单条回复的根节点
    message_root_sels: &'static [&'static str],
    /// 回复正文节点;存在时只读取这些块,避开头像/工具栏等 chrome
    markdown_body_sels: &'static [&'static str],
    /// 思考过程节点,抓回复前移除
    thinking_sels: &'static [&'static str],
    /// 生成中/停止标记:停止键不一定带 aria-label(chatgpt 是 data-testid,
    /// 通义是 data-is-streaming,gemini 是 .stop-icon),必须按站点列
    stop_sels: &'static [&'static str],
    /// 收尾标记:文档里最后一个该标记既不在最后一个回复根之内、也不排在它之后
    /// = 本回合仍在生成。chatgpt 在搜索/引用停顿期间会撤下停止键,只看 stop
    /// 会把"还在跑"误判成已完成,抓回半截答案。
    /// 代价:站点若真把这组按钮拿掉,本回合永远等不到收尾 → 每次 ask 都跑满超时
    /// 再回退 API。"ChatGPT 最近变慢"的排查起点就是这里
    complete_sels: &'static [&'static str],
    /// 输入框填充策略
    fill: FillMode,
    /// 填充前从输入框上摘掉的类名(gemini 的 Quill 靠 ql-blank 认定"没编辑过",
    /// 不摘掉发送键不会亮)
    clear_classes: &'static [&'static str],
    /// 填充 contenteditable 前先派发 beforeinput(gemini 的 Quill 依赖此事件)
    beforeinput: bool,
    /// 填充后若站点发送键仍禁用,select-all 后补一次合成粘贴:Quill 与 React
    /// 受控输入框只在"真实提交"之后才启用发送键,insertText 不触发提交
    paste_if_send_disabled: bool,
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
  const outermost = (nodes) => nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
"#;

/// 发送阶段:填 prompt 并优先点发送按钮,Enter 兜底;返回发送前的回复根数量/文本
/// (供应用侧判定"回复区增长了")。若执行中页面跳转,evaluate 随上下文销毁报错,
/// 调度器把这类错误视为"已发出"。选择器与填充策略均由 SiteAdapter 注入。
const SEND_JS: &str = r#"async (prompt) => {
  __UTILS__
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const roots = () => outermost(
    __ROOT_SELS__.flatMap((s) => [...document.querySelectorAll(s)]).filter(visible)
  );
  const replyText = (root) => {
    if (!root) return '';
    const bodies = [];
    for (const s of __MARKDOWN_BODY_SELS__) {
      root.querySelectorAll(s).forEach((n) => { if (!bodies.includes(n)) bodies.push(n); });
    }
    const bodyRoots = outermost(bodies);
    return (bodyRoots.length
      ? bodyRoots.map((n) => (n.innerText || n.textContent || '').trim()).filter(Boolean).join('\n\n')
      : (root.innerText || root.textContent || '').trim());
  };
  const beforeRoots = roots();
  const beforeCount = beforeRoots.length;
  const beforeText = beforeRoots.length ? replyText(beforeRoots[beforeRoots.length - 1]) : '';
  const composerSels = __COMPOSER_SELS__;
  const sendBtnSels = __SEND_BUTTON_SELS__;
  const sendRetrySels = __SEND_RETRY_SELS__;
  const clearClasses = __CLEAR_CLASSES__;
  const fillMode = __FILL_MODE__;
  const useBeforeInput = __BEFOREINPUT__;
  const pasteIfDisabled = __PASTE_IF_SEND_DISABLED__;
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
  const inputText = (el) => {
    if (!el) return '';
    if (typeof el.value === 'string') return el.value;
    return (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ');
  };
  // 富文本编辑器会把换行与连续空白重排(Quill 每行一个 <p>、Lexical 归一 nbsp),
  // 所以"写进去了"只比可见字符:严格逐字比对会把成功的填充判成失败,白跑 5 轮重试
  const squeezed = (s) => (s || '').replace(/[\s\u00a0]+/g, '');
  const selectContents = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const fireInput = (el, text) => {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  };
  const isEditable = (el) => el.getAttribute('contenteditable') === 'true' || el.isContentEditable;
  const setPlain = (el, text) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // 合成粘贴:整段文本一次事务,编辑器只收到一个 paste。先全选 = 替换而非追加,
  // 所以重试永远不会把内容变成两份(a → aa)。少数实现只把构造参数落到原型上,
  // 页面读 clipboardData 会拿到空串,补一次自身属性(Lexical 会读它)
  const pasteText = (el, text) => {
    el.focus();
    selectContents(el);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const paste = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    try { Object.defineProperty(paste, 'clipboardData', { value: dt }); } catch (e) {}
    el.dispatchEvent(paste);
    fireInput(el, text);
  };
  const insertIntoEditable = (el, text) => {
    for (const c of clearClasses) el.classList.remove(c);
    el.focus();
    selectContents(el);
    if (useBeforeInput) {
      el.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: text,
      }));
    }
    document.execCommand('insertText', false, text);
    fireInput(el, text);
  };
  const enabledSendBtn = () => {
    for (const s of sendBtnSels) {
      const b = document.querySelector(s);
      if (b && visible(b) && !b.disabled) return b;
    }
    return null;
  };
  // 站点的粘贴提交是异步的(React 批处理),同步读到的还是旧内容;等它落地,
  // 只在编辑器仍然为空时才补 insertText——部分落地时再插一次就会变成两份
  const settlePaste = async (el, text) => {
    const min = Math.min(80, String(text || '').length);
    for (let i = 0; i < 6; i++) {
      await sleep(50);
      if (squeezed(inputText(el)).length >= min) return;
    }
    if (squeezed(inputText(el)).length > 0) return;
    insertIntoEditable(el, text);
    await sleep(300);
  };
  const setInput = async (el, text) => {
    el.focus();
    if (!isEditable(el)) { setPlain(el, text); return; }
    if (fillMode === 'paste') { pasteText(el, text); await settlePaste(el, text); return; }
    insertIntoEditable(el, text);
    if (pasteIfDisabled) {
      await sleep(250);
      if (!enabledSendBtn()) { pasteText(el, text); await settlePaste(el, text); }
    }
  };
  let setOk = false;
  for (let i = 0; i < 5 && !setOk; i++) {
    await setInput(ta, prompt);
    await sleep(400);
    const got = squeezed(inputText(ta));
    setOk = got.length > 0 && got === squeezed(prompt);
  }
  if (!setOk) return { sent: false, why: '提示词未能写入输入框(站点可能改版)', beforeCount, beforeText };
  // 优先点发送按钮(与 web-tool 一致),Enter 兜底
  let sendBtn = enabledSendBtn();
  if (sendBtn) {
    sendBtn.click();
  } else {
    const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    ta.dispatchEvent(new KeyboardEvent('keydown', key));
    ta.dispatchEvent(new KeyboardEvent('keypress', key));
    ta.dispatchEvent(new KeyboardEvent('keyup', key));
  }
  await sleep(1500);
  // 输入框还没清空 = 这次点击没被吃掉(按钮启用晚于插入),补点站点自己的兜底键
  if (inputText(ta).trim() !== '' && document.contains(ta)) {
    for (const s of sendRetrySels) {
      const b = document.querySelector(s);
      if (b && visible(b) && !b.disabled) { b.click(); break; }
    }
    await sleep(1500);
  }
  const sent = inputText(ta).trim() === '' || !document.contains(ta);
  return { sent, why: sent ? '' : '已填入但发送失败', beforeCount, beforeText };
}"#;

/// 快照阶段:无状态读取"最后一个回复根"的 {count,busy,text,truncated,turnError}。
/// 上下文被导航销毁后重连即可继续,不依赖任何页面内遗留状态。
const SNAP_JS: &str = r#"(head) => {
  __UTILS__
  const stripThinking = (el) => {
    const clone = el.cloneNode(true);
    for (const s of __THINKING_SELS__) clone.querySelectorAll(s).forEach((n) => n.remove());
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
  const last = roots[roots.length - 1] || null;
  const stopping = __STOP_SELS__.some((s) => [...document.querySelectorAll(s)].some(visible))
    || [...document.querySelectorAll('button')].some(
      (b) => visible(b) && /stop|停止/i.test(b.getAttribute('aria-label') || '')
    );
  // 站点收尾标记:chatgpt 在搜索/引用停顿期间把停止键收起来,只看 stop 会把
  // "还在跑"当成已完成,抓回半截答案。判定 = 文档里最后一个标记要么在最后一个
  // 回复根之内(按钮就渲染在回复里),要么排在它之后(按钮在回合容器里、回复
  // 之后);排在它之前的属于上一个回合,不算本回合收尾
  const completeSels = __COMPLETE_SELS__;
  let unfinished = false;
  if (completeSels.length && last) {
    const marks = completeSels.flatMap((s) => [...document.querySelectorAll(s)]);
    // flatMap 按选择器分组拼接,跨选择器就不是文档序;排序后才能"取最后一个"
    marks.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const mark = marks[marks.length - 1];
    const belongs = !!mark && (last.contains(mark)
      || (last.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    unfinished = !belongs;
  }
  const busy = stopping || unfinished
    || /思考中|正在思考|深度思考中|生成中|正在搜索|搜索中|找到\s*\d+\s*篇资料/.test((last?.innerText || '').slice(0, 120));
  let text = '';
  let truncated = false;
  if (last) {
    const clean = stripThinking(last);
    const bodies = [];
    for (const s of __MARKDOWN_BODY_SELS__) {
      clean.querySelectorAll(s).forEach((n) => { if (!bodies.includes(n)) bodies.push(n); });
    }
    const bodyRoots = outermost(bodies);
    text = (bodyRoots.length
      ? bodyRoots.map((n) => (n.innerText || n.textContent || '').trim()).filter(Boolean).join('\n\n')
      : (clean.innerText || clean.textContent || '').trim());
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
  const turnError = /something went wrong|出错了|发送失败|failed to|发生错误|error occurred|出现了问题|请重试|try again|再生失败|regeneration failed/i.test(text.slice(0, 120));
  const inputReady = __COMPOSER_SELS__.some((s) => [...document.querySelectorAll(s)].some(visible));
  return JSON.stringify({ count: roots.length, busy, text, truncated, turnError, inputReady, visibility: document.visibilityState, focused: document.hasFocus() });
}"#;

/// 就绪检查表达式:站点专属输入框可见即可发消息(未登录站点通常没有输入框)
const READY_JS: &str = r#"(() => {
  __UTILS__
  const sels = __COMPOSER_SELS__;
  return sels.some((s) => [...document.querySelectorAll(s)].some(visible));
})()"#;

/// 页面状态检查:输入框可见 + 通用风控/验证码拦截启发。
/// blocker 只查 class/id 属性与 iframe src 命中 captcha/验证码/安全验证字样,
/// 不扫正文——聊天内容里提到"验证码"不该被误判成风控弹窗。
/// 登录失效的直接征兆也是输入框消失(未登录站点通常没有输入框),归入 inputReady。
const STATE_JS: &str = r#"(() => {
  __UTILS__
  const sels = __COMPOSER_SELS__;
  const inputReady = sels.some((s) => [...document.querySelectorAll(s)].some(visible));
  const hit = (el) => {
    const key = `${el.className || ''} ${el.id || ''}`.toLowerCase();
    return /captcha|verify|安全验证|滑动验证|风控/.test(key);
  };
  const blocker =
    [...document.querySelectorAll('iframe')].some((f) => visible(f) && /captcha|verify/i.test(f.src || ''))
    || [...document.querySelectorAll('div,section')].some((el) => {
      if (!visible(el)) return false;
      const b = el.getBoundingClientRect();
      return b.width > 200 && b.height > 120 && hit(el);
    });
  return JSON.stringify({ inputReady, blocker: blocker ? '检测到验证码/安全验证弹层' : '' });
})()"#;

impl SiteAdapter {
    fn selectors_json(selectors: &[&str]) -> String {
        serde_json::to_string(selectors).expect("静态 CSS 选择器应可序列化")
    }

    /// 发送脚本(注入站点选择器与填充策略后返回)
    pub fn send_js(&self) -> String {
        SEND_JS
            .replace("__UTILS__", UTILS_JS)
            .replace(
                "__ROOT_SELS__",
                &Self::selectors_json(self.message_root_sels),
            )
            .replace(
                "__MARKDOWN_BODY_SELS__",
                &Self::selectors_json(self.markdown_body_sels),
            )
            .replace(
                "__COMPOSER_SELS__",
                &Self::selectors_json(self.composer_sels),
            )
            .replace(
                "__SEND_BUTTON_SELS__",
                &Self::selectors_json(self.send_button_sels),
            )
            .replace(
                "__SEND_RETRY_SELS__",
                &Self::selectors_json(self.send_retry_sels),
            )
            .replace(
                "__CLEAR_CLASSES__",
                &Self::selectors_json(self.clear_classes),
            )
            .replace("__FILL_MODE__", &format!("\"{}\"", self.fill.as_js()))
            .replace(
                "__BEFOREINPUT__",
                if self.beforeinput { "true" } else { "false" },
            )
            .replace(
                "__PASTE_IF_SEND_DISABLED__",
                if self.paste_if_send_disabled {
                    "true"
                } else {
                    "false"
                },
            )
    }

    /// 快照脚本(注入站点选择器与生成中判定后返回)
    pub fn snap_js(&self) -> String {
        SNAP_JS
            .replace("__UTILS__", UTILS_JS)
            .replace(
                "__ROOT_SELS__",
                &Self::selectors_json(self.message_root_sels),
            )
            .replace(
                "__MARKDOWN_BODY_SELS__",
                &Self::selectors_json(self.markdown_body_sels),
            )
            .replace(
                "__THINKING_SELS__",
                &Self::selectors_json(self.thinking_sels),
            )
            .replace("__STOP_SELS__", &Self::selectors_json(self.stop_sels))
            .replace(
                "__COMPLETE_SELS__",
                &Self::selectors_json(self.complete_sels),
            )
            .replace(
                "__COMPOSER_SELS__",
                &Self::selectors_json(self.composer_sels),
            )
    }

    /// 就绪检查脚本
    pub fn ready_js(&self) -> String {
        READY_JS.replace("__UTILS__", UTILS_JS).replace(
            "__COMPOSER_SELS__",
            &Self::selectors_json(self.composer_sels),
        )
    }

    /// 页面状态脚本(输入框可见 + 风控/验证码启发),probe 阶段化用
    pub fn state_js(&self) -> String {
        STATE_JS.replace("__UTILS__", UTILS_JS).replace(
            "__COMPOSER_SELS__",
            &Self::selectors_json(self.composer_sels),
        )
    }
}

pub fn adapter(id: &str) -> Option<&'static SiteAdapter> {
    const SEND_BUTTONS: &[&str] = &[
        r#"button[aria-label="Send message"]"#,
        r#"button[aria-label="Send"]"#,
        r#"button[aria-label*="发送"]"#,
        r#"[data-testid="send-button"]"#,
    ];
    // deepseek 的圆形发送键:填好后第一次点击可能落在"按钮刚亮"之前,兜底再点一次
    const DS_SEND_RETRY: &[&str] = &[r#"button[class*="ds-button--circle"]:not([class*="disa"])"#];
    const NO_SELS: &[&str] = &[];
    const DEEPSEEK: SiteAdapter = SiteAdapter {
        url: "https://chat.deepseek.com/",
        host: "chat.deepseek.com",
        composer_sels: &[
            "#chat-input",
            r#"textarea[placeholder*="Send a message"]"#,
            r#"textarea[placeholder*="Message DeepSeek"]"#,
            r#"textarea[placeholder*="给 DeepSeek"]"#,
            r#"textarea[data-testid="chat-input"]"#,
            r#"div[contenteditable][role="textbox"]"#,
        ],
        send_button_sels: SEND_BUTTONS,
        send_retry_sels: DS_SEND_RETRY,
        message_root_sels: &[
            r#"[data-message-author-role="assistant"]"#,
            ".ds-message",
            r#"[class*="ds-assistant"]"#,
            ".ds-markdown",
        ],
        markdown_body_sels: &[".ds-markdown", ".markdown-body"],
        thinking_sels: &[
            r#"[class*="ds-think"]"#,
            r#"[class*="think-content"]"#,
            r#"[class*="thinking"]"#,
            r#"[class*="Thought"]"#,
            "[data-think]",
            "details",
        ],
        stop_sels: NO_SELS,
        complete_sels: NO_SELS,
        fill: FillMode::Standard,
        clear_classes: NO_SELS,
        beforeinput: false,
        paste_if_send_disabled: false,
    };
    const DOUBAO: SiteAdapter = SiteAdapter {
        url: "https://www.doubao.com/chat/",
        host: "www.doubao.com",
        composer_sels: &[
            r#"textarea[placeholder*="发送"]"#,
            r#"textarea[placeholder*="豆包"]"#,
            r#"textarea[placeholder*="问题"]"#,
            r#"textarea[placeholder*="Ask"]"#,
            r#"div[contenteditable="true"][role="textbox"]"#,
            r#"div[contenteditable="true"][data-lexical-editor="true"]"#,
        ],
        send_button_sels: SEND_BUTTONS,
        send_retry_sels: NO_SELS,
        message_root_sels: &[
            r#"[class*="v_list_row"]:has([class*="text-s-color-text-secondary"])"#,
        ],
        markdown_body_sels: &[
            r#"[class*="md-box-root"]"#,
            ".markdown-body",
            r#"[class*="markdown"]"#,
        ],
        thinking_sels: &[
            r#"[class*="thinking"]"#,
            r#"[class*="think"]"#,
            r#"[class*="Thought"]"#,
        ],
        stop_sels: NO_SELS,
        complete_sels: NO_SELS,
        fill: FillMode::Standard,
        clear_classes: NO_SELS,
        beforeinput: false,
        paste_if_send_disabled: false,
    };
    // ChatGPT:输入框是 Lexical 富文本,长 prompt 只能走粘贴;并且它在搜索/引用
    // 停顿期间会撤下停止键,必须靠回合动作按钮(复制/点赞)判定收尾
    const CHATGPT: SiteAdapter = SiteAdapter {
        url: "https://chatgpt.com/",
        host: "chatgpt.com",
        composer_sels: &[
            "#prompt-textarea",
            r#"[data-testid="prompt-textarea"]"#,
            r#"div[placeholder*="Message"][contenteditable]"#,
            r#"[contenteditable="true"][data-lexical-editor="true"]"#,
        ],
        send_button_sels: &[
            r#"button[data-testid="send-button"]"#,
            r#"button[aria-label="Send prompt"]"#,
            r#"button[aria-label*="发送"]"#,
        ],
        send_retry_sels: NO_SELS,
        message_root_sels: &[r#"[data-message-author-role="assistant"]"#, ".agent-turn"],
        markdown_body_sels: &[".markdown"],
        thinking_sels: &[
            r#"[data-testid="reasoning"]"#,
            r#"[data-testid="reasoning-summary"]"#,
            r#"[data-testid*="reason"]"#,
            ".result-thinking",
            r#"[class*="thinking"]"#,
            r#"[class*="Thought"]"#,
        ],
        stop_sels: &[
            r#"button[data-testid="stop-button"]"#,
            r#"button[aria-label*="Stop"]"#,
            r#"button[aria-label*="停止"]"#,
        ],
        complete_sels: &[r#"[data-testid*="turn-action-button"]"#],
        fill: FillMode::Paste,
        clear_classes: NO_SELS,
        beforeinput: false,
        paste_if_send_disabled: false,
    };
    // Gemini:输入框是 Quill(.ql-editor),要先摘掉 ql-blank 并派发 beforeinput,
    // 发送键仍禁用时补一次合成粘贴
    const GEMINI: SiteAdapter = SiteAdapter {
        url: "https://gemini.google.com/app",
        host: "gemini.google.com",
        composer_sels: &[
            r#"rich-textarea .ql-editor[contenteditable='true']"#,
            r#".ql-editor[contenteditable='true']"#,
            r#"div[contenteditable="true"][role="textbox"]"#,
            r#"rich-textarea [contenteditable='true']"#,
        ],
        send_button_sels: &[
            r#"button.send-button[aria-label='Send message']"#,
            "button.send-button",
            r#"button[aria-label="Send message"]"#,
            r#"button[aria-label="发送"]"#,
            r#"button[aria-label="发送消息"]"#,
            r#"button[aria-label*="Send"]"#,
            r#"button[aria-label*="发送"]"#,
        ],
        send_retry_sels: NO_SELS,
        message_root_sels: &[
            "model-response",
            ".model-response-text",
            ".response-container",
        ],
        markdown_body_sels: &[
            ".model-response-text",
            "message-content",
            ".markdown-main-panel",
            ".markdown",
            ".markdown-body",
        ],
        thinking_sels: &[
            "model-thoughts",
            ".thoughts-container",
            ".thoughts-content",
            r#"[class*="thought"]"#,
            r#"[class*="thinking"]"#,
            r#"[class*="Thought"]"#,
        ],
        stop_sels: &[
            r#"button[aria-label="Stop"]"#,
            r#"button[aria-label="Stop responding"]"#,
            r#"button[aria-label*="Stop"]"#,
            r#"button[aria-label*="停止"]"#,
            "button.stop-icon",
            ".stop-icon",
        ],
        complete_sels: NO_SELS,
        fill: FillMode::Standard,
        clear_classes: &["ql-blank"],
        beforeinput: true,
        paste_if_send_disabled: true,
    };
    // 千问(通义)网页版:输入框是 React 受控 contenteditable,发送键只在真实
    // 提交后才启用;助手气泡走 answer-common-card,与用户气泡天然分离
    const QIANWEN: SiteAdapter = SiteAdapter {
        url: "https://www.qianwen.com/",
        // 用域名后缀而不是 www 前缀:站点改版或 www 跳转都会让"包含宿主"的
        // 标签页归属判定落空,域名后缀两种写法都收得住
        host: "qianwen.com",
        composer_sels: &[
            r#"div[contenteditable="true"][role="textbox"]"#,
            r#"div[role="textbox"][aria-multiline="true"]"#,
            r#"textarea[placeholder*="输入"]"#,
            r#"textarea[placeholder*="问"]"#,
            r#"textarea[placeholder*="Ask"]"#,
        ],
        send_button_sels: &[
            r#"button[aria-label="发送消息"]"#,
            r#"button[aria-label*="发送"]"#,
            r#"button[aria-label*="Send"]"#,
            r#"[data-testid="send-button"]"#,
        ],
        send_retry_sels: NO_SELS,
        message_root_sels: &[r#"[class*="answer-common-card"]"#],
        markdown_body_sels: &[".qk-markdown", ".markdown-body"],
        thinking_sels: &[
            r#"[class*="thinking"]"#,
            r#"[class*="Thought"]"#,
            r#"[class*="reasoning"]"#,
        ],
        stop_sels: &[
            r#"button[aria-label*="停止"]"#,
            r#"button[aria-label*="Stop"]"#,
            r#"[data-is-streaming="true"]"#,
        ],
        complete_sels: NO_SELS,
        fill: FillMode::Standard,
        clear_classes: NO_SELS,
        beforeinput: false,
        paste_if_send_disabled: true,
    };
    match id {
        "deepseek" => Some(&DEEPSEEK),
        "doubao" => Some(&DOUBAO),
        "chatgpt" => Some(&CHATGPT),
        "gemini" => Some(&GEMINI),
        "qianwen" => Some(&QIANWEN),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 全部站点 id:新站点漏配 adapter() 分支时,这里的任何断言都会先炸
    const ALL_SITES: &[&str] = &["deepseek", "doubao", "chatgpt", "gemini", "qianwen"];

    fn all() -> Vec<&'static SiteAdapter> {
        ALL_SITES.iter().map(|id| adapter(id).expect(id)).collect()
    }

    #[test]
    fn every_listed_site_resolves_to_an_adapter() {
        for id in ALL_SITES {
            let a = adapter(id).unwrap_or_else(|| panic!("站点 {id} 没有 adapter"));
            assert!(a.url.starts_with("https://"), "{id} 入口页必须是 https");
            assert!(
                !a.host.is_empty() && a.url.contains(a.host),
                "{id} 入口页必须落在自己的宿主上"
            );
        }
    }

    #[test]
    fn doubao_ready_probe_accepts_contenteditable_textbox() {
        let doubao = adapter("doubao").expect("doubao adapter");
        let ready = doubao.ready_js();
        assert!(
            ready.contains("contenteditable") && ready.contains("textbox"),
            "豆包当前使用 contenteditable textbox；就绪探测必须覆盖发送脚本支持的输入框"
        );
        assert!(
            doubao.send_js().contains("const inputText ="),
            "发送后的写入/清空判定必须同时支持 textarea.value 与 contenteditable.innerText"
        );
        assert!(
            doubao.snap_js().contains("v_list_row"),
            "豆包回复抓取必须使用豆包助手消息根节点，不能复用 DeepSeek DOM"
        );
    }

    #[test]
    fn chatgpt_fills_by_paste_because_lexical_freezes_on_insert_text() {
        let chatgpt = adapter("chatgpt").expect("chatgpt adapter");
        let send = chatgpt.send_js();
        assert!(
            send.contains(r#"const fillMode = "paste""#) && send.contains("ClipboardEvent"),
            "ChatGPT 的 Lexical 输入框对长 prompt 必须走单事务粘贴,insertText 会冻死标签页"
        );
        assert!(
            send.contains("prompt-textarea") && !send.contains("__"),
            "ChatGPT 发送脚本必须认得自己的输入框且不留未替换占位符"
        );
    }

    #[test]
    fn chatgpt_waits_for_turn_actions_instead_of_trusting_the_stop_button() {
        let chatgpt = adapter("chatgpt").expect("chatgpt adapter");
        let snap = chatgpt.snap_js();
        assert!(
            snap.contains("stop-button"),
            "ChatGPT 的停止键是 data-testid,通用 aria-label 扫描抓不到"
        );
        assert!(
            snap.contains("turn-action-button"),
            "搜索/引用停顿期间停止键会被撤下,必须靠回合动作按钮判定收尾"
        );
    }

    #[test]
    fn gemini_commits_quill_edits_so_the_send_button_enables() {
        let gemini = adapter("gemini").expect("gemini adapter");
        let send = gemini.send_js();
        assert!(
            send.contains("ql-blank") && send.contains("beforeinput"),
            "Gemini 的 Quill 必须清 ql-blank 并派发 beforeinput,否则发送键不亮"
        );
        assert!(
            send.contains("const pasteIfDisabled = true"),
            "Quill 只在真实提交后启用发送键,填完仍禁用时要补一次合成粘贴"
        );
        assert!(
            gemini.snap_js().contains("stop-icon"),
            "Gemini 的停止键可能只有 .stop-icon 类名,没有 aria-label"
        );
    }

    #[test]
    fn qianwen_commits_react_controlled_composer_and_reads_answer_cards() {
        let qianwen = adapter("qianwen").expect("qianwen adapter");
        assert!(
            qianwen.send_js().contains("const pasteIfDisabled = true"),
            "千问是 React 受控输入框,发送键只在真实提交后启用"
        );
        assert!(
            qianwen.snap_js().contains("answer-common-card")
                && qianwen.send_js().contains("answer-common-card"),
            "千问助手气泡必须用 answer-common-card,不能复用别的站点 DOM"
        );
        assert!(
            qianwen.snap_js().contains("data-is-streaming"),
            "千问的生成中标记是 data-is-streaming,没有 aria-label 可扫"
        );
        assert!(
            "https://www.qianwen.com/chat".contains(qianwen.host)
                && "https://qianwen.com/chat".contains(qianwen.host),
            "千问宿主必须写成域名后缀:www 跳转与裸域两种标签页都要认得出"
        );
    }

    #[test]
    fn site_scripts_are_isolated_and_fully_instantiated() {
        let deepseek = adapter("deepseek").expect("deepseek adapter");
        let doubao = adapter("doubao").expect("doubao adapter");
        assert!(!deepseek.snap_js().contains("v_list_row"));
        assert!(!doubao.snap_js().contains("ds-assistant"));
        // 站点 DOM 不许互相串味:谁的脚本里都不该出现别的站点的特征选择器
        let fingerprints = [
            ("deepseek", "ds-assistant"),
            ("doubao", "v_list_row"),
            ("chatgpt", "agent-turn"),
            ("gemini", "model-response"),
            ("qianwen", "answer-common-card"),
        ];
        for site in all() {
            for script in [
                site.ready_js(),
                site.send_js(),
                site.snap_js(),
                site.state_js(),
            ] {
                assert!(!script.contains("__"), "站点脚本仍有未替换占位符");
            }
            for (owner, mark) in fingerprints {
                let mine = adapter(owner).is_some_and(|a| std::ptr::eq(a, site));
                assert!(
                    mine || !site.snap_js().contains(mark),
                    "站点脚本带上了 {owner} 的 DOM 特征 {mark}"
                );
            }
        }
    }
}
