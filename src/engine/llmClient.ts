import { getConfig } from '../storage/configStore'
import { buildMessages } from './promptBuilder'
import type { DialogLine, Speaker } from '../performer/player'
import type { Mode } from '../performer/modes'

const VALID_ACTIONS = new Set([
  'idle',
  'talk',
  'happy',
  'angry',
  'sad',
  'surprise',
  'shake',
  'jump',
])

/** 把底层错误归类成用户能懂的短句;附带 HTTP body 里的服务端说明(截断) */
export async function describeLlmError(e: unknown): Promise<string> {
  if (signalAborted(e)) return '已停止'
  const err = e as { name?: string; message?: string; status?: number; serverMsg?: string }
  if (err.name === 'TimeoutError' || /timeout|timed out/i.test(err.message ?? '')) return '请求超时'
  if (err.status === 401 || err.status === 403 || /invalid.*key|authentication/i.test(`${err.message} ${err.serverMsg ?? ''}`))
    return 'API Key 无效或已过期'
  if (err.status === 402 || /insufficient|balance|quota|额度/i.test(`${err.message} ${err.serverMsg ?? ''}`))
    return '账户额度不足'
  if (err.status === 429 || /rate limit/i.test(`${err.message} ${err.serverMsg ?? ''}`)) return '请求过于频繁'
  if (err.status !== undefined && err.status >= 500) return '服务端故障,稍后再试'
  if (/failed to fetch|network|load failed/i.test(err.message ?? '')) return '网络连接失败'
  return err.serverMsg || err.message || '未知错误'
}

function signalAborted(e: unknown): boolean {
  return (e as Error)?.name === 'AbortError'
}

/** 调用 OpenAI 兼容 /chat/completions，返回原始文本。90s 超时，可被外部中止 */
async function chatRaw(
  messages: { role: string; content: string }[],
  signal?: AbortSignal,
): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 90_000)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const cfg = await getConfig()
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 1.1,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
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

/** 解析并规范化 LLM 输出：容忍代码围栏/多余文本，非法 action 归一为 talk，丢弃坏行 */
function parseDialog(raw: string): DialogLine[] {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    // 容错：从混杂文本中抠出 JSON 对象
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('输出中找不到 JSON')
    obj = JSON.parse(m[0])
  }
  const dialog = (obj as { dialog?: unknown }).dialog
  if (!Array.isArray(dialog)) throw new Error('缺少 dialog 数组')
  const lines: DialogLine[] = []
  for (const item of dialog) {
    const it = item as { speaker?: unknown; text?: unknown; action?: unknown }
    const speaker = it.speaker === 'A' || it.speaker === 'B' ? (it.speaker as Speaker) : null
    const text = typeof it.text === 'string' ? it.text.trim() : ''
    if (!speaker || !text) continue
    const action =
      typeof it.action === 'string' && VALID_ACTIONS.has(it.action) ? it.action : 'talk'
    lines.push({ speaker, text, action })
  }
  if (lines.length < 4) throw new Error('有效台词过少')
  return lines
}

/**
 * 生成一整段对话（单次点播）。
 * 失败自动重试 1 次（含 JSON 不合规），仍失败抛错，由调用方兜底。
 */
export async function generateDialog(
  mode: Mode,
  topic: string,
  recentLines: DialogLine[],
  signal?: AbortSignal,
  topicFixed?: boolean,
): Promise<DialogLine[]> {
  const { userInterests } = await getConfig()
  const messages = buildMessages(mode, topic, recentLines, topicFixed, userInterests)
  let lastErr: unknown = new Error('未知错误')
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException('已中止', 'AbortError')
    try {
      const raw = await chatRaw(messages, signal)
      return parseDialog(raw)
    } catch (e) {
      // 用户主动中止不重试，直接抛
      if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e
      lastErr = e
    }
  }
  throw lastErr
}
