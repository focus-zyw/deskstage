// 通用 LLM 请求网关:创作(相声/段子)与工具型调用(翻译等)共用的底层通道。
// 与 llmClient 的分界:这里只管"发请求拿文本",不带任何人设/记忆/话题上下文;
// 温度、超时、json_mode 由调用方按用途给——创作 1.1,翻译等稳定性调用 0.2。
import { getConfig, inTauri } from '../storage/configStore'
import { requestEndpoint, type EndpointKind } from './endpointProxy'

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
  /** 模型覆盖(如 OCR 用免费的视觉模型);缺省 = 配置的主模型 */
  model?: string
  temperature?: number
  maxTokens?: number
  /** true = 请求 response_format json_object;端点不支持时调用方自行降级重试 */
  jsonMode?: boolean
  timeoutMs?: number
  signal?: AbortSignal
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
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), timeoutMs)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const cfg = await getConfig()
    const model = options.model?.trim() || cfg.model
    const baseUrl = cfg.baseUrl
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
    if (!inTauri) {
      // 浏览器预览:无 Tauri 运行时,走原生 fetch(靠对方 CORS 头;仅开发调试)
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      })
      return await readCompletion({ status: res.status, text: () => res.text() })
    }
    // 桌面端:配置端点代理——origin/鉴权由 Rust 解析,自定义 http/https 端点
    // (LM Studio、局域网网关等)不再依赖静态 scope 与 CORS
    const { status, body: respBytes } = await requestEndpoint(kind, '/chat/completions', {
      body,
      timeoutMs,
      signal: ctrl.signal,
    })
    return await readCompletion({ status, text: () => new TextDecoder().decode(respBytes) })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
