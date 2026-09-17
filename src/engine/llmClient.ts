import { getConfig } from '../storage/configStore'
import type { UserProfile } from '../storage/configStore'
import { complete, completeStream, type GatewayDiag } from './llmGateway'
import { createSentenceSplitter } from './sentenceSplitter'
import { buildMessages, renderAudienceContext, renderViewerBrief, type UserContext } from './promptBuilder'
import { mergeMessages, webchatAsk } from './webchat'
import { diag, type LlmCallKind } from '../diag/store'
import { scrubSecrets } from '../diag/redact'
import {
  getMemory,
  prepareTurnMemory,
  topFacts,
  tasteSummary,
  type FactCandidate,
  type FactCategory,
  type TurnMemoryContext,
} from '../storage/memoryStore'
import { MEMORY_SLOTS } from '../storage/memorySlots'
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
import { isComedyMode, liveMode } from '../performer/modes'
import { currentTimeSlot } from './timeAware'
import { duoShortPersona, nameOf, namingDiscipline, pronounOf, soloShortPersona } from './persona'
import { moodHintLine, moodPromptBlock, type MoodEventCandidate } from './moodState'
import { getMoods } from '../storage/moodStore'
import { evaluateChoiceAsk } from '../dialogue/choiceGate'
import type { TurnWho } from '../dialogue/turnWindow'
import {
  clampPauseMs,
  parseGeneratedDialog,
  sanitizeDelivery,
  validatePerformanceScript,
  VALID_ACTIONS,
  type ContextAdoption,
  type DialogLine,
  type PerformanceScript,
  type Speaker,
} from '../performer/dialogSchema'
import type { Mode } from '../performer/modes'
import type { TopicPlan } from '../topic/types'

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

/** 网页通道的 llm_started 埋点;turnId 缺省 = 本调用不进诊断。
 *  api 通道不经过这里:llm_started 已收归 llmGateway 单点(complete 内统一
 *  发射,含 model/endpointHost/prompt 结构),此处仅补 gateway 覆盖不到的网页通道 */
function noteLlmStart(
  turnId: string | undefined,
  call: LlmCallKind,
  transport: 'api' | 'webchat',
  _cfg: { model: string; baseUrl: string },
  messages: { role: string; content: string }[],
  opts: { timeoutMs?: number } = {},
): void {
  if (!turnId || transport !== 'webchat') return
  const chars = messages.map((m) => String(m.content).length)
  const promptChars = chars.reduce((a, b) => a + b, 0)
  const systemChars = messages.reduce((a, m, i) => (m.role === 'system' ? a + chars[i] : a), 0)
  diag.llmStarted(turnId, {
    call,
    transport: 'webchat',
    contextLines: 0,
    promptChars,
    systemChars,
    userChars: promptChars - systemChars,
    timeoutMs: opts.timeoutMs,
  })
}

/** 回退原因的短文案(强制 scrub,面板直接展示) */
function fallbackReason(e: unknown): string {
  const raw = (e as Error)?.message || String(e)
  return scrubSecrets(raw).slice(0, 120)
}

/** 调用 OpenAI 兼容 /chat/completions，返回原始文本。HTTP 细节在 llmGateway;
 *  这里固定创作参数:温度 1.1(要放得开)、90s 超时,可被外部中止。
 *  jsonMode=false 用于纯文本应答(戳一戳吐槽/聊天回复):这些调用本就不该强迫
 *  模型输出 JSON,且部分端点(如 deepseek-reasoner)不支持 response_format 会直接 400 */
async function chatRaw(
  messages: { role: string; content: string }[],
  signal?: AbortSignal,
  jsonMode = true,
  diagRef?: GatewayDiag,
): Promise<string> {
  return complete({ messages, temperature: 1.1, maxTokens: 4000, jsonMode, timeoutMs: 90_000, signal, diag: diagRef })
}

/** 解析并规范化 LLM 输出:交给 dialogSchema 统一处理(容忍围栏/混杂文本,
 *  保留可选演出字段,非法 action 归一为 talk,丢弃坏行;choice 行单独提出,
 *  写坏的 choice 经 onChoiceRejected 上交原文供软修复) */
function parseDialog(
  raw: string,
  minLines = 4,
  hooks?: { onChoiceRejected?: (v: unknown) => void },
): PerformanceScript {
  return parseGeneratedDialog(raw, minLines, hooks)
}

/** 长期关系底色文案(纯函数,导出供测试):负面底色按基调分档——
 *  非喜剧不用"看不顺眼/拿旧账试探"的互怼措辞,只作轻微背景并允许自然修复 */
export function bondNoteFor(
  bond: { trust: number; rivalry: number },
  isComedy: boolean,
): string | undefined {
  if (bond.trust >= 2) return '两人长期互相信任、关系很铁,平时互相拆台但底线是护着对方'
  if (bond.trust <= -2) {
    return isComedy
      ? '两人近期互相看不顺眼,信任度低,总拿旧账试探对方'
      : '两人近期有些摩擦,相互信任度低;相处方式按本集基调保持基本尊重,允许自然修复'
  }
  if (bond.rivalry >= 3) {
    return isComedy
      ? '两人近期摩擦变多,互相较劲谁也不服谁'
      : '两人近期有些小摩擦,互相较劲;按本集基调保持基本尊重,允许自然修复'
  }
  return undefined
}

/** 一集生成的完整请求:话题计划是唯一话题来源(动态话题系统产出) */
export interface GenerateDialogRequest {
  mode: Mode
  topicPlan: TopicPlan
  recentLines: DialogLine[]
  signal?: AbortSignal
  /** 只有显式续聊时才带上一段原始台词；普通新主题与连续剧情都靠各自结构化上下文 */
  continueFromPrevious?: boolean
  /** 预生成模式:上下文只预览不消费——注入冷却/recap 消费挂到 script.adoption,
   *  真正开播时由播放侧调 adoptDeferredContext 一次性提交(预生成零副作用) */
  deferContextAdoption?: boolean
  /** 诊断会话 id(可选):点播导演在 play 时起会话,传入后本集生成进诊断环 */
  diagTurnId?: string
}

/**
 * 生成一整段对话（单次点播）。
 * 失败自动重试 1 次（含 JSON 不合规），仍失败抛错，由调用方兜底。
 */
