// 影子大脑协议:BrainInput(运行现场快照)与 BrainDecision(外部 Agent 裁决)
// 的类型与清洗唯一事实源。字段白名单 + 逐字段钳制,来源不限(Rust 桥转发的外部
// JSON / JSONL 存档回读),坏数据整条拒绝或降级,绝不拖垮主流程。
// 设计见 docs/影子大脑桥接设计方案.md。

import { sanitizeAction } from '../performer/dialogSchema'
import type { Speaker } from '../performer/dialogSchema'
import { clampVad, type Vad } from './vad'

// ---------- BrainInput ----------

/** 调度器单一 tick 的本地评估(理由显式化——「知道主动系统哪里太保守」的数据源) */
export interface LocalEvaluation {
  /** tick 整体被闸:null = 走到了候选评估 */
  blocked: 'gate' | 'quota' | null
  /** 本 tick 结论所属候选(无 firing 时 = 自发闲聊的评估结果,它是优先级末位) */
  candidate: 'break' | 'replay' | 'spontaneous' | 'none'
  fired: boolean
  /** 未播原因:fired 或 blocked 时为 null */
  decline:
    | 'cooldown' // 冷却未到(上次尝试/成功/提醒太近)
    | 'chance' // 掷点未中(SPONT_CHANCE)
    | 'quiet-hours' // 深夜静音时段
    | 'disabled' // 配置关闭(久坐关/重放关/安静档)
    | 'not-due' // 阈值未到(空闲不够/连续工作不够)
    | 'resting' // 用户在休息,久坐计时清零
    | 'stretch' // 本空闲段已重放过
    | 'producers-declined' // 生成侧拒绝(无历史/正在播/无 Key)
    | 'takeover-listen' // 接管模式:外部大脑裁决 listen
    | null
  /** 距空闲起点的毫秒数(闸门被挡时为 0) */
  idleForMs: number
  /** 当前小时配额占用 */
  quotaUsed: number
  /** 逐候选的短理由(每条 ≤60 字,最多 6 条) */
  reasons: string[]
}

export interface BrainInputTick {
  idleForMs: number
  quotaUsed: number
  quotaCap: number
  /** 距上次自发尝试/成功的毫秒;null = 本次会话还没发生过 */
  sinceLastSpontMs: number | null
  sinceLastSpontSuccessMs: number | null
}

export interface BrainInputWorld {
  foreground: string | null
  processName: string | null
  /** 仅用户已开窗口标题采集(contextSense.windowTitle)时携带——沿用既有授权闸 */
  activeWindowTitle: string | null
  fullscreen: boolean
  idleMinutes: number
  audioPlaying: boolean
  mediaName: string | null
  cpuPercent: number | null
  memPercent: number | null
  batteryPercent: number | null
  charging: boolean | null
}

export interface BrainInputMoodEntry {
  vad: Vad
  cause?: string
}

export interface BrainInputInteractions {
  dismissSpontaneous: number
  dismissReplay: number
  dismissBreak: number
  interrupts: number
  pokes: number
}

export interface BrainInput {
  /** `brin_` 前缀,单调生成;外部决策引用它,未知 id 拒绝 */
  inputId: string
  ts: number
  tick: BrainInputTick
  world: BrainInputWorld
  mood: Partial<Record<Speaker, BrainInputMoodEntry>>
  /** 与自发闲聊生成同源的顶层记忆事实(prepareTurnMemory promptFacts) */
  memory: { promptFacts: string[] }
  /** chatlog 尾部(who:text),最多 6 句 */
  recent: { lastLines: string[] }
  interactions: BrainInputInteractions
  local: LocalEvaluation
}

// ---------- BrainDecision ----------

export interface BrainDecisionExpression {
  vad: Vad
  /** 展示提示;本地执行由 vadToAction 复算,不信任此字段 */
  label?: string
}

