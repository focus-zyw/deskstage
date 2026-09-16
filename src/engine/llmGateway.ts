// 通用 LLM 请求网关:创作(相声/段子)与工具型调用(翻译等)共用的底层通道。
// 与 llmClient 的分界:这里只管"发请求拿文本",不带任何人设/记忆/话题上下文;
// 温度、超时、json_mode 由调用方按用途给——创作 1.1,翻译等稳定性调用 0.2。
// 诊断:调用方传 diag(turnId+call 标签)才发事件——llmFinished(耗时/状态/错误分类)
// 与流式 llmFirstToken;错误分类是"网络 or 超时 or HTTP or 模型"问题的第一层归纳。
import { getConfig, inTauri } from '../storage/configStore'
import { diag, type LlmCallKind, type LlmErrorKind } from '../diag/store'
import { openEndpointStream, requestEndpoint, type EndpointKind } from './endpointProxy'

/** 诊断引用:不传 = 本次调用不进诊断环。
 *  群聊 Actor 维度(可选白名单标量):并发调用区分调用者 */
export interface GatewayDiag {
  turnId: string
  call: LlmCallKind
  actor?: string
  batchId?: string
  /** 短期会话窗口行数(llmClient 持有,gateway 层发 llm_started 时透传) */
  contextLines?: number
  /** 调用方外层定时器的生效超时预算(常短于网关层 90s;不传 = 网关层预算即生效值) */
  timeoutMs?: number
  attempt?: number
  queueDepth?: number
}

/** 多模态消息内容:纯文本,或 文本+图片 混排(OpenAI 兼容视觉格式,智谱/通义等一致) */
export type GatewayContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

export interface GatewayMessage {
  role: string
  content: GatewayContent
}

export interface CompletionOptions {
  messages: GatewayMessage[]
  /** 端点通道:llm = 主配置端点;ocr = 设置里的视觉模型端点。
   *  origin 与密钥由 Rust 从配置/凭据库解析,前端不传地址与 key */
  kind?: EndpointKind
  /** 模型档案 id(仅 kind='llm';缺省/'main' = 主配置端点):地址由 Rust 按
   *  config.modelProfiles[id].baseUrl 解析,Key 由凭据库 'llm:profileKeys' 注入,
   *  body.model 缺省取档案模型。档案缺失时由 Rust 报可读错误 */
  profile?: string
  /** 模型覆盖(如 OCR 用免费的视觉模型);缺省 = 档案模型 / 配置的主模型 */
  model?: string
  temperature?: number
  maxTokens?: number
  /** true = 请求 response_format json_object;端点不支持时调用方自行降级重试 */
  jsonMode?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  /** 诊断引用(可选):turnId + 调用点标签,传入才记诊断事件 */
  diag?: GatewayDiag
}

/** 端点 host(诊断展示用,只留 host 不留路径与参数) */
function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host
  } catch {
    return undefined
  }
}

/** prompt 结构一次算全(诊断 llm_started 用;多媒体 content 按文本段计长) */
function promptShapeOf(messages: GatewayMessage[]): {
  promptChars: number
  systemChars: number
  userChars: number
} {
  const textLen = (c: GatewayContent): number =>
    typeof c === 'string' ? c.length : c.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0)
  const lens = messages.map((m) => textLen(m.content))
  const promptChars = lens.reduce((a, b) => a + b, 0)
  const systemChars = messages.reduce((a, m, i) => (m.role === 'system' ? a + lens[i] : a), 0)
  return { promptChars, systemChars, userChars: promptChars - systemChars }
}

/** 编译后的 prompt 文本(详情档专用;图片段以占位符表示——图片本体任何档位不进诊断) */
function compiledPromptOf(messages: GatewayMessage[]): string {
  return messages
    .map((m) => {
      const body =
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => (p.type === 'text' ? p.text : '[图片略]')).join('\n')
      return `[${m.role}]\n${body}`
    })
    .join('\n\n')
}

/** 错误分类:超时/HTTP 状态/网络层/解析/空响应/取消,供诊断与面板归纳 */
export function classifyLlmError(e: unknown): {
  cancelled: boolean
  errorKind?: LlmErrorKind
  status?: number
  serverMsg?: string
} {
  const err = e as Error & { status?: number; serverMsg?: string; name?: string }
  if (err?.name === 'AbortError') return { cancelled: true }
  if (err?.name === 'TimeoutError') return { cancelled: false, errorKind: 'timeout' }
  if (typeof err?.status === 'number') {
    return { cancelled: false, errorKind: 'http', status: err.status, serverMsg: err.serverMsg }
  }
  const msg = String(err?.message ?? err ?? '')
  if (/JSON/i.test(msg)) return { cancelled: false, errorKind: 'parse' }
  if (/空响应/.test(msg)) return { cancelled: false, errorKind: 'empty' }
  if (/网络|请求失败|fetch|network|连接|ECONN|timeout of/i.test(msg)) return { cancelled: false, errorKind: 'network' }
  return { cancelled: false, errorKind: 'unknown' }
}

