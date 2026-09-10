// 台词与场景卡的类型定义 + 清洗的唯一事实源(深模块)。
// LLM 解析、历史 JSONL、收藏、预取缓冲全部通过这里的小接口读写,
// 新增字段只改这一处,避免四五处复制的浅模块各自漂移。

/** 动作词表:与贴图/CSS 动画一一对应(shake/jump 复用 idle 图 + 位移动画) */
export const VALID_ACTIONS = new Set([
  'idle',
  'talk',
  'happy',
  'laugh',
  'shy',
  'sleepy',
  'wave',
  'thinking',
  'angry',
  'sad',
  'surprise',
  'shake',
  'jump',
])

export type Speaker = 'A' | 'B' | 'C' // C = 场外角色(电话/画外音乱入,无立绘)

/** 语气词表:deadpan 面瘫 / excited 兴奋 / slow 慢条斯理;缺省 normal(不标注) */
export const DELIVERIES = ['deadpan', 'excited', 'slow'] as const
export type Delivery = (typeof DELIVERIES)[number]

export interface DialogLine {
  speaker: Speaker
  text: string
  action: string // 动作词表,见 VALID_ACTIONS
  /** 句前停顿 ms:包袱前蓄势(协议建议 300~600) */
  pauseBefore?: number
  /** 句尾额外停留 ms:响底后留白(协议建议 900~1500) */
  pauseAfter?: number
  /** 听者此刻的反应动作(词表同 action;缺省不改变) */
  listenerAction?: string
  /** 语气:驱动说话节奏(CSS)与 TTS 语速 */
  delivery?: Delivery
  /** 抉择分支标记:choice 之后的台词标注所属分支 id */
  branch?: string
}

/** 场景卡:先定前提再写台词的"戏剧前提",dialog 逐拍实现其 escalation */
export interface ChoiceOption {
  id: string
  label: string
}

/** 剧集中段的观众抉择点 */
export interface ChoicePoint {
  prompt: string
  options: ChoiceOption[]
}

/** 完整演出脚本:choice 前的台词、抉择点、按分支分组的后续台词;
 *  card 为本集场景卡(剧本的正式组成部分,随集历史落盘) */
export interface PerformanceScript {
  before: DialogLine[]
  card?: SceneCard
  choice?: ChoicePoint
  after: Record<string, DialogLine[]>
}

export interface SceneCard {
  relationship: string
  scene: string
  goalA: string
  goalB: string
  secret: string
  escalation: string[]
  callback: string
}

const PAUSE_MAX_MS = 1500

/** 停顿钳位:非法/≤0 → undefined,上限 1.5s 防呆 */
export function clampPauseMs(v: unknown): number | undefined {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(PAUSE_MAX_MS, Math.round(n))
}

/** 动作清洗:非法归一为 talk */
export function sanitizeAction(v: unknown): string {
  return typeof v === 'string' && VALID_ACTIONS.has(v) ? v : 'talk'
}

/** 语气清洗:非法或缺省 → undefined */
export function sanitizeDelivery(v: unknown): Delivery | undefined {
  return typeof v === 'string' && (DELIVERIES as readonly string[]).includes(v)
    ? (v as Delivery)
    : undefined
}

/** 语气→语速(收敛后:保留差异但不夸张,幅度过大听着刻意):
 *  deadpan 面瘫略慢 / excited 兴奋略快 / slow 慢条斯理 */
export function deliverySpeed(delivery?: string): number {
  return (delivery && { deadpan: 0.96, excited: 1.06, slow: 0.92 }[delivery]) || 1
}

/** 语气→自然语言情感指令:仅靠语速区分角色差异太单薄,语气描述让情感可听。
 *  强度收敛:不喊叫、不拖字、不刻意重读——表演交给情绪参数而不是文案夸张。
 *  CosyVoice2 端拼成 `指令<|endofprompt|>台词`(标记前不朗读);MiniMax 转情绪参数 */
export function deliveryInstruction(delivery?: string): string {
  return (delivery && {
    deadpan: '用平静克制、句尾略带吐槽的语气说',
    excited: '用自然兴奋、不喊叫、不刻意拖长重音的语气说',
    slow: '用从容、有意停顿、不拖字的语气说',
  }[delivery]) || ''
}

