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

/** 完整演出脚本:choice 前的台词、抉择点、按分支分组的后续台词 */
export interface PerformanceScript {
  before: DialogLine[]
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

/** 语气→语速:deadpan 面瘫略慢 / excited 兴奋略快 / slow 慢条斯理 */
export function deliverySpeed(delivery?: string): number {
  return (delivery && { deadpan: 0.92, excited: 1.15, slow: 0.85 }[delivery]) || 1
}

/** 语气→自然语言情感指令:仅靠语速区分角色差异太单薄,语气描述让情感可听。
 *  CosyVoice2 端拼成 `指令<|endofprompt|>台词`——标记前是指令,不会被朗读;
 *  MiniMax 端自行转换为 emotion 参数 */
export function deliveryInstruction(delivery?: string): string {
  return (delivery && {
    deadpan: '用冷静、面无表情、略带讽刺的语气说',
    excited: '用兴奋、活泼的语气说',
    slow: '用慢条斯理、从容的语气说',
  }[delivery]) || ''
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
  const before: DialogLine[] = []
  const after: Record<string, DialogLine[]> = {}
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
      before.push(line)
    } else {
      const key = typeof line.branch === 'string' && line.branch ? line.branch : '__default__'
      ;(after[key] ??= []).push(line)
    }
  }
  if (total < minLines) throw new Error('有效台词过少')
  return { card, before, choice, after }
}