/** 响应解析与错误分类:status/serverMsg 挂在错误对象上,供 describeLlmError 展示 */
async function readCompletion(res: { status: number; text(): Promise<string> | string }): Promise<string> {
  if (res.status < 200 || res.status >= 300) {
    // 服务端错误说明(如 "Your api key is invalid")带到错误对象上,供分类展示
    const serverMsg = (await res.text()).slice(0, 300)
    const err = new Error(`API HTTP ${res.status}`) as Error & { status?: number; serverMsg?: string }
    err.status = res.status
    err.serverMsg = serverMsg
    throw err
  }
  const raw = await res.text()
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('响应不是合法 JSON')
  }
  const content = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message
    ?.content
  if (typeof content !== 'string' || !content) throw new Error('空响应')
  return content
}

/** 调 OpenAI 兼容 /chat/completions,返回原始文本。可被外部 signal 中止,
 *  超时默认 90s;错误对象带 status/serverMsg,供 describeLlmError 分类展示 */
export async function complete(options: CompletionOptions): Promise<string> {
  const {
    kind = 'llm',
    messages,
    temperature = 0.2,
    maxTokens = 4000,
    jsonMode = true,
    timeoutMs = 90_000,
    signal,
  } = options
  const d = options.diag
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), timeoutMs)
  // 透传外部 signal 的 abort reason:调用方的内部超时(如 turnBatch 12s)原本在这里
  // 被抹成普通 AbortError,与用户取消无法区分——诊断会失真,回落语义也会跟着错
  const onAbort = () => ctrl.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  let t0 = 0
  try {
    const cfg = await getConfig()
    // 档案解析:'main'/缺省 = 主端点;其余按 config.modelProfiles 取模型与(预览态)地址。
    // 桌面端地址/Key 均由 Rust 按同一 profile 参数解析,这里只决定 body.model。
    const profile = options.profile?.trim() || undefined
    const profileEntry =
      profile && profile !== 'main' ? cfg.modelProfiles?.[profile] : undefined
    const model = options.model?.trim() || profileEntry?.model || cfg.model
    const baseUrl = profileEntry?.baseUrl || cfg.baseUrl
    const body = JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      // 火山方舟 doubao-seed 系默认深度思考,工具型调用用不上还拖慢数倍,显式关掉。
      // 该参数仅 ark 认识,按 baseUrl+模型前缀收紧,避免污染其他厂商
      ...(baseUrl.includes('volces.com') && model.startsWith('doubao-seed')
        ? { thinking: { type: 'disabled' } }
        : {}),
    })
    // llm_started 收归网关单点:所有直调 complete 的链路(actors apiActor、
    // llmClient 各调用)自动获得 prompt 结构/模型/端点,不再各自为政
    if (d) {
      const shape = promptShapeOf(messages)
      diag.llmStarted(d.turnId, {
        call: d.call,
        transport: 'api',
        model,
        endpointHost: hostOf(baseUrl),
        ...shape,
        contextLines: d.contextLines ?? 0,
        // 显示生效预算(调用方外层定时器,如 facts 6s),而非网关层 90s 底座
        timeoutMs: d.timeoutMs ?? timeoutMs,
      })
      // 详情档:脱敏后的 prompt 编译结果(协议冲突/拼装出错/记忆污染类问题的证据)
      diag.detailText(d.turnId, { textKind: 'prompt', text: compiledPromptOf(messages) })
    }
    // 计时从请求真正发出起算(getConfig 的缓存读不算网络延迟)
    t0 = Date.now()
    let out: string
    if (!inTauri) {
      // 浏览器预览:无 Tauri 运行时,走原生 fetch(靠对方 CORS 头;仅开发调试)
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      })
      out = await readCompletion({ status: res.status, text: () => res.text() })
    } else {
      // 桌面端:配置端点代理——origin/鉴权由 Rust 解析,自定义 http/https 端点
      // (LM Studio、局域网网关等)不再依赖静态 scope 与 CORS
      const { status, body: respBytes } = await requestEndpoint(kind, '/chat/completions', {
        body,
        timeoutMs,
        profile,
        signal: ctrl.signal,
      })
      out = await readCompletion({ status, text: () => new TextDecoder().decode(respBytes) })
    }
    if (d) {
      diag.llmFinished(d.turnId, {
        call: d.call,
        transport: 'api',
        ok: true,
        elapsedMs: Date.now() - t0,
        outputChars: out.length,
        actor: d.actor,
        batchId: d.batchId,
        attempt: d.attempt,
        queueDepth: d.queueDepth,
      })
    }
    return out
  } catch (e) {
    if (d && t0 > 0) {
      const c = classifyLlmError(e)
      diag.llmFinished(d.turnId, {
        call: d.call,
        transport: 'api',
        ok: false,
        cancelled: c.cancelled,
        elapsedMs: Date.now() - t0,
        outputChars: 0,
        errorKind: c.errorKind,
        status: c.status,
        serverMsg: c.serverMsg,
        actor: d.actor,
        batchId: d.batchId,
        attempt: d.attempt,
        queueDepth: d.queueDepth,
      })
    }
    throw e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// ---------- 流式补全(实时语音对话逐句合成用) ----------

/** OpenAI 兼容 SSE 解析(纯函数,导出供测试):跨 chunk 缓冲、按行取 data: 载荷、
 *  [DONE] 收尾;只认 choices[0].delta.content(reasoning/心跳/非 JSON 行忽略) */
export function createSseParser(onDelta: (piece: string) => void): {
  push(text: string): void
  end(): void
} {
  let buf = ''
  const handleLine = (line: string) => {
    const t = line.trim()
    if (!t.startsWith('data:')) return
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    try {
      const v = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] }
      const piece = v?.choices?.[0]?.delta?.content
      if (typeof piece === 'string' && piece) onDelta(piece)
    } catch {
      // 心跳/注释行:忽略
    }
  }
  return {
    push(text) {
      buf += text
      let at = buf.indexOf('\n')
      while (at >= 0) {
        handleLine(buf.slice(0, at))
        buf = buf.slice(at + 1)
        at = buf.indexOf('\n')
      }
    },
    end() {
      if (buf.trim()) handleLine(buf)
      buf = ''
    },
  }
}

