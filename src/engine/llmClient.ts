import { fetch as rustFetch } from '@tauri-apps/plugin-http'
import { getConfig, inTauri } from '../storage/configStore'
import type { UserProfile } from '../storage/configStore'
import { buildMessages, renderUserContext, type UserContext } from './promptBuilder'
import { getMemory, topFacts, tasteSummary, type FactCategory } from '../storage/memoryStore'
import { storyContext } from '../storage/storyStore'
import { pickRelationship } from '../performer/modes/relationships'
import { currentTimeSlot } from './timeAware'
import { VALID_ACTIONS, clampPauseMs, sanitizeDelivery, type DialogLine, type Speaker } from '../performer/player'
import type { Mode } from '../performer/modes'

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
  if (err.status === 404) {
    // 火山方舟等:404 = 模型名不存在/已下架,或账号未开通该模型
    const hint = `${serverMessage(e)} ${err.serverMsg ?? ''}`
    if (/ModelNotOpen|not activated|have access/i.test(hint))
      return '模型未在本账号开通(到厂商控制台开通,或换个模型)'
    return '模型不存在或已下架,检查模型名'
  }
  if (err.status !== undefined && err.status >= 500) return '服务端故障,稍后再试'
  if (/failed to fetch|network|load failed/i.test(err.message ?? '')) return '网络连接失败'
  return serverMessage(e) || err.message || '未知错误'
}

function signalAborted(e: unknown): boolean {
  return (e as Error)?.name === 'AbortError'
}

