import { getConfig } from '../storage/configStore'
import type { UserProfile } from '../storage/configStore'
import { complete } from './llmGateway'
import { buildMessages, renderAudienceContext, type UserContext } from './promptBuilder'
import { mergeMessages, webchatAsk } from './webchat'
import { getMemory, topFacts, tasteSummary, type FactCategory } from '../storage/memoryStore'
import {
  storyContext,
  previewStoryContext,
  commitStoryInjection,
  getBond,
  type StoryAssertion,
  type StoryCandidate,
  type DistilledStory,
  type RelationshipEventCandidate,
  type RelationshipEventKind,
  type StoryInventory,
} from '../storage/storyStore'
import { peekRecap, takeRecap } from '../storage/interactionStore'
import { pickRelationship } from '../performer/modes/relationships'
import { currentTimeSlot } from './timeAware'
import { duoShortPersona, nameOf, soloShortPersona } from './persona'
import { envContext } from './envAware'
import {
  clampPauseMs,
  parseGeneratedDialog,
  sanitizeDelivery,
  validatePerformanceScript,
  VALID_ACTIONS,
  type ContextAdoption,
  type DialogLine,
  type PerformanceScript,
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

/** 调用 OpenAI 兼容 /chat/completions，返回原始文本。HTTP 细节在 llmGateway;
 *  这里固定创作参数:温度 1.1(要放得开)、90s 超时,可被外部中止。
 *  jsonMode=false 用于纯文本应答(戳一戳吐槽/聊天回复):这些调用本就不该强迫
 *  模型输出 JSON,且部分端点(如 deepseek-reasoner)不支持 response_format 会直接 400 */
async function chatRaw(
  messages: { role: string; content: string }[],
  signal?: AbortSignal,
  jsonMode = true,
): Promise<string> {
  return complete({ messages, temperature: 1.1, maxTokens: 4000, jsonMode, timeoutMs: 90_000, signal })
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
  /** 只有显式续聊时才带上一段原始台词；普通新主题与连续剧情都靠各自结构化上下文 */
  continueFromPrevious = false,
  /** 预生成模式:上下文只预览不消费——注入冷却/recap 消费挂到 script.adoption,
   *  真正开播时由播放侧调 adoptDeferredContext 一次性提交(预生成零副作用) */
  opts: { deferContextAdoption?: boolean } = {},
): Promise<PerformanceScript> {
  const cfg = await getConfig()
  const mem = await getMemory()
  // 约 30% 的集数包含观众抉择点(由应用侧掷骰,重试保持一致)
  const allowChoice = Math.random() < 0.3
  // 约 25% 的集数允许场外角色乱入(与抉择点互斥,重试保持一致):
  // 打破双人固定结构,第三人只用画外音/电话,不占立绘
  const GUESTS = ['房东', '快递员', '老板', `${nameOf('A')}的神秘朋友`, `${nameOf('B')}的债主`, '邻居的猫(只会喵呜)']
  const guest = !allowChoice && Math.random() < 0.25 ? GUESTS[Math.floor(Math.random() * GUESTS.length)] : undefined
  // 上一集的观众选择:注入一次即清除
  let lastChoice: string | null = null
  try { lastChoice = localStorage.getItem('vc-lastChoice') } catch { /* ignore */ }
  const userCtx: UserContext = {
    profile: cfg.userProfile,
    taste: await tasteSummary(3) || undefined,
    facts: topFacts(mem, 8),
  }
  // 50% 概率注入与本轮主题相关、且已按冷却时间轮换的角色世界素材;
  // 预生成模式只预览不消费,冷却与 recap 的持久副作用推迟到开播采纳
  const injectStory = Math.random() < 0.5
  let adoption: ContextAdoption | null = null
  let interactionRecap: string | undefined
  if (opts.deferContextAdoption) {
    const preview = injectStory
      ? await previewStoryContext(topic, 2)
      : { gags: [] as string[], threads: [] as string[], gagIds: [] as string[], threadIds: [] as string[] }
    userCtx.story = injectStory ? { gags: preview.gags, threads: preview.threads } : undefined
    interactionRecap = (await peekRecap()) ?? undefined
    adoption = { gagIds: preview.gagIds, threadIds: preview.threadIds, hasRecap: interactionRecap !== undefined }
  } else {
    userCtx.story = injectStory ? await storyContext(topic, 2) : undefined
    interactionRecap = (await takeRecap()) ?? undefined
  }
  // 本集临时关系:随机局势决定攻守姿态,场景卡据此构建(重试沿用同一关系,保持一致)
  const relationship = pickRelationship(mode)
  const envNote = cfg.envSense ? envContext() : undefined
  // 长期关系底色:随互动缓慢漂移,给当集台词定相互态度
  const bond = await getBond()
  const bondNote =
    bond.trust >= 2
      ? '两人长期互相信任、关系很铁,平时互相拆台但底线是护着对方'
      : bond.trust <= -2
        ? '两人近期互相看不顺眼,信任度低,总拿旧账试探对方'
        : bond.rivalry >= 3
          ? '两人近期摩擦变多,互相较劲谁也不服谁'
          : undefined
  const messages = buildMessages(mode, topic, recentLines, topicFixed, cfg.userInterests, userCtx, relationship, interactionRecap, allowChoice, lastChoice ?? undefined, arc, envNote, guest, bondNote, continueFromPrevious)
  // 网页版生成(设置里开启):主演出改经隐藏网页窗口由网页模型生成。
  // 网页端没有 json_mode/temperature,格式服从度靠协议本身(手动验证 6/6 通过,
  // 见 docs/webchat-prompt-test.md)。生成慢(几十秒级),点播与预生成都有耐心等;
  // 任何失败(未登录/超时/解析失败)都静默回退走下方 API 通道。
  // 校验+采纳收尾:两条生成路径共用(fatal 抛错由各自的失败路径处理)
  const finish = (script: PerformanceScript): PerformanceScript => {
    const v = validatePerformanceScript(script)
    if (v.fatal.length > 0) throw new Error(`剧本结构不合格:${v.fatal.join(';')}`)
    if (v.warnings.length > 0) console.warn('[剧本校验]', v.warnings)
    if (adoption) script.adoption = adoption
    // 上一集的观众选择注入一次即清除(成功才算消费;失败重试时 prompt 重建仍可用)
    if (lastChoice) {
      try { localStorage.removeItem('vc-lastChoice') } catch { /* ignore */ }
    }
    return script
  }
  if (cfg.webchatEnabled) {
    try {
      const raw = await webchatAsk(mergeMessages(messages), signal, 180_000)
      const script = parseDialog(raw)
      // 结构不合格 → 抛错回落 API 通道重新生成,不让死抉择/残缺剧本上台
      return finish(script)
    } catch (e) {
      if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e
      console.warn('[webchat] 网页生成失败,本次回退 API:', e)
    }
  }
  let lastErr: unknown = new Error('未知错误')
  let noJsonMode = false // 该端点不支持 response_format 时降级(400 判定)
  let repairedOnce = false // 每次生成只做一次定点修复
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException('已中止', 'AbortError')
    try {
      const raw = await chatRaw(messages, signal, !noJsonMode)
      let script = parseDialog(raw)
      // 结构不合格先做一次定点修复(最小改动,不整体重写);拿不回可播放结构才吃掉重试/走兜底
      let v = validatePerformanceScript(script)
      if (v.fatal.length > 0 && !repairedOnce) {
        repairedOnce = true
        try {
          console.warn('[剧本校验] 定点修复:', v.fatal)
          script = await repairPerformanceScript(script, v.fatal, signal)
          v = validatePerformanceScript(script)
        } catch (e) {
          if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e
          console.warn('[剧本修复] 失败,按原剧本继续判定', e)
        }
      }
      if (v.fatal.length > 0) throw new Error(`剧本结构不合格:${v.fatal.join(';')}`)
      return finish(script)
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

/** 预生成的集真正开播时采纳暂缓的上下文副作用:补记注入冷却 + 消费互动 recap。
 *  若开播前用户又有新互动,recap 会被一并消费——宁多勿丢,不影响正确性 */
export async function adoptDeferredContext(adoption: ContextAdoption): Promise<void> {
  await commitStoryInjection(adoption.gagIds, adoption.threadIds)
  if (adoption.hasRecap) await takeRecap()
}

/** 定点修复(P2 局部修复循环):结构校验 fatal 时不整体重写,只把缺陷清单和原剧本
 *  交给模型做最小改动;修复结果仍要过结构校验,不过则由调用方走重试/兜底 */
export async function repairPerformanceScript(
  script: PerformanceScript,
  issues: string[],
  signal?: AbortSignal,
): Promise<PerformanceScript> {
  const dialog = [
    ...script.before,
    ...Object.entries(script.after).flatMap(([id, ls]) => ls.map((l) => ({ ...l, branch: id }))),
  ]
  const messages = [
    {
      role: 'system',
      content: `修复桌面双人情景剧剧本的结构缺陷。只修复"结构缺陷"清单里列出的问题,不改其他台词的措辞、人设口吻与剧情走向;保持原有 speaker 交替与场景卡。只输出一个 JSON 对象,协议与生成一致:{"card":{...},"dialog":[{"speaker":"A","text":"...","action":"...","target":"B","beatId":"节拍"},...]}(choice 行与 branch 字段规则同生成;分支每句都要带 branch)。`,
    },
    {
      role: 'user',
      content: `结构缺陷:\n${issues.map((s) => `- ${s}`).join('\n')}\n\n原剧本 JSON:\n${JSON.stringify({
        card: script.card,
        choice: script.choice,
        dialog,
      })}`,
    },
  ]
  const raw = await chatRaw(messages, signal, true)
  return parseDialog(raw)
}

/**
 * 时间感知短聊天:启动问候 / 空闲自发小话题,2~4 句即止。
 * 12s 超时、不重试——自发内容宁可错过也不能拖沓;失败由调用方静默处理。
 */
export async function generateShortChat(
  kind: 'greeting' | 'spontaneous' | 'break' | 'memo',
  recentLines: DialogLine[],
  memoText?: string,
): Promise<DialogLine[]> {
  const cfg = await getConfig()
  const mem = await getMemory()
  const slot = currentTimeSlot()
  const persona = duoShortPersona()
  const userCtx: UserContext = {
    profile: cfg.userProfile,
    taste: (await tasteSummary(3)) || undefined,
    facts: topFacts(mem, 3),
  }
  const profileBits = renderAudienceContext(userCtx).trim()
  const interests = profileBits ? `${profileBits}\n` : ''
  const prev = recentLines
    .slice(-2)
    .map((l) => `${l.speaker === 'A' ? nameOf('A') : l.speaker === 'C' ? '丙(场外)' : nameOf('B')}:${l.text}`)
    .join('\n')
  const task =
    (kind === 'greeting'
      ? `观众刚打开应用。用一段符合当前时间的简短开场,两人互相招呼并带上点时间段的梗。`
      : kind === 'break'
        ? `两人注意到观众已经连续忙了很久,用角色口吻提醒观众休息一下(可以伸懒腰、递杯水、劝两句话),温和一点,别唠叨,2~4 句。`
        : kind === 'memo'
          ? `画外音刚播报了一条待办:${memoText ?? ''}。两人顺势接话讨论这件待办(可以互相推诿谁来干、吐槽时间安排),2~4 句,别重复画外音的原话。`
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
  const persona = soloShortPersona(who)
  const ctx = recentLines
    .slice(-4)
    .map((l) => `${l.speaker === 'A' ? nameOf('A') : l.speaker === 'C' ? '丙(场外)' : nameOf('B')}:${l.text}`)
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
export async function generateUserChatReply(who: 'A' | 'B', userText: string): Promise<string> {
  const cfg = await getConfig()
  const mem = await getMemory()
  const p: UserProfile = cfg.userProfile
  const persona = soloShortPersona(who)
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

/** TurnBatch 轻校验(纯函数,导出供测试):1~3 句、speaker 只能 A/B、被@角色必须首答。
 *  不合格返回 null,由调用方回落单句应答 */
export function validateTurnBatch(lines: DialogLine[], target: 'A' | 'B'): DialogLine[] | null {
  if (lines.length < 1 || lines.length > 3) return null
  if (lines.some((l) => l.speaker !== 'A' && l.speaker !== 'B')) return null
  if (lines[0].speaker !== target) return null
  return lines
}

/** 用户聊天 TurnBatch(P3):观众对角色说了一句话,生成 1~3 句双角色回合。
 *  被 @ 的角色必须先答;另一位确有新信息或包袱才补 1 句;带短期会话窗口。
 *  12s 超时、不重试;失败由调用方回落 generateUserChatReply 单句应答 */
export async function generateTurnBatch(input: {
  userText: string
  /** 被 @ 的角色(显式或轮换决定);该角色必须第一句先答 */
  target: 'A' | 'B'
  /** 短期会话窗口(最近若干句,含观众) */
  window: { who: 'user' | 'A' | 'B'; text: string }[]
}): Promise<DialogLine[]> {
  const cfg = await getConfig()
  const mem = await getMemory()
  const persona = duoShortPersona()
  const p: UserProfile = cfg.userProfile
  const facts = topFacts(mem, 3)
  const windowText = input.window.length
    ? input.window
        .map((t) => `${t.who === 'user' ? p.userName || '观众' : nameOf(t.who)}:${t.text}`)
        .join('\n')
    : ''
  const targetName = nameOf(input.target)
  const otherName = nameOf(input.target === 'A' ? 'B' : 'A')
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面双人情景剧的聊天编剧。角色:${persona}。${p.userName ? `观众称呼"${p.userName}"。` : ''}口语化、有梗、像真说话。
输出协议(严格遵守):只输出一个 JSON 对象,格式 {"dialog":[{"speaker":"A","text":"台词","target":"B"},...]}
- 一共 1~3 句:观众这句话是对${targetName}说的,${targetName}(speaker "${input.target}")必须第一句先答;${otherName}只有确实有新信息或好包袱时才补 1 句,没有就只回 1 句
- 每句不超过 25 字,不要引号;speaker 只能是 A 或 B 且不连续同一人;"target" 填这句对谁说("A"/"B"/"audience" 对观众)${facts.length ? `\n- 记住的观众的事:${facts.join(';')}` : ''}`,
    },
    {
      role: 'user',
      content: `${windowText ? `最近对话:\n${windowText}\n\n` : ''}观众说:${input.userText}`,
    },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 12_000)
  try {
    const raw = await chatRaw(messages, ctrl.signal)
    return validateTurnBatch(parseDialog(raw, 1).before, input.target) ?? []
  } finally {
    clearTimeout(timer)
  }
}

/** 演出中插话反应回合(P4):观众在演出进行时插话,安全缝处生成 1~3 句反应——
 *  第一句回应观众插的话,最后一句把话头自然带回剧情(bridgeTo 为接回后的下一句)。
 *  失败返回空数组,由调用方跳过反应直接续播 */
export async function generateInterjectionBatch(input: {
  userText: string
  target: 'A' | 'B'
  /** 已播剧情的结尾几句,接话要贴着刚才演到哪 */
  recentPlayed: string[]
  /** 剧情剩余部分的第一句内容(接回点) */
  bridgeTo: string
  window: { who: 'user' | 'A' | 'B'; text: string }[]
}): Promise<DialogLine[]> {
  const cfg = await getConfig()
  const persona = duoShortPersona()
  const p: UserProfile = cfg.userProfile
  const targetName = nameOf(input.target)
  const windowText = input.window.length
    ? input.window
        .map((t) => `${t.who === 'user' ? p.userName || '观众' : nameOf(t.who)}:${t.text}`)
        .join('\n')
    : ''
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面双人情景剧:演出进行到一半,观众插了一句话。角色:${persona}。${p.userName ? `观众称呼"${p.userName}"。` : ''}口语化、有梗、像真说话。
输出协议(严格遵守):只输出一个 JSON 对象,格式 {"dialog":[{"speaker":"A","text":"台词","target":"B"},...]}
- 一共 1~3 句:${targetName}(speaker "${input.target}")第一句先回应观众插的话;最后一句必须自然把话头带回刚才的剧情,贴着"剧情刚才演到"与"接下来要演",不要生硬
- 每句不超过 25 字,不要引号;speaker 只能是 A 或 B 且不连续同一人`,
    },
    {
      role: 'user',
      content: `${windowText ? `最近聊天:\n${windowText}\n\n` : ''}剧情刚才演到:\n${input.recentPlayed.join('\n') || '(刚开始)'}\n\n接下来剧情要演:${input.bridgeTo || '(收尾)'}\n\n观众插话:${input.userText}`,
    },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 12_000)
  try {
    const raw = await chatRaw(messages, ctrl.signal)
    return validateTurnBatch(parseDialog(raw, 1).before, input.target) ?? []
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 主播模式:弹幕 → 单句回复的 AI 决策 ----------

export interface LiveDanmakuBrief {
  username: string
  content: string
}

export interface LivePetAction {
  /** 被选中的弹幕下标(调用方批次内);-1 = 全部不回 */
  pick: number
  reply: string
  speaker: 'A' | 'B'
  action: string
}

/**
 * 弹幕回复决策:攒批弹幕一次调用,挑一条最值得回的,由甲或乙回一句。
 * 与 generateDialog 的两遍标注剧本不同,这里是轻量单次调用(10s 超时,弹幕过期不等人);
 * JSON 解析失败/字段不合规抛错,调用方按"这批不回"静默处理。
 */
export async function generateLiveReply(
  batch: LiveDanmakuBrief[],
  recentReplies: string[],
  signal?: AbortSignal,
): Promise<LivePetAction> {
  const cfg = await getConfig()
  const mem = await getMemory()
  const p: UserProfile = cfg.userProfile
  const bits: string[] = []
  if (p.userName) bits.push(`主播称呼"${p.userName}"`)
  if (p.occupation) bits.push(`身份:${p.occupation}`)
  if (p.likes) bits.push(`喜欢:${p.likes}`)
  if (p.dislikes) bits.push(`不喜欢:${p.dislikes}`)
  if (p.banTopics) bits.push(`绝对不要聊:${p.banTopics}`)
  const facts = topFacts(mem, 3)
  if (facts.length) bits.push(`记住的观众的事:${facts.join(';')}`)

  const danmakuList = batch.map((d, i) => `${i}. ${d.username}:${d.content}`).join('\n')
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面双人情景剧正在"直播读弹幕"。两位角色:${duoShortPersona()}。${p.userName ? `主播(用户)叫"${p.userName}",角色偶尔可以提到TA。` : ''}下面是最新一批直播间弹幕。挑一条最值得回的(优先问角色的、有趣的、能接梗的;刷屏/无意义/人身攻击的直接不回),由甲或乙用各自口吻回一句。要求:15~40字,口语化像真说话;语气跟各自人设走,优先友好捧场和接梗,偶尔斗嘴点缀即可,别句句抬杠;不要复读弹幕原文。
${p.banTopics ? `雷区(绝对不聊):${p.banTopics}。` : ''}
只输出一个 JSON 对象:{"pick":<弹幕序号>,"reply":"<回复,不回则空串>","speaker":"A"或"B","action":"<动作词>"}
action 只能是这些词之一:${[...VALID_ACTIONS].join('|')}。${bits.length ? `\n关于观众:${bits.join(';')}。` : ''}${recentReplies.length ? `\n最近已说过(不要重复,保持话题推进):${recentReplies.join(' / ')}` : ''}`,
    },
    { role: 'user', content: danmakuList },
  ]
  const raw = await complete({
    messages,
    temperature: 0.9,
    maxTokens: 400,
    jsonMode: true,
    timeoutMs: 10_000,
    signal,
  })
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('弹幕决策未返回 JSON')
  const obj = JSON.parse(m[0]) as Record<string, unknown>
  const reply = typeof obj.reply === 'string' ? obj.reply.trim().slice(0, 60) : ''
  const pick = Number(obj.pick)
  const speaker = obj.speaker === 'B' ? 'B' : 'A'
  const action = typeof obj.action === 'string' && VALID_ACTIONS.has(obj.action) ? obj.action : 'talk'
  // 不回:模型明确给空回复;下标越界时保留回复但标记为无目标(上游不记弹幕历史)
  if (!reply) return { pick: -1, reply: '', speaker, action }
  const validPick = Number.isInteger(pick) && pick >= 0 && pick < batch.length ? pick : -1
  return { pick: validPick, reply, speaker, action }
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
 * 备忘提醒短句:以场外角色(C)的口吻播报一条到点的待办。
 * 8s 超时、不重试;失败由调用方回退固定模板。
 */
export async function memoReminderLine(memoText: string): Promise<string> {
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content:
        '你是桌面情景剧的场外画外音(播报员)。用一句 15~25 字的口吻播报一条到点的待办,可以带点综艺感(比如"叮——"),但要把事情说清楚,只输出这一句话,不要引号。',
    },
    { role: 'user', content: `到点的待办:${memoText}` },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 8_000)
  try {
    const raw = (await chatRaw(messages, ctrl.signal, false)).trim()
    const line = raw.replace(/^["'「『]|["'」』]$/g, '')
    if (!line || line.length > 60) throw new Error('提醒不合规')
    return line
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
  const script = lines.map((l, i) => `${i}.${l.speaker === 'A' ? nameOf('A') : l.speaker === 'C' ? '丙(场外)' : nameOf('B')}:${l.text}`).join('\n')
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

/** 本集台词文本:蒸馏输入与 curator 的证据校验用同一拼写,避免两边格式漂移 */
export function transcriptOf(lines: DialogLine[]): string {
  return lines
    .map((l) => `${l.speaker === 'A' ? nameOf('A') : l.speaker === 'C' ? '丙(场外)' : nameOf('B')}:${l.text}`)
    .join('\n')
}

/**
 * 角色世界蒸馏:从一集台词里提炼可长期复用的素材,并对已知素材记账——
 * newGags/newThreads 为证据化候选(文本+台词引文+断言类别+sameAs 指认);
 * reusedGagIds/resolvedThreadIds:已知素材在本集被回收/了结的记账;
 * arcAdvance:连续剧情推进一拍(给出下一拍钩子);newArc:新剧情线(可携带被吸收的事件线)。
 * 8s 超时、不重试;失败由调用方静默——蒸馏宁可错过也不能拖累演出。
 */
export async function distillStory(
  lines: DialogLine[],
  known: StoryInventory = { gags: [], threads: [], arcs: [], doneArcs: [] },
): Promise<DistilledStory> {
  const text = transcriptOf(lines)
  const knownGags = known.gags.map((g) => `${g.id}:${g.text}`).join(';') || '(无)'
  const knownThreads = known.threads.map((t) => `${t.id}:${t.text}`).join(';') || '(无)'
  const knownArcs =
    known.arcs.map((a) => `${a.id}:${a.title}[已演${a.stage}拍,下一拍:${a.hook}]`).join(';') ||
    '(无)'
  const knownDone =
    known.doneArcs.map((a) => `${a.id}:${a.title}[结局:${a.ending || '已收尾'}]`).join(';') || '(无)'
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `维护桌面双人情景剧的"角色世界"素材库。当前库存:
老梗(编号:内容):${knownGags}
事件线(编号:内容):${knownThreads}
连续剧情(编号:标题[已演N拍,下一拍:hook]):${knownArcs}
已完结剧情(编号:标题[结局],仅作背景,不得推进、不得报成新事件线):${knownDone}

对照刚播出的台词,只输出一个 JSON 对象:
{"newGags":[{"text":"...","evidence":["..."],"assertion":"established","sameAsId":null}],"newThreads":[同结构],"resolvedThreadIds":[],"reusedGagIds":[],"relationshipEvent":null,"arcAdvance":null,"newArc":null}
- newGags 每集最多 1 条:只收"脱离台词也能反复回收"的固定笑点,自包含、以甲/乙为主语、8~40字;一次性的普通包袱不要报。newThreads 最多 2 条(还没了结的具体事情)
- evidence 必须逐字摘自台词(每段6~30字,最多2段);拿不出原句证据的候选不要报
- assertion 只能是 established(台词确认的事实)/boast(甲吹牛)/excuse(甲找借口甩锅);text 要自带"自称/号称/甩锅/嘴硬"等语气,不得把吹牛、甩锅、反问写成事实;反问、疑问、猜测一律不要报
- 同一个梗只是换了说法时报 sameAsId 为库存编号,并把 text 改写成更自包含的规范表述;本集确实回收了库存老梗则填 reusedGagIds
- relationshipEvent 只在台词里出现明确的关系转折时给出:kind 是 repair(和解)/betrayal(背叛)/support(支持)/rivalry(较劲)/user-sided(观众站队)之一,actor 是谁发起(A/B/audience),target 对谁(A/B),summary 一句话点明谁对谁做了什么(≤40字),weight 0.5~1 表程度;拿不准就给 null,不要为了记账硬编
- resolvedThreadIds/reusedGagIds/sameAsId 只能填上面列出的编号,没有就给空数组或 null
- arcAdvance 只在本集确实演出了某条活跃剧情的"下一拍"时给出,并写出再下一拍的新进展或悬念(10~60字);newArc 只在本集冒出值得多集延续的新剧情线时给出(标题2~15字,第一拍悬念10~60字),并用 closeThreadIds 把被它吸收的已知事件线一并结案;各最多 1 条,不适用给 null`,
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
      relationshipEvent: null,
    }
    if (!m) return none
    const obj = JSON.parse(m[0]) as Record<string, unknown>
    const knownGagIds = new Set(known.gags.map((g) => g.id))
    const knownThreadIds = new Set(known.threads.map((t) => t.id))
    const knownArcIds = new Set(known.arcs.map((a) => a.id))
    const assertions: ReadonlySet<unknown> = new Set([
      'established',
      'boast',
      'excuse',
      'question',
      'hypothesis',
    ])
    // 候选清洗:旧格式(裸字符串)转成无证据候选,交 curator 拒收——不让脏数据绕过证据门
    const candidates = (v: unknown, cap: number): StoryCandidate[] => {
      if (!Array.isArray(v)) return []
      const out: StoryCandidate[] = []
      for (const item of v) {
        if (out.length >= cap) break
        if (typeof item === 'string') {
          const text = item.trim().slice(0, 60)
          if (text.length > 3) out.push({ text, evidence: [], assertion: 'established', sameAsId: null })
          continue
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const o = item as Record<string, unknown>
        const text = typeof o.text === 'string' ? o.text.trim().slice(0, 60) : ''
        if (text.length <= 3) continue
        const evidence = Array.isArray(o.evidence)
          ? o.evidence
              .filter((e): e is string => typeof e === 'string')
              .map((e) => e.trim().slice(0, 30))
              .filter((e) => e.length >= 4)
              .slice(0, 2)
          : []
        const assertion = assertions.has(o.assertion) ? (o.assertion as StoryAssertion) : 'established'
        const sameAsId =
          typeof o.sameAsId === 'string' && knownGagIds.has(o.sameAsId) ? o.sameAsId : null
        out.push({ text, evidence, assertion, sameAsId })
      }
      return out
    }
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
    const newArc = na
      ? {
          title: str(na.title, 2, 15),
          hook: str(na.hook, 5, 60),
          closeThreadIds: ids(na.closeThreadIds, knownThreadIds),
        }
      : null
    // 关系事件:类别/方向/summary 任一不合法就整个丢弃(宁可漏记不可错记)
    const REL_KINDS: ReadonlySet<unknown> = new Set(['support', 'betrayal', 'repair', 'rivalry', 'user-sided'])
    const rel = arcObj(obj.relationshipEvent)
    let relationshipEvent: RelationshipEventCandidate | null = null
    if (
      rel &&
      REL_KINDS.has(rel.kind) &&
      (rel.actor === 'A' || rel.actor === 'B' || rel.actor === 'audience') &&
      (rel.target === 'A' || rel.target === 'B')
    ) {
      const summary = typeof rel.summary === 'string' ? rel.summary.trim().slice(0, 40) : ''
      if (summary) {
        relationshipEvent = {
          kind: rel.kind as RelationshipEventKind,
          actor: rel.actor,
          target: rel.target,
          weight: Math.min(1, Math.max(0.5, Number(rel.weight) || 1)),
          summary,
        }
      }
    }
    return {
      newGags: candidates(obj.newGags, 1),
      newThreads: candidates(obj.newThreads, 2),
      resolvedThreadIds: ids(obj.resolvedThreadIds, knownThreadIds),
      reusedGagIds: ids(obj.reusedGagIds, knownGagIds),
      arcAdvance: arcAdvance && knownArcIds.has(arcAdvance.id) ? arcAdvance : null,
      newArc,
      relationshipEvent,
    }
  } finally {
    clearTimeout(timer)
  }
}