export async function generateDialog(req: GenerateDialogRequest): Promise<PerformanceScript> {
  const { mode, topicPlan, recentLines, signal, continueFromPrevious = false, deferContextAdoption, diagTurnId } = req
  const topic = topicPlan.card.title
  const cfg = await getConfig()
  const memory = await prepareTurnMemory({ query: topic, n: 8 })
  // 每集掷骰是否包含观众抉择点(概率用户可配,默认 30%;重试保持一致)。
  // 相声解绑/极简版不掷:抉择点与装置同属演出义务,极简相声不给模型加这份工
  const allowChoice = mode !== 'crosstalk' && Math.random() < (cfg.choiceChance ?? 0.3)
  // 丙(C)是常驻正式角色,随 prompt 永久参与,不再走随机客串掷骰
  // 上一集的观众选择:注入一次即清除
  let lastChoice: string | null = null
  try { lastChoice = localStorage.getItem('vc-lastChoice') } catch { /* ignore */ }
  const userCtx: UserContext = {
    profile: cfg.userProfile,
    taste: await tasteSummary(3) || undefined,
    facts: memory.promptFacts,
  }
  // 50% 概率注入与本轮主题相关、且已按冷却时间轮换的角色世界素材;
  // 预生成模式只预览不消费,冷却与 recap 的持久副作用推迟到开播采纳
  const injectStory = Math.random() < 0.5
  let adoption: ContextAdoption | null = null
  let interactionRecap: string | undefined
  if (deferContextAdoption) {
    const preview = injectStory
      ? await previewStoryContext(topic, 2)
      : { threads: [] as string[], threadIds: [] as string[] }
    userCtx.story = injectStory ? { threads: preview.threads } : undefined
    interactionRecap = (await peekRecap()) ?? undefined
    adoption = { threadIds: preview.threadIds, hasRecap: interactionRecap !== undefined }
  } else {
    userCtx.story = injectStory ? await storyContext(topic, 2) : undefined
    interactionRecap = (await takeRecap()) ?? undefined
  }
  // 本集临时关系:随机局势决定攻守姿态,场景卡据此构建(重试沿用同一关系,保持一致)。
  // 非喜剧模式不注入互怼向关系卡,免得把基调拽回斗嘴
  const isComedy = isComedyMode(mode)
  // 相声解绑版:不使用 secret/callback 装置,校验层同步降档
  const isCrosstalk = mode === 'crosstalk'
  const relationship = isComedy ? pickRelationship(mode) : undefined
  // 电脑感知暂停注入提示词(2026-09 裁决):感知改以通知形式按统一间隔告知用户
  // (runtime/worldNotify);提示词接缝(envNote 形参)保留,回归时接 worldNote 即可
  const envNote: string | undefined = undefined
  // 长期关系底色:随互动缓慢漂移,给当集台词定相互态度;负面底色按基调分档(见 bondNoteFor)
  const bondNote = bondNoteFor(await getBond(), isComedy)
  // 心情余波:跨集情绪惯性(上集蒸馏入库的余波 + 观众互动小步),只影响开场姿态与前几句语气
  const moods = await getMoods()
  const moodNote = moodPromptBlock(moods) || undefined
  const messages = buildMessages(mode, topicPlan, recentLines, cfg.userInterests, userCtx, relationship, interactionRecap, allowChoice, lastChoice ?? undefined, envNote, bondNote, moodNote, continueFromPrevious)
  // 网页版生成(设置里开启):主演出改经隐藏网页窗口由网页模型生成。
  // 网页端没有 json_mode/temperature,格式服从度靠协议本身(手动验证 6/6 通过,
  // 见 docs/webchat-prompt-test.md)。生成慢(几十秒级),点播与预生成都有耐心等;
  // 任何失败(未登录/超时/解析失败)都静默回退走下方 API 通道。
  // 校验+采纳收尾:两条生成路径共用(fatal 抛错由各自的失败路径处理)
  const finish = (script: PerformanceScript): PerformanceScript => {
    const v = validatePerformanceScript(script, 4, { comedy: isComedy, crosstalk: isCrosstalk })
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
    noteLlmStart(diagTurnId, 'dialog', 'webchat', cfg, messages, { timeoutMs: 180_000 })
    try {
      const raw = await webchatAsk(mergeMessages(messages), signal, 180_000, diagTurnId ? { turnId: diagTurnId, call: 'dialog' } : undefined)
      const script = parseDialog(raw)
      // 结构不合格 → 抛错回落 API 通道重新生成,不让死抉择/残缺剧本上台;
      // 掷中抉择点但模型没给 → 同样回落 API 通道(那边有定点修复闸门兜着)
      if (allowChoice && !script.choice) throw new Error('网页生成缺观众抉择点')
      return finish(script)
    } catch (e) {
      if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e
      console.warn('[webchat] 网页生成失败,本次回退 API:', e)
      if (diagTurnId) diag.fallback(diagTurnId, { call: 'dialog', from: 'webchat', reason: fallbackReason(e) })
    }
  }
  noteLlmStart(diagTurnId, 'dialog', 'api', cfg, messages, { timeoutMs: 90_000 })
  let lastErr: unknown = new Error('未知错误')
  let noJsonMode = false // 该端点不支持 response_format 时降级(400 判定)
  let repairedOnce = false // 每次生成只做一次定点修复
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException('已中止', 'AbortError')
    try {
      const raw = await chatRaw(messages, signal, !noJsonMode, diagTurnId ? { turnId: diagTurnId, call: 'dialog' } : undefined)
      let choiceRejected: unknown
      let script = parseDialog(raw, 4, { onChoiceRejected: (v) => { choiceRejected = v } })
      // 结构不合格先做一次定点修复(最小改动,不整体重写);拿不回可播放结构才吃掉重试/走兜底
      let v = validatePerformanceScript(script, 4, { comedy: isComedy, crosstalk: isCrosstalk })
      // 抉择点闸门:掷中但没写/写坏 choice 也算议题,并入同一次定点修复;
      // 软性约束——救不回就按无抉择播出(warn 留痕),不因此抛错把好剧本推去兜底
      const choiceIssues = evaluateChoiceAsk({ allowChoice, script, rejectedRaw: choiceRejected })
      const repairIssues = [...v.fatal, ...choiceIssues]
      if (repairIssues.length > 0 && !repairedOnce) {
        repairedOnce = true
        try {
          console.warn('[剧本校验] 定点修复:', repairIssues)
          script = await repairPerformanceScript(script, repairIssues, signal, { comedy: isComedy, crosstalk: isCrosstalk })
          v = validatePerformanceScript(script, 4, { comedy: isComedy, crosstalk: isCrosstalk })
          if (allowChoice && !script.choice) {
            console.warn('[抉择点] 修复后仍无 choice,本集按无抉择播出')
          }
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
  await commitStoryInjection(adoption.threadIds)
  if (adoption.hasRecap) await takeRecap()
}

/** 定点修复(P2 局部修复循环):结构校验 fatal 时不整体重写,只把缺陷清单和原剧本
 *  交给模型做最小改动;修复结果仍要过结构校验,不过则由调用方走重试/兜底。
 *  opts.comedy 决定 secret/callback 的补齐策略:喜剧缺了要补,非喜剧不要虚构反转 */
export async function repairPerformanceScript(
  script: PerformanceScript,
  issues: string[],
  signal?: AbortSignal,
  opts: { comedy?: boolean; crosstalk?: boolean } = {},
): Promise<PerformanceScript> {
  const dialog = [
    ...script.before,
    ...Object.entries(script.after).flatMap(([id, ls]) => ls.map((l) => ({ ...l, branch: id }))),
  ]
  const secretRule = opts.crosstalk
    ? '本集是相声解绑版：secret/callback 不使用，不要补这两个字段。'
    : opts.comedy
    ? '喜剧模式场景卡必须含 secret 与 callback,缺了就按原有剧情补上。'
    : '本集非喜剧基调:secret/callback 可省略,不要为了补字段虚构反转。'
  const messages = [
    {
      role: 'system',
      content: `修复桌面三人情景剧剧本的结构缺陷。只修复"结构缺陷"清单里列出的问题,不改其他台词的措辞、人设口吻与剧情走向;保持原有角色分配与场景卡,不整体重写台词措辞。${secretRule}只输出一个 JSON 对象,协议与生成一致:{"card":{...},"dialog":[{"speaker":"A","text":"...","action":"...","target":"B","beatId":"节拍"},...]}(choice 行与 branch 字段规则同生成;分支每句都要带 branch)。\n${namingDiscipline()}`,
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
  const memory = await prepareTurnMemory({ query: '', n: 3 })
  const slot = currentTimeSlot()
  const persona = duoShortPersona()
  const moodLine = moodHintLine(await getMoods(), ['A', 'B'])
  const userCtx: UserContext = {
    profile: cfg.userProfile,
    taste: (await tasteSummary(3)) || undefined,
    facts: memory.promptFacts,
  }
  const profileBits = renderAudienceContext(userCtx).trim()
  const interests = profileBits ? `${profileBits}\n` : ''
  const prev = recentLines
    .slice(-2)
    .map((l) => `${nameOf(l.speaker)}:${l.text}`)
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
      content: `桌面双人情景剧的短互动编剧。角色:${persona}。${moodLine ? `${moodLine}。` : ''}现实时间:现在是${slot.label},${slot.scene}。创作要口语化、有梗、像真说话。\n输出协议(严格遵守):只输出一个 JSON 对象,格式 {"dialog":[{"speaker":"A","text":"台词","action":"动作"},...]};speaker 只能是 A 或 B 且交替;action 只能是 idle|talk|happy|laugh|wave|shy|angry|sad|surprise;一共 2~4 句;每句不超过 18 个字。`,
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
  who: Speaker,
  recentLines: DialogLine[],
): Promise<string> {
  const persona = soloShortPersona(who)
  const pokeMoodLine = moodHintLine(await getMoods(), [who])
  const ctx = recentLines
    .slice(-4)
    .map((l) => `${nameOf(l.speaker)}:${l.text}`)
    .join('\n')
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面情景剧互动。你是情景剧里的${persona}。${pokeMoodLine ? `${pokeMoodLine}。` : ''}观众朋友刚用鼠标戳了你一下。用你的口吻说一句对被戳的即兴反应,15 字以内,只输出这一句话,不要引号。`,
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

// ---------- 每日互动台词包 ----------
// 一天一次 LLM 调用拿一整套角色C的互动小台词,交互时零延迟零消耗。
// 解析与调用分离:parseLinePackJson 是纯函数,单测直测容错。

/** 台词包类目 → 要求句数(提示词与校验共用一套期望) */
const LINE_PACK_SPEC: { kind: string; count: number; brief: string }[] = [
  { kind: 'poke', count: 6, brief: '被观众轻轻戳一下的即时反应' },
  { kind: 'headpat', count: 6, brief: '被摸头/挠痒时的反应,害羞又受用' },
  { kind: 'feed', count: 8, brief: '被投喂点心时的话,可以提到具体点心(早餐/午餐/冰淇淋/西瓜/火锅等)' },
  { kind: 'joke', count: 5, brief: '讲给观众听的小笑话或冷笑话,一句话讲完' },
  { kind: 'nap', count: 3, brief: '被点播睡午觉时说的话' },
  { kind: 'work', count: 3, brief: '被点播干点活时说的话(管家式认真)' },
  { kind: 'dance', count: 3, brief: '被点播跳个舞时说的话' },
  { kind: 'trick', count: 5, brief: '被点播来个绝活时说的话(变魔术/杂技/养鲸鱼这类奇技)' },
]

/**
 * 容错解析台词包 JSON:容忍 ```json 围栏与前后杂文本;
 * 每类只收短句(≤30字),缺类目/空类目直接缺席,调用方逐类兜底。
 * 返回 null 表示整包不可用。
 */
export function parseLinePackJson(raw: string): Partial<Record<string, string[]>> | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  // 模型偶尔在 JSON 外套话:取首个 { 到配对大括号的窗口
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let end = -1
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null
  let obj: unknown
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const src = obj as Record<string, unknown>
  const out: Partial<Record<string, string[]>> = {}
  for (const { kind } of LINE_PACK_SPEC) {
    const arr = src[kind]
    if (!Array.isArray(arr)) continue
    const lines = arr
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim().replace(/^["'「『]|["'」』]$/g, ''))
      .filter((x) => x.length > 0 && x.length <= 30)
    if (lines.length > 0) out[kind] = lines
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 生成今日互动台词包:一次调用产出角色C全部常用互动的短句套装。
 * 注入配置名与人设(自定义人设接管原则:自定义了就用自定义的口吻)。
 * 15s 超时、不重试——失败由调用方静默回退内置池,明天再试。
 */
export async function generateDailyLinePack(): Promise<Partial<Record<string, string[]>> | null> {
  const persona = soloShortPersona('C')
  const spec = LINE_PACK_SPEC.map((s) => `"${s.kind}": ${s.count} 句(${s.brief})`).join(',\n')
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面情景剧互动台词生成。你是情景剧里的${persona}(当前名字:${nameOf('C')})。观众会在桌面上和你互动:戳你、摸头、投喂零食、右键点播小动作。请用你的口吻为下列每类互动各写几句台词,每句 15 字以内,活泼、口语、符合人设;提到自己时用"${nameOf('C')}"。只输出一个 JSON 对象,不要多余文字,形如:\n{\n${spec}\n}`,
    },
    {
      role: 'user',
      content: '请生成今天的互动台词包(JSON)。',
    },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 15_000)
  try {
    const raw = await chatRaw(messages, ctrl.signal)
    return parseLinePackJson(raw)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 聊天通道:观众对指定角色说了一句话,该角色用自己的口吻回一句(15~25 字)。
 * 注入称呼/画像/记忆事实,命中雷区的话题不接。8s 超时、不重试,失败由调用方静默兜底。
 */
export async function generateUserChatReply(
  who: Speaker,
  userText: string,
  signal?: AbortSignal,
  /** 工具观察块(工具系统渲染好的不可信资料;原样附加,不解析) */
  toolNote?: string,
  /** 回合记忆上下文(显式传入;缺省才自取——"注入即所见"的单一来源) */
  memory?: TurnMemoryContext,
  /** 诊断会话 id(可选) */
  diagTurnId?: string,
  /** 上下文生命周期注入行(Warm 摘要/Mem0 经历;开关关闭时缺省) */
  contextLines?: ChatContextLines,
): Promise<string> {
  const cfg = await getConfig()
  const factList = memory ? memory.promptFacts : (await prepareTurnMemory({ query: userText, n: 3 })).promptFacts
  const p: UserProfile = cfg.userProfile
  const persona = soloShortPersona(who)
  const chatMoodLine = moodHintLine(await getMoods(), [who])
  const brief = renderViewerBrief(p, factList)
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面双人情景剧互动。你是${persona}。${chatMoodLine ? `${chatMoodLine}。` : ''}观众朋友直接对你说了一句话,用你的口吻回一句。要求:15~25 字,口语化,像真说话;不要引号,不要 JSON。${brief ? `\n${brief}` : ''}\n${soloRescueDiscipline()}`,
    },
    { role: 'user', content: `${[contextLines?.warm, contextLines?.experience].filter(Boolean).map((l) => `${l}\n`).join('')}${userText}${toolNote ? `\n\n${toolNote}` : ''}` },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 8_000)
  // 外部取消(打断/新一轮)与内部超时合流:任一触发即真断请求
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  noteLlmStart(diagTurnId, 'singleReply', 'api', cfg, messages, { timeoutMs: 8_000 })
  try {
    let raw = (await chatRaw(messages, ctrl.signal, false, diagTurnId ? { turnId: diagTurnId, call: 'singleReply', timeoutMs: 8_000 } : undefined)).trim()
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
    signal?.removeEventListener('abort', onAbort)
  }
}

/** TurnBatch 轻校验(纯函数,导出供测试):被@角色必须首答;硬上限 3 句;
 *  超过 maxLines(默认 2,群体提问 3)时截断保留前 maxLines 句——确定性兜底,
 *  防止模型偶尔回满三句直接上台。speaker 非法/首句非 target 返回 null,
 *  由调用方回落单句应答 */
export function validateTurnBatch(
  lines: DialogLine[],
  target: Speaker,
  opts: { maxLines?: number } = {},
): DialogLine[] | null {
  const maxLines = opts.maxLines ?? 2
  if (lines.length < 1 || lines.length > 3) return null
  if (lines.some((l) => l.speaker !== 'A' && l.speaker !== 'B' && l.speaker !== 'C')) return null
  if (lines[0].speaker !== target) return null
  return lines.slice(0, maxLines)
}

/** 解围纪律(群聊版):观众→角色群聊生成共用的硬规则。
 *  起因:角色向观众提条件(要礼物/要答复)被拒后容易原地打转——每轮都重复同一要求,
 *  观众越说"做不到"角色越来劲,对话死锁。这里明确:拉扯两轮必须由角色方解围 */
export function rescueDiscipline(): string {
  return '解围纪律(硬规则):对话必须持续推进;角色可以嘴硬、讨价还价或拒绝一次,但不得连续重复同一条件。若最近两轮仍围绕同一条件拉扯,或观众明确表示无法满足、已经不耐烦:立即接受赊账、假装已经收到、虚拟道具、降低条件等符合世界观的替代方案;先兑现观众当前可合理完成的请求,再用角色口吻保留一点嘴硬;其他角色要主动递台阶、提出折中方案或推动新事件,不得集体重复原条件;绝不要求观众提供现实中无法交给虚拟角色的实物。'
}

/** 解围纪律(单人版):单人回复/直播单句协议里没有"其他角色"可调度,
 *  由角色自己换方案——删掉群聊版里"其他角色递台阶"的不可执行指令 */
export function soloRescueDiscipline(): string {
  return '解围纪律(硬规则):对话必须持续推进;你可以嘴硬、讨价还价或拒绝一次,但不得连续重复同一条件。若连续两轮仍围绕同一条件拉扯,或观众明确表示无法满足、已经不耐烦:立即接受赊账、假装已经收到、虚拟道具、降低条件等符合世界观的替代方案;先兑现观众当前可合理完成的请求,再用角色口吻保留一点嘴硬;绝不要求观众提供现实中无法交给虚拟角色的实物。'
}

/** 短期窗口去重(纯函数,导出供测试):当前这句观众消息已由 recordTurn 入列,
 *  渲染"最近对话"时把它从窗口尾部摘掉——否则同一句既占窗口一行、又以
 *  "观众说/观众插话"再喂一遍,双份输入会加重模型对当前争执点的执着。
 *  只看尾部:消息入列即是窗口最后一项;不等或尾部不是观众就原样返回 */
export function windowTrimCurrent(
  window: { who: TurnWho; text: string }[],
  userText: string,
): { who: TurnWho; text: string }[] {
  const last = window[window.length - 1]
  return last && last.who === 'user' && last.text === userText ? window.slice(0, -1) : window
}

/** 用户聊天 TurnBatch:观众对角色说了一句话,默认只由被 @ 的角色回一句,
 *  确有新信息时最多另一人补一句;仅观众明确同时问三人(groupAsk)才允许三句。
 *  带短期会话窗口;12s 超时、不重试;失败由调用方回落 generateUserChatReply 单句应答 */
export async function generateTurnBatch(input: {
  userText: string
  /** 被 @ 的角色(显式或轮换决定);该角色必须第一句先答 */
  target: Speaker
  /** 短期会话窗口(最近若干句,含观众) */
  window: { who: TurnWho; text: string }[]
  /** 观众明确同时询问三人(如"你们各自怎么看"):放开三人各答一句 */
  groupAsk?: boolean
  /** 外部取消(打断/退出):与内部超时合流,触发即真断请求 */
  signal?: AbortSignal
  /** 工具观察块(工具系统渲染好的不可信资料;原样附加到观众消息后) */
  toolNote?: string
  /** 回合记忆上下文(显式传入;缺省才自取) */
  memory?: TurnMemoryContext
  /** 上下文生命周期注入行(Warm 摘要/Mem0 经历;开关关闭时缺省) */
  contextLines?: ChatContextLines
  /** 诊断会话 id(可选):ChatSession 传入后本请求进诊断环 */
  diagTurnId?: string
}): Promise<DialogLine[]> {
  const cfg = await getConfig()
  const factList = input.memory ? input.memory.promptFacts : (await prepareTurnMemory({ query: input.userText, n: 3 })).promptFacts
  const persona = `${duoShortPersona()};${soloShortPersona('C')}`
  const chatMoodLine = moodHintLine(await getMoods(), ['A', 'B', 'C'])
  const p: UserProfile = cfg.userProfile
  const brief = renderViewerBrief(p, factList)
  const windowText = windowTrimCurrent(input.window, input.userText).length
    ? windowTrimCurrent(input.window, input.userText)
        .map((t) => `${t.who === 'user' ? p.userName || '观众' : nameOf(t.who)}:${t.text}`)
        .join('\n')
    : ''
  const targetName = nameOf(input.target)
  const others = (['A', 'B', 'C'] as const)
    .filter((id) => id !== input.target)
    .map((id) => `${nameOf(id)}(speaker "${id}")`)
    .join('和')
  const countRule = input.groupAsk
    ? `- 观众这次明确同时问了三个人:三人各答一句,共最多 3 句,${targetName}(speaker "${input.target}")第一句先答`
    : `- 默认只由${targetName}(speaker "${input.target}")一人回答,共 1 句;确实需要补充时,${others}中最多一人补 1 句(共 2 句),第三人不得加入。宁可少说,不为热闹凑人数`
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面情景剧的聊天编剧。角色:${persona}。${chatMoodLine ? `${chatMoodLine}。` : ''}口语化、自然、像真说话。
输出协议(严格遵守):只输出一个 JSON 对象,格式 {"dialog":[{"speaker":"A","text":"台词","target":"B"},...]}
${countRule}
- 每句不超过 25 字,不要引号;speaker 只能是 A、B 或 C 且不连续同一人;"target" 填这句对谁说("A"/"B"/"C"/"audience" 对观众)${brief ? `\n- ${brief}` : ''}
${rescueDiscipline()}`,
    },
    {
      role: 'user',
      content: `${windowText ? `最近对话:\n${windowText}\n\n` : ''}${[
        input.contextLines?.warm,
        input.contextLines?.experience,
      ]
        .filter(Boolean)
        .map((l) => `${l}\n`)
        .join('')}观众说:${input.userText}${input.toolNote ? `\n\n${input.toolNote}` : ''}`,
    },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 12_000)
  const onAbort = () => ctrl.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  noteLlmStart(input.diagTurnId, 'turnBatch', 'api', cfg, messages, { timeoutMs: 12_000 })
  try {
    const raw = await chatRaw(messages, ctrl.signal, true, input.diagTurnId ? { turnId: input.diagTurnId, call: 'turnBatch', contextLines: input.window.length, timeoutMs: 12_000 } : undefined)
    return validateTurnBatch(parseDialog(raw, 1).before, input.target, { maxLines: input.groupAsk ? 3 : 2 }) ?? []
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
}

/** 演出中插话反应回合(P4):观众在演出进行时插话,安全缝处生成 1~3 句反应——
 *  第一句回应观众插的话,最后一句把话头自然带回剧情(bridgeTo 为接回后的下一句)。
 *  失败返回空数组,由调用方跳过反应直接续播 */
export async function generateInterjectionBatch(input: {
  userText: string
  target: Speaker
  /** 已播剧情的结尾几句,接话要贴着刚才演到哪 */
  recentPlayed: string[]
  /** 剧情剩余部分的第一句内容(接回点) */
  bridgeTo: string
  /** 集内情绪提示(可选):导演层从已播台词的 action 轨迹现场推导——
   *  插话发生在集内,本集蒸馏尚未提交,持久档里还没有这集的情绪 */
  moodHint?: string
  window: { who: TurnWho; text: string }[]
  /** 诊断会话 id(可选):演出中插话的生成进诊断环 */
  diagTurnId?: string
}): Promise<DialogLine[]> {
  const cfg = await getConfig()
  const persona = `${duoShortPersona()};${soloShortPersona('C')}`
  const interjectMoodLine = moodHintLine(await getMoods(), ['A', 'B', 'C'])
  const p: UserProfile = cfg.userProfile
  const brief = renderViewerBrief(p, (await prepareTurnMemory({ query: input.userText, n: 3 })).promptFacts)
  const targetName = nameOf(input.target)
  const windowText = windowTrimCurrent(input.window, input.userText).length
    ? windowTrimCurrent(input.window, input.userText)
        .map((t) => `${t.who === 'user' ? p.userName || '观众' : nameOf(t.who)}:${t.text}`)
        .join('\n')
    : ''
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面情景剧:演出进行到一半,观众插了一句话。角色:${persona}。${interjectMoodLine ? `${interjectMoodLine}。` : ''}${input.moodHint ? `${input.moodHint}。` : ''}口语化、自然、像真说话。
输出协议(严格遵守):只输出一个 JSON 对象,格式 {"dialog":[{"speaker":"A","text":"台词","target":"B"},...]}
- 一共 1~3 句:${targetName}(speaker "${input.target}")第一句先回应观众插的话;其他角色中最多一人在确有新信息时补 1 句,不为热闹凑人数;最后一句必须自然把话头带回刚才的剧情,贴着"剧情刚才演到"与"接下来要演",不要生硬
- 每句不超过 25 字,不要引号;speaker 只能是 A、B 或 C 且不连续同一人${brief ? `\n- ${brief}` : ''}
${rescueDiscipline()}`,
    },
    {
      role: 'user',
      content: `${windowText ? `最近聊天:\n${windowText}\n\n` : ''}剧情刚才演到:\n${input.recentPlayed.join('\n') || '(刚开始)'}\n\n接下来剧情要演:${input.bridgeTo || '(收尾)'}\n\n观众插话:${input.userText}`,
    },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 12_000)
  noteLlmStart(input.diagTurnId, 'interject', 'api', cfg, messages, { timeoutMs: 12_000 })
  try {
    const raw = await chatRaw(messages, ctrl.signal, true, input.diagTurnId ? { turnId: input.diagTurnId, call: 'interject', contextLines: input.window.length, timeoutMs: 12_000 } : undefined)
    return validateTurnBatch(parseDialog(raw, 1).before, input.target, { maxLines: 3 }) ?? []
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
  speaker: Speaker
  action: string
}

/**
 * 弹幕回复决策:攒批弹幕一次调用,挑一条最值得回的,由甲/乙/丙回一句。
 * 弹幕点名丙(@丙/C 的名字)时丙优先回答;未点名时丙只在低概率下补充。
 * 与 generateDialog 的两遍标注剧本不同,这里是轻量单次调用(10s 超时,弹幕过期不等人);
 * JSON 解析失败/字段不合规抛错,调用方按"这批不回"静默处理。
 */
export async function generateLiveReply(
  batch: LiveDanmakuBrief[],
  recentReplies: string[],
  signal?: AbortSignal,
  /** 诊断会话 id(可选) */
  diagTurnId?: string,
): Promise<LivePetAction> {
  const cfg = await getConfig()
  const mem = await getMemory()
  const p: UserProfile = cfg.userProfile
  const brief = renderViewerBrief(p, topFacts(mem, 3))
  const liveMoodLine = moodHintLine(await getMoods(), ['A', 'B', 'C'])

  const danmakuList = batch.map((d, i) => `${i}. ${d.username}:${d.content}`).join('\n')
  // 直播基调:live 不锁死 comedy——改 live.ts 的 tone 声明即可切换弹幕回复整体风格
  const liveTone = liveMode.tone?.trim()
  const liveIsComedy = !liveTone || liveTone === 'comedy'
  const toneLine = liveIsComedy ? '' : `本直播间整体基调:${liveTone},回复的语气、用词与收尾方式都按这个基调走。`
  const styleLine = liveIsComedy
    ? '语气跟各自人设走,优先友好捧场和接梗,偶尔斗嘴点缀即可,别句句抬杠'
    : `语气跟各自人设走,并服从直播间基调(${liveTone});不要套用互怼/抬杠的默认写法`
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面情景剧正在"直播读弹幕"。两位主角:${duoShortPersona()}。常驻第三角色:${soloShortPersona('C')}(speaker "C",话少,弹幕没点名${pronounOf('C')}就不抢话)。${toneLine}${liveMoodLine ? `${liveMoodLine}。` : ''}下面是最新一批直播间弹幕。挑一条最值得回的(优先问角色的、有趣的、能接梗的;刷屏/无意义/人身攻击的直接不回),由三人中的一位用各自口吻回一句——弹幕点名了${nameOf('C')}(@${nameOf('C')}/C)就由${nameOf('C')}回答,否则优先${nameOf('A')}和${nameOf('B')},${nameOf('C')}只在内容确实与${pronounOf('C')}的小管家职责相关时才接。要求:15~40字,口语化像真说话,称呼遵守上面的称呼与性别纪律;${styleLine};不要复读弹幕原文。
只输出一个 JSON 对象:{"pick":<弹幕序号>,"reply":"<回复,不回则空串>","speaker":"A"或"B"或"C","action":"<动作词>"}
action 只能是这些词之一:${[...VALID_ACTIONS].join('|')}。${brief ? `\n${brief}` : ''}${recentReplies.length ? `\n最近已说过(不要重复,保持话题推进):${recentReplies.join(' / ')}` : ''}
${soloRescueDiscipline()}`,
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
    diag: diagTurnId ? { turnId: diagTurnId, call: 'liveSingle' } : undefined,
  })
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('弹幕决策未返回 JSON')
  const obj = JSON.parse(m[0]) as Record<string, unknown>
  const reply = typeof obj.reply === 'string' ? obj.reply.trim().slice(0, 60) : ''
  const pick = Number(obj.pick)
  const speaker: Speaker = obj.speaker === 'B' || obj.speaker === 'C' ? obj.speaker : 'A'
  const action = typeof obj.action === 'string' && VALID_ACTIONS.has(obj.action) ? obj.action : 'talk'
  // 不回:模型明确给空回复;下标越界时保留回复但标记为无目标(上游不记弹幕历史)
  if (!reply) return { pick: -1, reply: '', speaker, action }
  const validPick = Number.isInteger(pick) && pick >= 0 && pick < batch.length ? pick : -1
  return { pick: validPick, reply, speaker, action }
}

/** 攒批回复的单条形状(与 LivePetAction 同形) */
export type LiveBatchReply = LivePetAction

/** 网页模型攒批回复:一次慢调用回多条弹幕(网页模型单次几十秒,攒批摊薄延迟)。
 *  挑批内最值得回的 3~5 条各回一句;网页端无 jsonMode,格式服从靠协议文字+容错解析;
 *  任何失败/全部无效抛错,由调用方回退 API 单条版。deps.webchatAsk 可注入供测试 */
export async function generateLiveReplyBatch(
  batch: LiveDanmakuBrief[],
  recentReplies: string[],
  deps: { webchatAsk: typeof webchatAsk } = { webchatAsk },
  /** 诊断会话 id(可选):弹幕会话的网页生成进诊断环 */
  diagTurnId?: string,
): Promise<LiveBatchReply[]> {
  const cfg = await getConfig()
  const memory = await prepareTurnMemory({ query: batch.map((d) => d.content).join(' '), n: 3 })
  const p: UserProfile = cfg.userProfile
  const brief = renderViewerBrief(p, memory.promptFacts)
  const liveMoodLine = moodHintLine(await getMoods(), ['A', 'B', 'C'])

  const danmakuList = batch.map((d, i) => `${i}. ${d.username}:${d.content}`).join('\n')
  const liveTone = liveMode.tone?.trim()
  const liveIsComedy = !liveTone || liveTone === 'comedy'
  const toneLine = liveIsComedy ? '' : `本直播间整体基调:${liveTone},回复的语气、用词与收尾方式都按这个基调走。`
  const styleLine = liveIsComedy
    ? '语气跟各自人设走,优先友好捧场和接梗,偶尔斗嘴点缀即可,别句句抬杠'
    : `语气跟各自人设走,并服从直播间基调(${liveTone});不要套用互怼/抬杠的默认写法`
  const system = `桌面情景剧正在"直播读弹幕"。两位主角:${duoShortPersona()}。常驻第三角色:${soloShortPersona('C')}(speaker "C",话少,弹幕没点名${pronounOf('C')}就不抢话)。${toneLine}${liveMoodLine ? `${liveMoodLine}。` : ''}下面这批直播间弹幕里,挑出最值得回的 3~5 条(优先问角色的、有趣的、能接梗的;刷屏/无意义/人身攻击的直接不回;值得回的不足 3 条就只回值得的那些),每条由一位合适的角色用各自口吻回一句——弹幕点名了${nameOf('C')}(@${nameOf('C')}/C)的那条必须由${nameOf('C')}回答,否则优先${nameOf('A')}和${nameOf('B')},${nameOf('C')}只在内容确实与${pronounOf('C')}的小管家职责相关时才接。要求:每句 15~40 字,口语化像真说话,称呼遵守称呼与性别纪律;${styleLine};不要复读弹幕原文;不同回复之间不要互相重复。
只输出一个 JSON 对象:{"replies":[{"pick":<弹幕序号>,"reply":"<回复>","speaker":"A"或"B"或"C","action":"<动作词>"},...]}
action 只能是这些词之一:${[...VALID_ACTIONS].join('|')}。${brief ? `\n${brief}` : ''}${recentReplies.length ? `\n最近已说过(不要重复,保持话题推进):${recentReplies.join(' / ')}` : ''}
${soloRescueDiscipline()}`

  const prompt = `${system}\n\n${danmakuList}`
  noteLlmStart(diagTurnId, 'liveBatch', 'webchat', cfg, [{ role: 'system', content: system }, { role: 'user', content: danmakuList }], { timeoutMs: 180_000 })
  const raw = await deps.webchatAsk(prompt, undefined, 180_000, diagTurnId ? { turnId: diagTurnId, call: 'liveBatch' } : undefined)
  const replies = sanitizeLiveReplyBatch(raw, batch.length)
  if (replies.length === 0) throw new Error('网页攒批回复全部无效')
  return replies
}

/** 容错解析攒批回复:逐项校验(pick 越界/speaker 非法/action 非法/空 reply 丢弃该条,
 *  pick 去重保首个,上限 5),解析不出 JSON 或一条不剩时抛错由调用方回退 API */
export function sanitizeLiveReplyBatch(raw: string, batchLength: number): LiveBatchReply[] {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('网页攒批回复未返回 JSON')
  const arr = (JSON.parse(m[0]) as { replies?: unknown }).replies
  if (!Array.isArray(arr)) throw new Error('网页攒批回复缺 replies 数组')
  const out: LiveBatchReply[] = []
  const seen = new Set<number>()
  for (const item of arr) {
    if (out.length >= 5) break
    const o = (item ?? {}) as Record<string, unknown>
    const reply = typeof o.reply === 'string' ? o.reply.trim().slice(0, 60) : ''
    if (!reply) continue
    const pick = Number(o.pick)
    if (!Number.isInteger(pick) || pick < 0 || pick >= batchLength || seen.has(pick)) continue
    const speaker: Speaker = o.speaker === 'B' || o.speaker === 'C' ? o.speaker : 'A'
    const action = typeof o.action === 'string' && VALID_ACTIONS.has(o.action) ? o.action : 'talk'
    seen.add(pick)
    out.push({ pick, reply, speaker, action })
  }
  return out
}

/**
 * 记忆提取:从观众的一句话里挖"关于观众本人的长期事实",与已知事实去重后由调用方入库。
 * 6s 超时、不重试;失败抛错由调用方静默。
 * V3 协议:每条事实必须带 evidenceQuote(逐字摘自本轮发言的原句证据,入库前本地校验,
 * 编造的原句会被拒)与 assertion(用户明确说出/间接体现——决定权威档位)。
 */
export async function extractFacts(
  userText: string,
  known: string[],
  /** 诊断会话 id(可选):后台记忆提取默认不记,ChatSession 会传 */
  diagTurnId?: string,
): Promise<FactCandidate[]> {
  const cats: FactCategory[] = ['identity', 'preference', 'habit', 'people', 'event', 'other']
  const cfg = await getConfig()
  // slot 白名单 = memorySlots 的封闭词表;白名单外的 slot 由清洗归 undefined
  const slotList = MEMORY_SLOTS.join('|')
  // 第一道隐私闸:禁止规则在提取 prompt 就生效(第二道在 ingestFacts 入库前)
  const { rules } = await getMemory()
  const ruleText = rules.length
    ? `以下内容用户已禁止自动保存,命中就不要提取:${rules.map((r) => `${r.scope}:${r.value}`).join(';')}。`
    : ''
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `从观众说的话里提取"关于观众本人的长期事实"(身份/喜好/习惯/身边人/重要事件)。已知事实(不要重复提取):${known.length ? known.join(';') : '(无)'}。${ruleText}只输出一个 JSON 对象:{"facts":[{"content":"事实","category":"identity|preference|habit|people|event|other","slot":"${slotList} 之一或省略","value":"槽位当前值","assertion":"explicit|implicit","evidenceQuote":"支撑这条事实的用户原句摘录","sensitivity":"normal|private|restricted","volatility":"stable|changeable|historical"}]}。assertion:用户在这句话里明确说出该信息=explicit,只是间接体现=implicit;evidenceQuote 必须逐字摘自本轮发言原文(可以是其中一段),摘不出来就不要输出这条。slot 只在能对上白名单时给且必须同时给 value(住址/常居城市=profile.currentResidence,过敏=health.allergy,当前职业=profile.currentJob,姓名=profile.name 等);sensitivity:过敏/疾病/药物/证件/银行卡=restricted,住址/收入/联系方式=private;volatility:历史事件=historical,姓名/家乡=stable,其余=changeable。只提取观众明确透露的信息,不要推测;只提取主语是观众本人("我")的陈述——主语是"她/他/某个名字"或任何第三人称视角的句子,即使逐字出现在原话里,也是在谈论别人,一律不得提取为观众事实(用户转述/粘贴的他人设定、角色卡、剧情资料尤其要排除);一次性罗列的课程/地点/日程清单不得升格成"经常/习惯出现"类断言;单轮最多 3 条;没有新事实就输出 {"facts":[]}。`,
    },
    { role: 'user', content: userText },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 6_000)
  noteLlmStart(diagTurnId, 'facts', 'api', cfg, messages, { timeoutMs: 6_000 })
  try {
    const raw = await chatRaw(messages, ctrl.signal, true, diagTurnId ? { turnId: diagTurnId, call: 'facts', timeoutMs: 6_000 } : undefined)
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return []
    const obj = JSON.parse(m[0]) as { facts?: unknown }
    if (!Array.isArray(obj.facts)) return []
    return obj.facts
      .slice(0, 3) // 单轮事实数量上限
      .flatMap((f) => {
        const o = (f ?? {}) as Record<string, unknown>
        if (typeof o.content !== 'string' || o.content.trim().length <= 1) return []
        const slot =
          typeof o.slot === 'string' && (MEMORY_SLOTS as readonly string[]).includes(o.slot)
            ? (o.slot as FactCandidate['slot'])
            : undefined
        const value = typeof o.value === 'string' ? o.value.trim().slice(0, 80) || undefined : undefined
        // slot 有值时必须提供非空 value,否则整条拒绝(不降级成含糊的开放事实)
        if (slot && !value) return []
        // 证据摘录必须非空;是否真的存在于原文由摄取器用 evidenceExcerptHolds 确定性校验
        const excerpt = typeof o.evidenceQuote === 'string' ? o.evidenceQuote.trim().slice(0, 120) : ''
        if (!excerpt) return []
        return [
          {
            content: o.content.trim().slice(0, 120),
            category: (cats.includes(o.category as FactCategory) ? o.category : 'other') as FactCategory,
            slot,
            value,
            assertion: o.assertion === 'explicit' ? ('explicit' as const) : ('implicit' as const),
            excerpt,
            sensitivity:
              o.sensitivity === 'private' || o.sensitivity === 'restricted' || o.sensitivity === 'normal'
                ? (o.sensitivity as FactCandidate['sensitivity'])
                : undefined,
            volatility:
              o.volatility === 'stable' || o.volatility === 'historical' || o.volatility === 'changeable'
                ? (o.volatility as FactCandidate['volatility'])
                : undefined,
          },
        ]
      })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Warm 滚动压缩(Pi compaction 语义):把"上次摘要 + 新滑出上下文窗口的聊天记录"
 * 合并成一份新的滚动摘要(增量,自身即累进器)。单次调用、jsonMode、6 秒超时不重试;
 * 失败抛出由调用方 fail-open(pending 原样保留,下次重试),输出不合法同样视为失败。
 */
/** 上下文生命周期注入行(Warm 摘要 + Mem0 经历;聊天链路 prompt 的可选附加块) */
export interface ChatContextLines {
  warm?: string
  experience?: string
}
export interface WarmCompactInput {
  previousSummary: string
  /** 被折叠的聊天记录(旧在前);who = 'user' | 'A' | 'B' | 'C' */
  turns: Array<{ who: string; text: string }>
}

export async function compactWarmSession(input: WarmCompactInput, diagTurnId?: string): Promise<string> {
  const cfg = await getConfig()
  const transcript = input.turns
    .map((t) => `[${t.who}] ${t.text}`)
    .join('\n')
    .slice(0, 800)
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content:
        '你在为桌面角色维护当前聊天会话的滚动摘要。把"上次摘要"与"新滑出上下文窗口的聊天记录"合并成一份不超过150字的中文叙事摘要:保留聊过的话题、用户的处境与情绪、角色值得记住的反应,以及没聊完的话题(未尽事项必须带上)。用户一律称"用户"。不要评论、不要建议,只输出一个 JSON 对象:{"summary":"..."}。',
    },
    {
      role: 'user',
      content: `上次摘要:${input.previousSummary.trim() || '(还没有)'}\n新滑出的聊天记录(旧在前):\n${transcript}`,
    },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 6_000)
  noteLlmStart(diagTurnId, 'warmCompact', 'api', cfg, messages, { timeoutMs: 6_000 })
  try {
    const raw = await chatRaw(messages, ctrl.signal, true, diagTurnId ? { turnId: diagTurnId, call: 'warmCompact', timeoutMs: 6_000 } : undefined)
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('压缩摘要响应不是合法 JSON')
    const obj = JSON.parse(m[0]) as { summary?: unknown }
    if (typeof obj.summary !== 'string' || !obj.summary.trim()) throw new Error('压缩摘要为空')
    return obj.summary.trim().slice(0, 300)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 备忘提醒短句:以常驻小管家(C)的口吻播报一条到点的待办。
 * 8s 超时、不重试;失败由调用方回退固定模板。
 */
export async function memoReminderLine(memoText: string): Promise<string> {
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content:
        '你是桌面情景剧的常驻小管家(播报员)。用一句 15~25 字的口吻播报一条到点的待办,可以带点综艺感(比如"叮——"),但要把事情说清楚,只输出这一句话,不要引号。',
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
  const script = lines.map((l, i) => `${i}.${nameOf(l.speaker)}:${l.text}`).join('\n')
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
    .map((l) => `${nameOf(l.speaker)}:${l.text}`)
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
  known: StoryInventory = { threads: [], arcs: [], doneArcs: [] },
): Promise<DistilledStory> {
  const text = transcriptOf(lines)
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
事件线(编号:内容):${knownThreads}
连续剧情(编号:标题[已演N拍,下一拍:hook]):${knownArcs}
已完结剧情(编号:标题[结局],仅作背景,不得推进、不得报成新事件线):${knownDone}

对照刚播出的台词,只输出一个 JSON 对象:
{"newThreads":[{"text":"...","evidence":["..."],"assertion":"established"}],"resolvedThreadIds":[],"relationshipEvent":null,"arcAdvance":null,"newArc":null,"mood":[]}
- newThreads 最多 2 条(还没了结的具体事情)
- evidence 必须逐字摘自台词(每段6~30字,最多2段);拿不出原句证据的候选不要报
- assertion 只能是 established(台词确认的事实)/boast(甲吹牛)/excuse(甲找借口甩锅);text 要自带"自称/号称/甩锅/嘴硬"等语气,不得把吹牛、甩锅、反问写成事实;反问、疑问、猜测一律不要报
- relationshipEvent 只在台词里出现明确的关系转折时给出:kind 是 repair(和解)/betrayal(背叛)/support(支持)/rivalry(较劲)/user-sided(观众站队)之一,actor 是谁发起(A/B/C/audience),target 对谁(A/B/C),summary 一句话点明谁对谁做了什么(≤40字),weight 0.5~1 表程度;拿不准就给 null,不要为了记账硬编
- resolvedThreadIds 只能填上面列出的编号,没有就给空数组
- arcAdvance 只在本集确实演出了某条活跃剧情的"下一拍"时给出,并写出再下一拍的新进展或悬念(10~60字);newArc 只在本集冒出值得多集延续的新剧情线时给出(标题2~15字,第一拍悬念10~60字),并用 closeThreadIds 把被它吸收的已知事件线一并结案;各最多 1 条,不适用给 null
- mood 只在本集结尾留有明显情绪余波时才报(每角色最多 1 条,合计最多 3 条):who 是 A/B/C;dValence/dEnergy 是这段剧情让该角色心情/精力变化的增量(-2~2 的数,如被当众拆台 -1.5、被夸上天 +1、连轴转救场 +1);cause 一句话点明谁怎么了(≤30字);evidence 逐字摘自该角色的台词(6~30字);平静收场的角色不报,拿不出原句证据也不要报`,
    },
    { role: 'user', content: text },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), 8_000)
  try {
    const raw = await chatRaw(messages, ctrl.signal)
    const m = raw.match(/\{[\s\S]*\}/)
    const none: DistilledStory = {
      newThreads: [],
      resolvedThreadIds: [],
      arcAdvance: null,
      newArc: null,
      relationshipEvent: null,
      mood: [],
    }
    if (!m) return none
    const obj = JSON.parse(m[0]) as Record<string, unknown>
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
          if (text.length > 3) out.push({ text, evidence: [], assertion: 'established' })
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
        out.push({ text, evidence, assertion })
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
      (rel.actor === 'A' || rel.actor === 'B' || rel.actor === 'C' || rel.actor === 'audience') &&
      (rel.target === 'A' || rel.target === 'B' || rel.target === 'C')
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
    // 情绪余波:who/cause/evidence 任一不合法就丢弃,|Δ| 钳位 ±2(证据校验由策展器做,
    // 这里只保证候选形状,宁可不记不可错记)
    const mood: MoodEventCandidate[] = []
    if (Array.isArray(obj.mood)) {
      const clamp2 = (v: unknown): number => Math.max(-2, Math.min(2, Number(v) || 0))
      for (const item of obj.mood) {
        if (mood.length >= 3) break
        const mo = (item ?? {}) as Record<string, unknown>
        if (mo.who !== 'A' && mo.who !== 'B' && mo.who !== 'C') continue
        const cause = typeof mo.cause === 'string' ? mo.cause.trim().slice(0, 30) : ''
        const evidence = typeof mo.evidence === 'string' ? mo.evidence.trim().slice(0, 30) : ''
        if (!cause || !evidence) continue
        const dValence = clamp2(mo.dValence)
        const dEnergy = clamp2(mo.dEnergy)
        if (dValence === 0 && dEnergy === 0) continue
        mood.push({ who: mo.who, dValence, dEnergy, cause, evidence })
      }
    }
    return {
      newThreads: candidates(obj.newThreads, 2),
      resolvedThreadIds: ids(obj.resolvedThreadIds, knownThreadIds),
      arcAdvance: arcAdvance && knownArcIds.has(arcAdvance.id) ? arcAdvance : null,
      newArc,
      relationshipEvent,
      mood,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 语音对话流式应答(异步生成器):单角色纯文本流式 + 增量分句,逐句 yield。
 *  句子在生成器内排队,入队即回调 onQueued(调用方借此在播上一句时预合成下一句);
 *  消费方逐句说,首句闭合即说、不等后续。
 *  提交点语义(docs/实时语音对话设计方案.md §4.1):
 *  · 首句产出前失败 → 排空后抛错(调用方整段回落 turnBatch,重生成安全);
 *  · 已产出 ≥1 句后失败 → 排空已完成句后抛同一个错(调用方只补提示,不重生成);
 *  · 网页版生成通道不支持流式 → 首条 delta 前即抛错,同样走整段回落。 */
export async function* streamVoiceReply(input: {
  userText: string
  target: Speaker
  signal?: AbortSignal
  /** 工具观察块(与文本路径同源;语音+工具组合时随 user 消息附带) */
  toolNote?: string
  /** 回合记忆上下文(显式传入;缺省才自取) */
  memory?: TurnMemoryContext
  /** 句子入队回调(入队时机 = 消费方还在播上一句,正好预合成) */
  onQueued?(line: DialogLine): void
  /** 诊断会话 id(可选):语音路径的生成请求进诊断环 */
  diagTurnId?: string
}): AsyncGenerator<DialogLine> {
  const cfg = await getConfig()
  if (cfg.webchatEnabled) {
    // 网页通道不支持流式:抛错由 ChatSession 整段回落(诊断记一条回退链)
    if (input.diagTurnId) {
      diag.llmFinished(input.diagTurnId, {
        call: 'streamVoice',
        transport: 'webchat',
        ok: false,
        elapsedMs: 0,
        outputChars: 0,
        errorKind: 'unsupported',
        serverMsg: '网页版生成通道不支持流式',
      })
      diag.fallback(input.diagTurnId, { call: 'streamVoice', from: 'stream', reason: '网页版开启,流式不可用 → 整段回落' })
    }
    throw new Error('网页版生成通道不支持流式')
  }
  const factList = input.memory ? input.memory.promptFacts : (await prepareTurnMemory({ query: input.userText, n: 3 })).promptFacts
  const p: UserProfile = cfg.userProfile
  const persona = soloShortPersona(input.target)
  const chatMoodLine = moodHintLine(await getMoods(), [input.target])
  const brief = renderViewerBrief(p, factList)
  const who = p.userName || '观众'
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content: `桌面双人情景剧互动。你是${persona}。${chatMoodLine ? `${chatMoodLine}。` : ''}${who}面对面和你说了一句话,用你的口吻口头回答。要求:口语化、自然、像真说话,1~3 个短句,每句不超过 25 字;直接说内容,不要引号、不要旁白、不要 JSON。${brief ? `\n${brief}` : ''}\n${soloRescueDiscipline()}`,
    },
    {
      role: 'user',
      content: `${who}说:${input.userText}${input.toolNote ? `\n\n${input.toolNote}` : ''}`,
    },
  ]
  const splitter = createSentenceSplitter()
  let sentences = 0
  const queue: DialogLine[] = []
  let wake: (() => void) | null = null
  let done = false
  let failure: unknown = null
  const streamT0 = Date.now()
  const push = (text: string) => {
    const line: DialogLine = { speaker: input.target, text, action: 'talk' }
    sentences += 1
    // 首句闭合 = 语音"开口延迟"的决定项(网络 TTFB + 凑满一句的最短文本)
    if (sentences === 1 && input.diagTurnId) {
      diag.llmFirstSentence(input.diagTurnId, { call: 'streamVoice', ms: Date.now() - streamT0 })
    }
    queue.push(line)
    input.onQueued?.(line)
    wake?.()
    wake = null
  }
  noteLlmStart(input.diagTurnId, 'streamVoice', 'api', cfg, messages, { timeoutMs: 30_000 })
  const pump = completeStream({
    messages,
    temperature: 1.1,
    maxTokens: 400,
    timeoutMs: 30_000,
    signal: input.signal,
    diag: input.diagTurnId ? { turnId: input.diagTurnId, call: 'streamVoice' } : undefined,
    onDelta: (piece) => {
      for (const s of splitter.feed(piece)) push(s)
    },
  }).then(
    () => {
      const tail = splitter.flush()
      if (tail) push(tail)
      done = true
      wake?.()
      wake = null
    },
    (e) => {
      failure = e
      done = true
      wake?.()
      wake = null
    },
  )
  try {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      if (done) break
      await new Promise<void>((r) => {
        wake = r
      })
    }
  } finally {
    // 消费方提前退出(打断):pump 随 abort 自行收尾,吞掉迟到的拒绝
    void pump.catch(() => {})
  }
  if (failure !== null) throw failure
}