/** 流式补全(OpenAI 兼容 stream:true):delta 逐段回调,返回聚合全文。
 *  与 complete 同源的双通路:桌面走端点代理流式通道(Channel→ReadableStream,
 *  非 2xx 以流错误终止),浏览器预览走原生 fetch。流式不支持 jsonMode(纯文本)。
 *  取消/超时同 complete:外部 signal 与内部计时器合流 */
export async function completeStream(
  options: CompletionOptions & { onDelta(piece: string): void },
): Promise<string> {
  const {
    kind = 'llm',
    messages,
    temperature = 0.2,
    maxTokens = 4000,
    timeoutMs = 90_000,
    signal,
    onDelta,
  } = options
  const d = options.diag
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), timeoutMs)
  // 同 complete:透传外部 abort reason,超时不再伪装成用户取消
  const onAbort = () => ctrl.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const fulls: string[] = []
  let t0 = 0
  let firstTokenAt = 0
  const parse = createSseParser((piece) => {
    if (d && t0 > 0 && firstTokenAt === 0) {
      firstTokenAt = Date.now()
      diag.llmFirstToken(d.turnId, { call: d.call, transport: 'api', ms: firstTokenAt - t0 })
    }
    fulls.push(piece)
    onDelta(piece)
  })
  try {
    const cfg = await getConfig()
    const profile = options.profile?.trim() || undefined
    const profileEntry =
      profile && profile !== 'main' ? cfg.modelProfiles?.[profile] : undefined
    const model = options.model?.trim() || profileEntry?.model || cfg.model
    const baseUrl = profileEntry?.baseUrl || cfg.baseUrl
    const body = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true })
    if (d) {
      const shape = promptShapeOf(messages)
      diag.llmStarted(d.turnId, {
        call: d.call,
        transport: 'api',
        model,
        endpointHost: hostOf(baseUrl),
        ...shape,
        contextLines: d.contextLines ?? 0,
        // 显示生效预算(调用方外层定时器,如 facts 6s),而非网关层 90s 底座
        timeoutMs: d.timeoutMs ?? timeoutMs,
      })
      diag.detailText(d.turnId, { textKind: 'prompt', text: compiledPromptOf(messages) })
    }
    t0 = Date.now()
    if (!inTauri) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        const serverMsg = (await res.text().catch(() => '')).slice(0, 300)
        const err = new Error(`API HTTP ${res.status}`) as Error & { status?: number; serverMsg?: string }
        err.status = res.status
        err.serverMsg = serverMsg
        throw err
      }
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) parse.push(new TextDecoder().decode(value, { stream: true }))
      }
      parse.end()
      return finishStreamOk(fulls.join(''))
    }
    const { stream } = openEndpointStream(kind, '/chat/completions', {
      body,
      timeoutMs,
      profile,
      signal: ctrl.signal,
    })
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) parse.push(new TextDecoder().decode(value, { stream: true }))
    }
    parse.end()
    return finishStreamOk(fulls.join(''))
  } catch (e) {
    if (d && t0 > 0) {
      const c = classifyLlmError(e)
      diag.llmFinished(d.turnId, {
        call: d.call,
        transport: 'api',
        ok: false,
        cancelled: c.cancelled,
        elapsedMs: Date.now() - t0,
        outputChars: fulls.join('').length,
        errorKind: c.errorKind,
        status: c.status,
        serverMsg: c.serverMsg,
      })
    }
    throw e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  function finishStreamOk(full: string): string {
    if (d && t0 > 0) {
      diag.llmFinished(d.turnId, {
        call: d.call,
        transport: 'api',
        ok: true,
        elapsedMs: Date.now() - t0,
        outputChars: full.length,
      })
    }
    return full
  }
}
