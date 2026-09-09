import { fetch as rustFetch } from '@tauri-apps/plugin-http'
import { getConfig, inTauri } from '../storage/configStore'
import type { UserProfile } from '../storage/configStore'
import { buildMessages, renderAudienceContext, type UserContext } from './promptBuilder'
import { mergeMessages, webchatAsk } from './webchat'
import { getMemory, topFacts, tasteSummary, type FactCategory } from '../storage/memoryStore'
import { storyContext } from '../storage/storyStore'
import { takeRecap } from '../storage/interactionStore'
import { pickRelationship } from '../performer/modes/relationships'
import { currentTimeSlot } from './timeAware'
import { envContext } from './envAware'
import {
  clampPauseMs,
  parseGeneratedDialog,
  sanitizeDelivery,
  VALID_ACTIONS,
  type DialogLine,
  type PerformanceScript,
  type Speaker,
} from '../performer/dialogSchema'
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

/** 解析并规范化 LLM 输出:交给 dialogSchema 统一处理(容忍围栏/混杂文本,
 *  保留可选演出字段,非法 action 归一为 talk,丢弃坏行;choice 行单独提出) */
function parseDialog(raw: string, minLines = 4): PerformanceScript {
  return parseGeneratedDialog(raw, minLines)
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
  /** 连续剧情节拍(可选):本集演剧情线的一拍,prompt 话题让位 */
  arc?: { title: string; hook: string; stage: number },
): Promise<PerformanceScript> {
  const cfg = await getConfig()
  const mem = await getMemory()
  // 约 30% 的集数包含观众抉择点(由应用侧掷骰,重试保持一致)
  const allowChoice = Math.random() < 0.3
  // 上一集的观众选择:注入一次即清除
  let lastChoice: string | null = null
  try { lastChoice = localStorage.getItem('vc-lastChoice') } catch { /* ignore */ }
  const userCtx: UserContext = {
    profile: cfg.userProfile,
    taste: await tasteSummary(3) || undefined,
    // 50% 概率注入角色世界:老梗高频复读比没有更糟
    story: Math.random() < 0.5 ? await storyContext(2) : undefined,
    facts: topFacts(mem, 8),
  }
  // 本集临时关系:随机局势决定攻守姿态,场景卡据此构建(重试沿用同一关系,保持一致)
  const relationship = pickRelationship(mode)
  const interactionRecap = (await takeRecap()) ?? undefined
  const envNote = cfg.envSense ? envContext() : undefined
  const messages = buildMessages(mode, topic, recentLines, topicFixed, cfg.userInterests, userCtx, relationship, interactionRecap, allowChoice, lastChoice ?? undefined, arc, envNote)
  // 网页版生成(设置里开启):主演出改经隐藏网页窗口由网页模型生成。
  // 网页端没有 json_mode/temperature,格式服从度靠协议本身(手动验证 6/6 通过,
  // 见 docs/webchat-prompt-test.md)。生成慢(几十秒级),点播与预生成都有耐心等;
  // 任何失败(未登录/超时/解析失败)都静默回退走下方 API 通道。
  if (cfg.webchatEnabled) {
    try {
      const raw = await webchatAsk(mergeMessages(messages), signal, 180_000)
      return parseDialog(raw)
    } catch (e) {
      if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e
      console.warn('[webchat] 网页生成失败,本次回退 API:', e)
    }
  }
  let lastErr: unknown = new Error('未知错误')
  let noJsonMode = false // 该端点不支持 response_format 时降级(400 判定)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException('已中止', 'AbortError')
    try {
      const raw = await chatRaw(messages, signal, !noJsonMode)
      const script = parseDialog(raw)
      if (lastChoice) {
        try { localStorage.removeItem('vc-lastChoice') } catch { /* ignore */ }
      }
      return script
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
  kind: 'greeting' | 'spontaneous' | 'break',
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
  const profileBits = renderAudienceContext(userCtx).trim()
  const interests = profileBits ? `${profileBits}\n` : ''
  const prev = recentLines
    .slice(-2)
    .map((l) => `${l.speaker === 'A' ? '甲' : '乙'}:${l.text}`)
    .join('\n')
  const task =
    (kind === 'greeting'
      ? `观众刚打开应用。用一段符合当前时间的简短开场,两人互相招呼并带上点时间段的梗。`
      : kind === 'break'
        ? `两人注意到观众已经连续忙了很久,用角色口吻提醒观众休息一下(可以伸懒腰、递杯水、劝两句话),温和一点,别唠叨,2~4 句。`
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
    return parseDialog(raw, 2).before
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

/** 蒸馏时的已知素材清单(带 id,供模型报 resolved/reused) */
export interface StoryInventory {
  gags: { id: string; text: string }[]
  threads: { id: string; text: string }[]
  arcs: { id: string; title: string; stage: number; hook: string }[]
}

export interface ArcAdvance {
  id: string
  nextHook: string
}

export interface NewArc {
  title: string
  hook: string
}

export interface DistilledStory {
  newGags: string[]
  newThreads: string[]
  /** 台词里已经了结的已知事件线 id(结案后不再注入) */
  resolvedThreadIds: string[]
  /** 台词里实际回收了的已知老梗 id(真实"被用过"计数) */
  reusedGagIds: string[]
  /** 连续剧情推进一拍(写新钩子,stage 由存储层自增) */
  arcAdvance: ArcAdvance | null
  /** 本集冒出的值得多集延续的新剧情线(最多 1 条) */
  newArc: NewArc | null
}

/**
 * 角色世界蒸馏:从一集台词里提炼可长期复用的素材,并对已知素材记账——
 * newGags/newThreads:新形成的固定笑点/还没了结的事件线(自包含短语);
 * reusedGagIds/resolvedThreadIds:已知素材在本集被回收/了结的记账;
 * arcAdvance:连续剧情推进一拍(给出下一拍钩子);newArc:本集冒出的新剧情线。
 * 8s 超时、不重试;失败由调用方静默——蒸馏宁可错过也不能拖累演出。
 */
export async function distillStory(
  lines: DialogLine[],
  known: StoryInventory = { gags: [], threads: [], arcs: [] },
): Promise<DistilledStory> {
  const text = lines.map((l) => `${l.speaker === 'A' ? '甲' : '乙'}:${l.text}`).join('\n')
  const knownGags = known.gags.map((g) => `${g.id}:${g.text}`).join(';') || '(无)'
  const knownThreads = known.threads.map((t) => `${t.id}:${t.text}`).join(';') || '(无)'
  const knownArcs =
    known.arcs.map((a) => `${a.id}:${a.title}[已演${a.stage}拍,下一拍:${a.hook}]`).join(';') ||
    '(无)'
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `维护桌面双人情景剧的"角色世界"素材库。当前库存:
老梗(编号:内容):${knownGags}
事件线(编号:内容):${knownThreads}
连续剧情(编号:标题[已演N拍,下一拍:hook]):${knownArcs}

对照刚播出的台词,只输出一个 JSON 对象:
{"newGags":["新形成的固定笑点,自包含短语10~25字,如冰箱是甲的健身器材"],"newThreads":["新出现的、还没了结的事件线,自包含短语"],"resolvedThreadIds":["台词里已经了结的已知事件线编号"],"reusedGagIds":["台词里实际回收了的已知老梗编号"],"arcAdvance":{"id":"本集演出了其下一拍的连续剧情编号","nextHook":"再下一拍的新进展或悬念,15~40字"},"newArc":{"title":"本集冒出的值得多集延续的新剧情线标题,10字内","hook":"第一拍的悬念,15~40字"}}
- newGags/newThreads 各最多 2 条,只提炼台词里明确出现的,不要编造;已知素材原文再现时不要重复放进 new*
- resolvedThreadIds/reusedGagIds 只能填上面列出的编号,没有就给空数组
- arcAdvance 只在本集确实演出了某条连续剧情的"下一拍"时给出,并写出新钩子;newArc 只在本集剧情确有延续价值时给出,各最多 1 条;不适用就给 null`,
    },
    { role: 'user', content: text },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 8_000)
  try {
    const raw = await chatRaw(messages, ctrl.signal)
    const m = raw.match(/\{[\s\S]*\}/)
    const none: DistilledStory = {
      newGags: [],
      newThreads: [],
      resolvedThreadIds: [],
      reusedGagIds: [],
      arcAdvance: null,
      newArc: null,
    }
    if (!m) return none
    const obj = JSON.parse(m[0]) as Record<string, unknown>
    const knownGagIds = new Set(known.gags.map((g) => g.id))
    const knownThreadIds = new Set(known.threads.map((t) => t.id))
    const knownArcIds = new Set(known.arcs.map((a) => a.id))
    const texts = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === 'string' && x.trim().length > 3)
            .map((x) => x.trim().slice(0, 60))
            .slice(0, 2)
        : []
    const ids = (v: unknown, allowed: Set<string>): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string' && allowed.has(x)).slice(0, 3)
        : []
    const arcObj = (v: unknown): Record<string, unknown> | null =>
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    const str = (v: unknown, min: number, cap: number): string =>
      typeof v === 'string' && v.trim().length >= min ? v.trim().slice(0, cap) : ''
    const adv = arcObj(obj.arcAdvance)
    const na = arcObj(obj.newArc)
    const arcAdvance = adv
      ? { id: String(adv.id ?? ''), nextHook: str(adv.nextHook, 5, 60) }
      : null
    const newArc = na ? { title: str(na.title, 2, 30), hook: str(na.hook, 5, 60) } : null
    return {
      newGags: texts(obj.newGags),
      newThreads: texts(obj.newThreads),
      resolvedThreadIds: ids(obj.resolvedThreadIds, knownThreadIds),
      reusedGagIds: ids(obj.reusedGagIds, knownGagIds),
      arcAdvance: arcAdvance && knownArcIds.has(arcAdvance.id) ? arcAdvance : null,
      newArc,
    }
  } finally {
    clearTimeout(timer)
  }
}
