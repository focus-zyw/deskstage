// 情绪余波状态机:纯计算,无 IO。双通道标量——valence(心情好坏 -3..3)与 energy(精力 0..5)
// 组合出动作词表的全部情绪面(高energy+负valence→angry、低energy+负valence→sad、
// 高energy+正valence→excited、低energy+正valence→满足慵懒)。
// 更新只走加法增量 + clamp(照 RELATIONSHIP_DELTAS 的加法模式,确定性可单测);
// 读时惰性衰减防永久记仇(照 getBond 按日衰减的思路,这里按小时)。
// LLM 逐句输出的 action/delivery 仍是演出权威——这里只负责跨句/跨集的惯性:
// 生成侧注入开场余波,呈现侧给待机姿势染色,绝不改写已生成台词。

import type { DialogLine, Speaker } from '../performer/dialogSchema'
import { nameOf } from './persona'
import { isLateNight } from './timeAware'

export interface Mood {
  /** 心情好坏:-3 烦躁 .. 3 愉悦 */
  valence: number
  /** 精力:0 蔫 .. 5 亢奋 */
  energy: number
  updatedAt: number
  /** 最近一次变化的简短原因(叙事记忆,≤30字) */
  cause?: string
}

export type MoodTable = Record<Speaker, Mood>

export const VALENCE_LIMIT = 3
export const ENERGY_LIMIT = 5
/** 单笔增量上限(一集蒸馏/一次互动),防大喜大悲 */
export const MAX_EVENT_DELTA = 2
/** 惰性衰减:valence 向 0 每小时衰 30%,energy 向基线每小时回 25% 差距 */
const VALENCE_DECAY_PER_HOUR = 0.3
const ENERGY_REGRESS_PER_HOUR = 0.25

/** energy 基线:白天 2.5,深夜 1.5(23 点后角色也该困) */
export function energyBaseline(now = new Date()): number {
  return isLateNight(now) ? 1.5 : 2.5
}

export const clampValence = (v: number): number =>
  Math.min(VALENCE_LIMIT, Math.max(-VALENCE_LIMIT, v))
export const clampEnergy = (v: number): number => Math.min(ENERGY_LIMIT, Math.max(0, v))

export function defaultMood(now = Date.now()): Mood {
  return { valence: 0, energy: energyBaseline(new Date(now)), updatedAt: now }
}

export function defaultMoodTable(now = Date.now()): MoodTable {
  return { A: defaultMood(now), B: defaultMood(now), C: defaultMood(now) }
}

export function clampMood(m: Mood): Mood {
  return { ...m, valence: clampValence(m.valence), energy: clampEnergy(m.energy) }
}

/** 读时惰性衰减:按距 updatedAt 的小时数指数衰减,不依赖定时器 */
export function decayMood(m: Mood, now = Date.now()): Mood {
  const hours = Math.max(0, (now - m.updatedAt) / 3_600_000)
  if (hours <= 0) return clampMood(m)
  const base = energyBaseline(new Date(now))
  const kV = Math.pow(1 - VALENCE_DECAY_PER_HOUR, hours)
  const kE = Math.pow(1 - ENERGY_REGRESS_PER_HOUR, hours)
  return {
    valence: clampValence(m.valence * kV),
    energy: clampEnergy(base + (m.energy - base) * kE),
    updatedAt: now,
    cause: m.cause,
  }
}

export function decayTable(table: MoodTable, now = Date.now()): MoodTable {
  return { A: decayMood(table.A, now), B: decayMood(table.B, now), C: decayMood(table.C, now) }
}

/** 一笔情绪增量(蒸馏余波或互动小步) */
export interface MoodDelta {
  who: Speaker
  dValence: number
  dEnergy: number
  cause?: string
}

/** 应用增量:单笔 |Δ| 钳位 MAX_EVENT_DELTA,值域 clamp;cause 取最后一条非空 */
export function applyMoodDeltas(
  table: MoodTable,
  deltas: readonly MoodDelta[],
  now = Date.now(),
): MoodTable {
  const out: MoodTable = { A: { ...table.A }, B: { ...table.B }, C: { ...table.C } }
  for (const d of deltas) {
    if (d.who !== 'A' && d.who !== 'B' && d.who !== 'C') continue
    const dv = Math.max(-MAX_EVENT_DELTA, Math.min(MAX_EVENT_DELTA, Number(d.dValence) || 0))
    const de = Math.max(-MAX_EVENT_DELTA, Math.min(MAX_EVENT_DELTA, Number(d.dEnergy) || 0))
    if (dv === 0 && de === 0) continue
    const m = out[d.who]
    out[d.who] = {
      valence: clampValence(m.valence + dv),
      energy: clampEnergy(m.energy + de),
      updatedAt: now,
      cause: d.cause?.trim() ? d.cause.trim().slice(0, 30) : m.cause,
    }
  }
  return out
}

// ---------- 标量 → 离散情绪面(提示词/呈现共用的单点换算) ----------

export interface MoodFace {
  id: 'angry' | 'sad' | 'excited' | 'content' | 'restless' | 'sleepy' | 'calm'
  /** 短标签(提示词里拼在角色名后) */
  label: string
  /** 行为描述(主演出块用;短通道只用 label) */
  desc: string
}

const FACES: Record<MoodFace['id'], MoodFace> = {
  angry: { id: 'angry', label: '还在气头上', desc: '余怒未消,前几句语气冲,但被逗可以顺台阶下' },
  sad: { id: 'sad', label: '蔫了', desc: '提不起劲,声音发闷,需要被哄才缓得过来' },
  excited: { id: 'excited', label: '兴奋劲还没过', desc: '精神头特别足,话密爱接梗,容易越说越上头' },
  content: { id: 'content', label: '心情不错', desc: '松弛愉快,愿意捧场接梗' },
  restless: { id: 'restless', label: '有点坐不住', desc: '精力过剩,注意力发散,忍不住想搞事' },
  sleepy: { id: 'sleepy', label: '犯困', desc: '眼皮打架,话少,反应慢半拍' },
  calm: { id: 'calm', label: '情绪平稳', desc: '' },
}

