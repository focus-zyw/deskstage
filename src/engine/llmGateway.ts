// 通用 LLM 请求网关:创作(相声/段子)与工具型调用(翻译等)共用的底层通道。
// 与 llmClient 的分界:这里只管"发请求拿文本",不带任何人设/记忆/话题上下文;
// 温度、超时、json_mode 由调用方按用途给——创作 1.1,翻译等稳定性调用 0.2。
import { fetch as rustFetch } from '@tauri-apps/plugin-http'
import { getConfig, inTauri } from '../storage/configStore'

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
  /** 模型覆盖(如 OCR 用免费的视觉模型);缺省 = 配置的主模型 */
  model?: string
  /** 端点与密钥覆盖:OCR 等辅助能力和主 LLM 用不同厂商时使用;缺省 = 主配置 */
  baseUrl?: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
  /** true = 请求 response_format json_object;端点不支持时调用方自行降级重试 */
  jsonMode?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

/** LLM 请求走 Rust 侧 http(tauri-plugin-http):不受 WebView CORS 限制,
 *  国内厂商(dashscope/方舟等不发 CORS 头)也能直连。
 *  capabilities 只放行了预设厂商域与 http://*(本地/局域网服务);
 *  未放行的自定义 https 端点会报 scope 错误,此时回落原生 fetch(靠对方 CORS 头)。 */
async function fetchLlm(url: string, init: RequestInit): Promise<Response> {
  if (!inTauri) return fetch(url, init)
  try {
    return await rustFetch(url, init)
  } catch (e) {
    if (/not allowed on the configured scope/i.test(String((e as Error)?.message ?? ''))) {
      return fetch(url, init)
    }
    throw e
  }
}

/** 调 OpenAI 兼容 /chat/completions,返回原始文本。可被外部 signal 中止,
 *  超时默认 90s;错误对象带 status/serverMsg,供 describeLlmError 分类展示 */
export async function complete(options: CompletionOptions): Promise<string> {
  const {
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
    const baseUrl = options.baseUrl?.trim() || cfg.baseUrl
    const apiKey = options.apiKey?.trim() || cfg.apiKey
    const model = options.model?.trim() || cfg.model
    const res = await fetchLlm(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
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
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      // 服务端错误说明(如 "Your api key is invalid")带到错误对象上,供分类展示
      const serverMsg = (await res.text().catch(() => '')).slice(0, 300)
      const err = new Error(`API HTTP ${res.status}`) as Error & { status?: number; serverMsg?: string }
      err.status = res.status
      err.serverMsg = serverMsg
      throw err
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content) throw new Error('空响应')
    return content
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