/** 朗读文本归一化:统一 TTS 易读错的写法,只做安全替换,不改内容与语气 */
export function normalizeForSpeech(text: string): string {
  return text
    .replace(/\bAI\b/g, ' A I ') // 避免读成"爱"
    .replace(/…+|。{3,}|\.{2,}/g, '，') // 省略号统一为逗号停顿
    .replace(/——+/g, '，') // 长破折号统一为逗号
    .replace(/(\d+(?:\.\d+)?)%/g, '百分之$1') // 百分号前置读法(50% → 百分之50)
    .replace(/\s+/g, ' ')
    .trim()
}

/** 强情绪连续收敛:同一角色连续出现同一种强情绪(excited/slow)超过两句时,
 *  第三句起降回普通——LLM 偷懒整段刷同一种情绪时由这里兜底 */
export function diversifyDeliveries(lines: DialogLine[]): DialogLine[] {
  let curSpeaker: Speaker | null = null
  let curDelivery: Delivery | undefined
  let run = 0
  return lines.map((line) => {
    if (line.speaker !== curSpeaker || line.delivery !== curDelivery) {
      curSpeaker = line.speaker
      curDelivery = line.delivery
      run = 1
      return line
    }
    run++
    const strong = line.delivery === 'excited' || line.delivery === 'slow'
    if (strong && run > 2) return { ...line, delivery: undefined }
    return line
  })
}

/** 清洗单条台词:speaker/text 必须合法,否则整条丢弃(null)。
 *  可选演出字段逐一钳位/校验,来源不限(LLM 输出/JSONL/收藏/预取缓冲) */
export function sanitizeDialogLine(raw: unknown): DialogLine | null {
  const o = (raw ?? {}) as Record<string, unknown>
  if (o.speaker !== 'A' && o.speaker !== 'B' && o.speaker !== 'C') return null
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  if (!text) return null
  const listenerAction =
    typeof o.listenerAction === 'string' && VALID_ACTIONS.has(o.listenerAction)
      ? o.listenerAction
      : undefined
  return {
    speaker: o.speaker,
    text,
    action: sanitizeAction(o.action),
    pauseBefore: clampPauseMs(o.pauseBefore),
    pauseAfter: clampPauseMs(o.pauseAfter),
    listenerAction,
    delivery: sanitizeDelivery(o.delivery),
    branch: typeof o.branch === 'string' && o.branch.trim() ? o.branch.trim().slice(0, 24) : undefined,
  }
}

/** 清洗台词数组:丢坏行;给 minLines 时不足则抛错(LLM 解析用) */
export function sanitizeDialog(raw: unknown, minLines?: number): DialogLine[] {
  const arr = Array.isArray(raw) ? raw : []
  const lines = arr.map(sanitizeDialogLine).filter((l): l is DialogLine => l !== null)
  if (minLines !== undefined && lines.length < minLines) throw new Error('有效台词过少')
  return lines
}

/** 清洗场景卡:关键字段缺失时整卡丢弃(演出不依赖卡,卡只是编剧质量工具) */
export function sanitizeSceneCard(v: unknown): SceneCard | undefined {
  const o = (v ?? {}) as Record<string, unknown>
  const str = (x: unknown, cap: number): string =>
    typeof x === 'string' ? x.trim().slice(0, cap) : ''
  const relationship = str(o.relationship, 40)
  const scene = str(o.scene, 80)
  const goalA = str(o.goalA, 60)
  const goalB = str(o.goalB, 60)
  const secret = str(o.secret, 80)
  const callback = str(o.callback, 80)
  const escalation = Array.isArray(o.escalation)
    ? o.escalation.map((x) => str(x, 40)).filter(Boolean).slice(0, 6)
    : []
  if (!relationship || !scene || !secret || escalation.length === 0) return undefined
  return { relationship, scene, goalA, goalB, secret, escalation, callback }
}

/** 清洗抉择点:prompt 与恰好两个带唯一 id 的选项 */
export function sanitizeChoicePoint(v: unknown): ChoicePoint | undefined {
  const o = (v ?? {}) as Record<string, unknown>
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim().slice(0, 60) : ''
  if (!prompt || !Array.isArray(o.options)) return undefined
  const options = o.options
    .map((x) => {
      const c = (x ?? {}) as Record<string, unknown>
      const id = typeof c.id === 'string' ? c.id.trim().slice(0, 24) : ''
      const label = typeof c.label === 'string' ? c.label.trim().slice(0, 30) : ''
      return { id, label }
    })
    .filter((c) => c.id && c.label)
    .slice(0, 2)
  if (options.length !== 2 || options[0].id === options[1].id) return undefined
  return { prompt, options }
}

