import { getConfig } from '../storage/configStore'
import { buildMessages } from './promptBuilder'
import { currentTimeSlot } from './timeAware'
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
function parseDialog(raw: string, minLines = 4): DialogLine[] {
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
  if (lines.length < minLines) throw new Error('有效台词过少')
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

/**
 * 时间感知短聊天:启动问候 / 空闲自发小话题,2~4 句即止。
 * 12s 超时、不重试——自发内容宁可错过也不能拖沓;失败由调用方静默处理。
 */
export async function generateShortChat(
  kind: 'greeting' | 'spontaneous',
  recentLines: DialogLine[],
  userInterests?: string,
): Promise<DialogLine[]> {
  const slot = currentTimeSlot()
  const persona =
    '甲:精力充沛、爱吹牛、脑洞大,满嘴跑火车还特别得意;乙:冷静毒舌、专拆台、话少但一针见血。两人是互怼但有默契的老搭档'
  const interests = userInterests?.trim() ? `观众朋友的兴趣:${userInterests.trim()}。` : ''
  const prev = recentLines
    .slice(-2)
    .map((l) => `${l.speaker === 'A' ? '甲' : '乙'}:${l.text}`)
    .join('\n')
  const task =
    (kind === 'greeting'
      ? '观众刚打开应用。用一段符合当前时间的简短开场,两人互相招呼并带上点时间段的梗。'
      : `两人空闲了一会儿,自发起一个小话题随便聊聊(像真人闲坐时随口开话头)。${interests}`) +
    (prev ? `\n不要重复、要自然衔接刚才的结尾:${prev}` : '')
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面双人情景剧的短互动编剧。角色:${persona}。现实时间:现在是${slot.label},${slot.scene}。创作要口语化、有梗、像真说话。\n输出协议(严格遵守):只输出一个 JSON 对象,格式 {"dialog":[{"speaker":"A","text":"台词","action":"动作"},...]};speaker 只能是 A 或 B 且交替;action 只能是 idle|talk|happy|angry|sad|surprise|shy;一共 2~4 句;每句不超过 18 个字。`,
    },
    { role: 'user', content: task },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 12_000)
  try {
    const raw = await chatRaw(messages, ctrl.signal)
    return parseDialog(raw, 2)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 点击角色的即兴反应:让 LLM 以当前角色人设说一句短吐槽(≤15 字)。
 * 4s 超时、不重试——戳一戳场景宁可快速回退固定台词。
 */
export async function improvPokeLine(
  who: 'A' | 'B',
  recentLines: DialogLine[],
): Promise<string> {
  const persona =
    who === 'A'
      ? '甲:精力充沛、爱吹牛、脑洞大、说话夸张'
      : '乙:冷静毒舌、专拆台、话少但一针见血'
  const ctx = recentLines
    .slice(-4)
    .map((l) => `${l.speaker === 'A' ? '甲' : '乙'}:${l.text}`)
    .join('\n')
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面情景剧互动。你是情景剧里的${persona}。观众朋友刚用鼠标戳了你一下。用你的口吻说一句对被戳的即兴反应,15 字以内,只输出这一句话,不要引号。`,
    },
    {
      role: 'user',
      content: ctx ? `最近剧情:\n${ctx}\n\n(观众戳了你一下)` : '(观众戳了你一下)',
    },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 4_000)
  try {
    let raw = (await chatRaw(messages, ctrl.signal)).trim()
    // 模型偶尔无视"只输出一句话"把结果包成 JSON(如 {"text":"..."}) → 解包
    if (raw.startsWith('{')) {
      try {
        const obj = JSON.parse(raw) as { text?: unknown; content?: unknown; line?: unknown }
        const inner = [obj.text, obj.content, obj.line].find((v) => typeof v === 'string')
        if (inner) raw = (inner as string).trim()
      } catch {
        // 不是合法 JSON,按原文处理
      }
    }
    const line = raw.replace(/^["'「『]|["'」』]$/g, '')
    if (!line || line.length > 25) throw new Error('即兴结果不合规')
    return line
  } finally {
    clearTimeout(timer)
  }
}