/** 双通道 → 情绪面。平静不进提示词,避免每集都注水 */
export function quantizeMood(m: Mood): MoodFace {
  const { valence: v, energy: e } = m
  if (v <= -1.5) return e >= 2.5 ? FACES.angry : FACES.sad
  if (v >= 1.5) return e >= 3.5 ? FACES.excited : FACES.content
  if (e >= 4) return FACES.restless
  if (e <= 1) return FACES.sleepy
  return FACES.calm
}

// ---------- 提示词渲染 ----------

/** 主演出注入块:只列有波澜的角色;空串 = 全员平静,不注入 */
export function moodPromptBlock(table: MoodTable, now = Date.now()): string {
  const rows = (['A', 'B', 'C'] as const)
    .map((who) => ({ who, face: quantizeMood(decayMood(table[who], now)) }))
    .filter(({ face }) => face.id !== 'calm')
    .map(({ who, face }) => `- ${nameOf(who)}${face.label}(${face.desc})`)
  if (rows.length === 0) return ''
  return [
    '当前心情余波(跨集带过来的情绪惯性:影响开场姿态与前几句语气,随剧情自然消解,不是本集主要矛盾,不要每句都提;与模式风格要求冲突时以模式风格为准,余波只体现在开场姿态与语气细节):',
    ...rows,
  ].join('\n')
}

/** 短通道单行提示(短聊/戳/回合/弹幕/插话):这些通道没有场景卡兜底,一句带过 */
export function moodHintLine(
  table: MoodTable,
  whos: readonly Speaker[],
  now = Date.now(),
): string {
  const rows = whos
    .map((who) => ({ who, face: quantizeMood(decayMood(table[who], now)) }))
    .filter(({ face }) => face.id !== 'calm')
    .map(({ who, face }) => `${nameOf(who)}${face.label}`)
  if (rows.length === 0) return ''
  return `心情余波(语气带出来,不要明说,与本段任务冲突时以任务为准):${rows.join('、')}`
}

// ---------- 集内瞬时情绪(插话通道:蒸馏未提交,持久档里还没有本集情绪) ----------

/** 台词动作 → 集内余波描述;不在表内视为中性 */
const ACTION_MOOD: Record<string, string> = {
  angry: '刚被怼到炸毛,正在气头上',
  sad: '刚才情绪有点下坠,还没缓过来',
  happy: '正美着呢',
  laugh: '正笑得停不下来',
  shy: '刚被戳中,还有点不好意思',
  surprise: '刚被惊到,还没回过神',
  sleepy: '已经犯困了',
}
const NEUTRAL_ACTIONS = new Set(['idle', 'talk', 'wave', 'thinking', 'shake', 'jump'])

/** 从最近已播台词的 action 轨迹现场推导集内情绪(纯函数,无持久化)。
 *  只看最近 6 句、每角色取最近一次非中性动作、最多报 2 人 */
export function recentMoodHint(lines: readonly DialogLine[]): string {
  const latest = new Map<Speaker, { at: number; text: string }>()
  const tail = lines.slice(-6)
  tail.forEach((l, i) => {
    if (NEUTRAL_ACTIONS.has(l.action)) return
    const text = ACTION_MOOD[l.action]
    if (!text) return
    latest.set(l.speaker, { at: tail.length - i, text })
  })
  const rows = [...latest.entries()]
    .sort((a, b) => a[1].at - b[1].at) // 越近的越先提
    .slice(0, 2)
    .map(([who, { text }]) => `${nameOf(who)}${text}`)
  if (rows.length === 0) return ''
  return `集内情绪提示(接话要贴着,不要每句都提):${rows.join(';')}`
}

// ---------- 呈现侧 ----------

/** 待机放松姿势染色:负向情绪强烈时回 idle 前先落到染色姿势一拍。
 *  正向情绪不染(自然回 idle),避免画面常年咧嘴 */
export function tintedRelaxPose(m: Mood, now = Date.now()): string | null {
  const face = quantizeMood(decayMood(m, now))
  if (face.id === 'angry') return 'angry'
  if (face.id === 'sad') return 'sad'
  return null
}

// ---------- 清洗(存储层读档用,坏数据回默认不拖垮启动) ----------

export function sanitizeMoodTable(v: unknown, now = Date.now()): MoodTable {
  const o = (v ?? {}) as Record<string, unknown>
  const num = (x: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(x)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  const one = (x: unknown): Mood => {
    const m = (x ?? {}) as Record<string, unknown>
    return clampMood({
      valence: num(m.valence, -VALENCE_LIMIT, VALENCE_LIMIT, 0),
      energy: num(m.energy, 0, ENERGY_LIMIT, energyBaseline(new Date(now))),
      updatedAt: Number(m.updatedAt) || 0,
      cause:
        typeof m.cause === 'string' && m.cause.trim() ? m.cause.trim().slice(0, 30) : undefined,
    })
  }
  return { A: one(o.A), B: one(o.B), C: one(o.C) }
}

// ---------- 蒸馏候选 ----------

/** distillStory 产出的情绪余波候选:须过台词证据关(策展器校验),未入库 */
export interface MoodEventCandidate {
  who: Speaker
  dValence: number
  dEnergy: number
  /** 谁怎么了,≤30字 */
  cause: string
  /** 逐字摘自台词的依据,策展器校验 */
  evidence: string
}