export interface BrainDecisionLine {
  speaker: Speaker
  text: string
  action: string
}

export interface BrainDecision {
  inputId: string
  /** 接管应答才有:对应 /brain/requests 下发的请求 id */
  requestId?: string
  decision: 'speak' | 'listen'
  reason: string[]
  memoryUsed: string[]
  expression?: BrainDecisionExpression
  lines: BrainDecisionLine[]
}

/** 清洗/校验结果:ok=false 时 error 说明原因(转发给 Agent 便于自查) */
export type BrainDecisionResult =
  | { ok: true; decision: BrainDecision }
  | { ok: false; error: 'bad-shape' | 'unknown-input' | 'bad-decision' | 'empty-lines' }

const MAX_REASON = 6
const REASON_CAP = 80
const MAX_MEMORY_USED = 6
const MEMORY_USED_CAP = 40
const MAX_LINES = 4
const LINE_TEXT_CAP = 200

const SPEAKERS = new Set<Speaker>(['A', 'B', 'C'])

const strList = (v: unknown, max: number, cap: number): string[] => {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().slice(0, cap))
    .filter(Boolean)
    .slice(0, max)
}

const parseVad = (v: unknown): Vad | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.v !== 'number' || typeof o.a !== 'number' || typeof o.d !== 'number') return null
  return clampVad({ v: o.v, a: o.a, d: o.d })
}

/** 清洗外部决策:结构坏 → bad-shape;decision 词表外 → bad-decision;
 *  speak 无台词 → empty-lines(说一句话是 speak 的最低要求)。
 *  requestId 透传(桥层校验 pending);inputId 归属由调用方校验 */
export function sanitizeBrainDecision(raw: unknown): BrainDecisionResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad-shape' }
  const o = raw as Record<string, unknown>
  if (typeof o.inputId !== 'string' || !o.inputId.trim()) return { ok: false, error: 'bad-shape' }
  if (o.decision !== 'speak' && o.decision !== 'listen') {
    return { ok: false, error: 'bad-decision' }
  }
  const expression = (() => {
    if (!o.expression || typeof o.expression !== 'object') return undefined
    const vad = parseVad((o.expression as Record<string, unknown>).vad)
    if (!vad) return undefined
    const label = (o.expression as Record<string, unknown>).label
    return {
      vad,
      label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 20) : undefined,
    }
  })()
  const lines = (Array.isArray(o.lines) ? o.lines : [])
    .map((x) => {
      const l = (x ?? {}) as Record<string, unknown>
      if (typeof l.speaker !== 'string' || !SPEAKERS.has(l.speaker as Speaker)) return null
      const text = typeof l.text === 'string' ? l.text.trim().slice(0, LINE_TEXT_CAP) : ''
      if (!text) return null
      return {
        speaker: l.speaker as Speaker,
        text,
        action: sanitizeAction(l.action),
      }
    })
    .filter((l): l is BrainDecisionLine => l !== null)
    .slice(0, MAX_LINES)
  if (o.decision === 'speak' && lines.length === 0) return { ok: false, error: 'empty-lines' }
  const decision: BrainDecision = {
    inputId: o.inputId.trim().slice(0, 64),
    decision: o.decision,
    reason: strList(o.reason, MAX_REASON, REASON_CAP),
    memoryUsed: strList(o.memoryUsed, MAX_MEMORY_USED, MEMORY_USED_CAP),
    lines,
  }
  if (typeof o.requestId === 'string' && o.requestId.trim()) {
    decision.requestId = o.requestId.trim().slice(0, 64)
  }
  if (expression) decision.expression = expression
  return { ok: true, decision }
}

/** 影子决策存档行:决策 + 提交时刻的本地评估配对(离线 join 零成本) */
export interface ShadowDecisionRecord {
  ts: number
  mode: 'shadow' | 'takeover'
  decision: BrainDecision
  localAtDecision: LocalEvaluation | null
}