/** 剧本结构校验:清洗保证"每行合法",这里保证"整集结构可播放"。
 *  fatal = 无法播放的结构缺陷(调用方应重试一次生成,仍失败走兜底剧本);
 *  warnings = 可播放的质量瑕疵,记录不拦截——等局部修复循环(P2)接管后再升级 */
export interface ScriptValidation {
  fatal: string[]
  warnings: string[]
}

/** 同一角色最大连说句数:喜剧节奏允许顶嘴连发,但不能一个人说评书 */
const MAX_SPEAKER_STREAK = 2
/** 抉择分支最少句数:低于此值视作模型漏写分支(选了就是死路) */
const MIN_BRANCH_LINES = 2
/** 单句长度提示线:超长不截断,只记录(气泡可滚动) */
const MAX_LINE_CHARS = 100

function speakerStreakWarning(lines: DialogLine[]): string | null {
  let streak = 1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].speaker === lines[i - 1].speaker) {
      streak += 1
      if (streak > MAX_SPEAKER_STREAK) {
        return `第 ${i + 1} 句起 ${lines[i].speaker} 连说超过 ${MAX_SPEAKER_STREAK} 句,节奏像独角戏`
      }
    } else {
      streak = 1
    }
  }
  return null
}

export function validatePerformanceScript(script: PerformanceScript, minLines = 4): ScriptValidation {
  const fatal: string[] = []
  const warnings: string[] = []
  const lines = script.before
  if (lines.length < minLines) {
    fatal.push(`正片台词不足 ${minLines} 句(实际 ${lines.length} 句)`)
  }
  const streak = speakerStreakWarning(lines)
  if (streak) warnings.push(streak)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].text.length > MAX_LINE_CHARS) {
      warnings.push(`第 ${i + 1} 句 ${lines[i].text.length} 字偏长`)
    }
  }
  // 抉择完整性:两个 option 都必须有可播分支,否则观众选了就是死路
  if (script.choice) {
    for (const opt of script.choice.options) {
      const branch = script.after[opt.id] ?? []
      if (branch.length < MIN_BRANCH_LINES) {
        fatal.push(`抉择分支「${opt.label}」缺失或不足 ${MIN_BRANCH_LINES} 句(实际 ${branch.length} 句)`)
        continue
      }
      if (branch[branch.length - 1].speaker === 'C') {
        warnings.push(`分支「${opt.label}」以场外角色收底,剧情可能没收束`)
      }
      const branchStreak = speakerStreakWarning(branch)
      if (branchStreak) warnings.push(`分支「${opt.label}」${branchStreak}`)
    }
  }
  return { fatal, warnings }
}

/** 解析 LLM 生成的原始输出:容忍代码围栏/混杂文本;不合规抛错由调用方兜底。
 *  card 可缺(模型没写卡照常播),台词经 sanitizeDialogLine 保留演出字段。
 *  choice 行(若模型生成了观众抉择点)单独提出,其后带 branch 标记的台词按分支分组 */
export function parseGeneratedDialog(
  raw: string,
  minLines = 4,
): { card?: SceneCard; before: DialogLine[]; choice?: ChoicePoint; after: Record<string, DialogLine[]> } {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('输出中找不到 JSON')
    obj = JSON.parse(m[0])
  }
  const o = (obj ?? {}) as Record<string, unknown>
  const arr = Array.isArray(o.dialog) ? o.dialog : []
  const card = sanitizeSceneCard(o.card)
  const beforeRaw: DialogLine[] = []
  const afterRaw: Record<string, DialogLine[]> = {}
  let choice: ChoicePoint | undefined
  let total = 0
  for (const item of arr) {
    const co = (item ?? {}) as Record<string, unknown>
    if (!choice && co.choice && typeof co.choice === 'object') {
      const c = sanitizeChoicePoint(co.choice)
      if (c) {
        choice = c
        continue
      }
    }
    const line = sanitizeDialogLine(item)
    if (!line) continue
    total++
    if (!choice) {
      beforeRaw.push(line)
    } else {
      const key = typeof line.branch === 'string' && line.branch ? line.branch : '__default__'
      ;(afterRaw[key] ??= []).push(line)
    }
  }
  if (total < minLines) throw new Error('有效台词过少')
  // 强情绪连续收敛:同角色同种强情绪最多连用两句
  const before = diversifyDeliveries(beforeRaw)
  const after: Record<string, DialogLine[]> = {}
  for (const [branchId, seg] of Object.entries(afterRaw)) after[branchId] = diversifyDeliveries(seg)
  return { card, before, choice, after }
}