/** 从服务端错误 body 提取人类可读说明(适配 OpenAI/火山方舟等 JSON 错误格式) */
function serverMessage(e: unknown): string {
  const raw = (e as { serverMsg?: string }).serverMsg ?? ''
  try {
    const o = JSON.parse(raw) as { error?: { message?: string }; message?: string }
    return o.error?.message || o.message || raw
  } catch {
    return raw
  }
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

/** 调用 OpenAI 兼容 /chat/completions，返回原始文本。90s 超时，可被外部中止。
 *  jsonMode=false 用于纯文本应答(戳一戳吐槽/聊天回复):这些调用本就不该强迫
 *  模型输出 JSON,且部分端点(如 deepseek-reasoner)不支持 response_format 会直接 400 */
async function chatRaw(
  messages: { role: string; content: string }[],
  signal?: AbortSignal,
  jsonMode = true,
): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 90_000)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const cfg = await getConfig()
    const res = await fetchLlm(`${cfg.baseUrl}/chat/completions`, {
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
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        // 火山方舟 doubao-seed 系默认深度思考,写段子用不上还拖慢 4~5 倍(实测 6.4s→1.1s),显式关掉。
        // 该参数仅 ark 认识,按 baseUrl+模型前缀收紧,避免污染其他厂商
        ...(cfg.baseUrl.includes('volces.com') && cfg.model.startsWith('doubao-seed')
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
  const cfg = await getConfig()
  const mem = await getMemory()
  const userCtx: UserContext = {
    profile: cfg.userProfile,
    taste: await tasteSummary(3) || undefined,
    // 50% 概率注入角色世界:老梗高频复读比没有更糟
    story: Math.random() < 0.5 ? await storyContext(2) : undefined,
    facts: topFacts(mem, 8),
  }
  // 本集临时关系:随机局势决定攻守姿态,场景卡据此构建(重试沿用同一关系,保持一致)
  const relationship = pickRelationship(mode)
  const messages = buildMessages(mode, topic, recentLines, topicFixed, cfg.userInterests, userCtx, relationship)
  let lastErr: unknown = new Error('未知错误')
  let noJsonMode = false // 该端点不支持 response_format 时降级(400 判定)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException('已中止', 'AbortError')
    try {
      const raw = await chatRaw(messages, signal, !noJsonMode)
      return parseDialog(raw)
    } catch (e) {
      // 用户主动中止不重试，直接抛
      if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e
      lastErr = e
      if (attempt === 0) {
        // 400 多为端点不支持 response_format → 第二次去掉;其他错误稍退避,避免限流下二连发
        noJsonMode = (e as { status?: number }).status === 400
        if (!noJsonMode) await new Promise((r) => setTimeout(r, 600))
      }
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
): Promise<DialogLine[]> {
  const cfg = await getConfig()
  const mem = await getMemory()
  const slot = currentTimeSlot()
  const persona =
    '甲:精力充沛、爱吹牛、脑洞大,满嘴跑火车还特别得意;乙:冷静毒舌、专拆台、话少但一针见血。两人是互怼但有默契的老搭档'
  const userCtx: UserContext = {
    profile: cfg.userProfile,
    taste: (await tasteSummary(3)) || undefined,
    facts: topFacts(mem, 3),
  }
  const profileBits = renderUserContext(userCtx).trim()
  const interests = profileBits ? `${profileBits}\n` : ''
  const prev = recentLines
    .slice(-2)
    .map((l) => `${l.speaker === 'A' ? '甲' : '乙'}:${l.text}`)
    .join('\n')
  const task =
    (kind === 'greeting'
      ? `观众刚打开应用。用一段符合当前时间的简短开场,两人互相招呼并带上点时间段的梗。`
      : `两人空闲了一会儿,自发起一个小话题随便聊聊(像真人闲坐时随口开话头)。${interests}`) +
    (prev ? `\n不要重复、要自然衔接刚才的结尾:${prev}` : '')
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面双人情景剧的短互动编剧。角色:${persona}。现实时间:现在是${slot.label},${slot.scene}。创作要口语化、有梗、像真说话。\n输出协议(严格遵守):只输出一个 JSON 对象,格式 {"dialog":[{"speaker":"A","text":"台词","action":"动作"},...]};speaker 只能是 A 或 B 且交替;action 只能是 idle|talk|happy|laugh|wave|shy|angry|sad|surprise;一共 2~4 句;每句不超过 18 个字。`,
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
    let raw = (await chatRaw(messages, ctrl.signal, false)).trim()
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

/**
 * 聊天通道:观众对指定角色说了一句话,该角色用自己的口吻回一句(15~25 字)。
 * 注入称呼/画像/记忆事实,命中雷区的话题不接。8s 超时、不重试,失败由调用方静默兜底。
 */
export async function generateUserChatReply(who: Speaker, userText: string): Promise<string> {
  const cfg = await getConfig()
  const mem = await getMemory()
  const p: UserProfile = cfg.userProfile
  const persona =
    who === 'A'
      ? '甲:精力充沛、爱吹牛、脑洞大、说话夸张,口头禅"我跟你说""好家伙"'
      : '乙:冷静毒舌、专拆台、话少但一针见血,惯用反问和吐槽'
  const bits: string[] = []
  if (p.userName) bits.push(`观众称呼"${p.userName}"`)
  if (p.occupation) bits.push(`身份:${p.occupation}`)
  if (p.likes) bits.push(`喜欢:${p.likes}`)
  if (p.dislikes) bits.push(`不喜欢:${p.dislikes}`)
  if (p.banTopics) bits.push(`绝对不要聊:${p.banTopics}`)
  const facts = topFacts(mem, 3)
  if (facts.length) bits.push(`记住的观众的事:${facts.join(';')}`)
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面双人情景剧互动。你是${persona}。观众朋友直接对你说了一句话,用你的口吻回一句。要求:15~25 字,口语化,像真说话${p.userName ? `,称呼观众"${p.userName}"` : ''};不要引号,不要 JSON。${bits.length ? `\n关于观众:${bits.join(';')}。` : ''}`,
    },
    { role: 'user', content: userText },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 8_000)
  try {
    let raw = (await chatRaw(messages, ctrl.signal, false)).trim()
    if (raw.startsWith('{')) {
      try {
        const obj = JSON.parse(raw) as { text?: unknown; content?: unknown }
        const inner = [obj.text, obj.content].find((v) => typeof v === 'string')
        if (inner) raw = (inner as string).trim()
      } catch {
        // 不是合法 JSON,按原文处理
      }
    }
    const line = raw.replace(/^["'「『]|["'」』]$/g, '')
    if (!line || line.length > 40) throw new Error('应答不合规')
    return line
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 记忆提取:从观众的一句话里挖"关于观众本人的长期事实",与已知事实去重后由调用方入库。
 * 6s 超时、不重试;失败抛错由调用方静默。
 */
export async function extractFacts(
  userText: string,
  known: string[],
): Promise<{ content: string; category: FactCategory }[]> {
  const cats: FactCategory[] = ['identity', 'preference', 'habit', 'people', 'event', 'other']
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `从观众说的话里提取"关于观众本人的长期事实"(身份/喜好/习惯/身边人/重要事件)。已知事实(不要重复提取):${known.length ? known.join(';') : '(无)'}。只输出一个 JSON 对象:{"facts":[{"content":"事实","category":"identity|preference|habit|people|event|other"}]}。只提取观众明确透露的信息,不要推测;没有新事实就输出 {"facts":[]}。`,
    },
    { role: 'user', content: userText },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 6_000)
  try {
    const raw = await chatRaw(messages, ctrl.signal)
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return []
    const obj = JSON.parse(m[0]) as { facts?: unknown }
    if (!Array.isArray(obj.facts)) return []
    return obj.facts
      .map((f) => (f && typeof f === 'object' ? (f as { content?: unknown; category?: unknown }) : null))
      .filter(
        (f): f is { content: string; category: string } =>
          typeof f?.content === 'string' && f.content.trim().length > 1,
      )
      .map((f) => ({
        content: f.content.trim().slice(0, 120),
        category: (cats.includes(f.category as FactCategory) ? f.category : 'other') as FactCategory,
      }))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 演出节奏标注:给一集台词补停顿/听者反应/语气的独立二遍调用。
 * 为什么不在生成时一并要:实测小模型在长 prompt 下会把字段塞进台词文本、
 * 把 delivery 泄漏进 action(污染台词),拆开后各自合规。
 * 输出是按行号的编辑表(~100 token),合并时钳位校验;8s 超时,失败原样返回。
 */
export async function addPerformanceCues(lines: DialogLine[]): Promise<DialogLine[]> {
  const script = lines.map((l, i) => `${i}.${l.speaker === 'A' ? '甲' : '乙'}:${l.text}`).join('\n')
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `给这段双人喜剧台词标注演出节奏,让笑点有呼吸。只输出一个 JSON 对象:{"cues":{"行号":{"pauseBefore":毫秒,"pauseAfter":毫秒,"listenerAction":"动作","delivery":"deadpan|excited|slow"}}}
- 只给值得标注的行(通常 3~6 行),别每行都标:
  包袱抖出前的行给 "pauseBefore":300~600;响底的最后一句给 "pauseAfter":900~1500;情绪转折处给听者(另一人)配 "listenerAction",动作只能是 idle|talk|happy|laugh|shy|sleepy|wave|thinking|angry|sad|surprise;语气特别的行(面瘫/兴奋/慢条斯理)给 "delivery"
- 没有值得标注的行就输出 {"cues":{}}`,
    },
    { role: 'user', content: script },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 8_000)
  try {
    const raw = await chatRaw(messages, ctrl.signal)
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return lines
    const obj = JSON.parse(m[0]) as { cues?: Record<string, Record<string, unknown>> }
    const cues = obj.cues ?? {}
    return lines.map((line, i) => {
      const c = cues[String(i)]
      if (!c || typeof c !== 'object') return line
      const listenerAction =
        typeof c.listenerAction === 'string' && VALID_ACTIONS.has(c.listenerAction)
          ? c.listenerAction
          : line.listenerAction
      return {
        ...line,
        pauseBefore: clampPauseMs(c.pauseBefore) ?? line.pauseBefore,
        pauseAfter: clampPauseMs(c.pauseAfter) ?? line.pauseAfter,
        listenerAction,
        delivery: sanitizeDelivery(c.delivery) ?? line.delivery,
      }
    })
  } catch {
    return lines // 标注失败,原样播出
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 角色世界蒸馏:从一集台词里提炼可长期复用的素材——
 * gags = 两人之间的固定笑点(自包含短语,如"冰箱是甲的健身器材"),
 * threads = 还没了结的事件线(如"乙还欠甲一杯奶茶")。
 * 8s 超时、不重试;失败由调用方静默——蒸馏宁可错过也不能拖累演出。
 */
export async function distillStory(
  lines: DialogLine[],
): Promise<{ gags: string[]; threads: string[] }> {
  const text = lines.map((l) => `${l.speaker === 'A' ? '甲' : '乙'}:${l.text}`).join('\n')
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `从这段双人情景喜剧台词里,提炼可长期复用的"角色世界"素材。
- gags:两人之间形成的固定笑点/称呼/歪理,必须是自包含短语(10~25 字,如"冰箱是甲的健身器材"),最多 2 条,没有就给空数组
- threads:还没了结的事件线(某人欠某人东西/某事没交代完),必须是自包含短语,最多 2 条,没有就给空数组
只提炼台词里明确出现的,不要编造。只输出一个 JSON 对象:{"gags":["..."],"threads":["..."]}`,
    },
    { role: 'user', content: text },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 8_000)
  try {
    const raw = await chatRaw(messages, ctrl.signal)
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return { gags: [], threads: [] }
    const obj = JSON.parse(m[0]) as { gags?: unknown; threads?: unknown }
    const pick = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === 'string' && x.trim().length > 3)
            .map((x) => x.trim().slice(0, 60))
            .slice(0, 2)
        : []
    return { gags: pick(obj.gags), threads: pick(obj.threads) }
  } finally {
    clearTimeout(timer)
  }
}
