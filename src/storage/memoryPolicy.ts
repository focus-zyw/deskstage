// 记忆策略 · 纯函数模块:检索流水线、时效判定、slot 冲突分类、规则匹配、敏感检测。
// 为什么独立于 memoryStore:这些是"该不该注入/该怎么归因"的语义决策,必须能在 CI
// 里用确定性时间矩阵测死(tests/memoryPolicy.test.mjs);memoryStore 只管存取与 CAS。
// 本模块导入期无副作用,对 memoryStore 仅 type 引用(编译期擦除,无运行时环)。
import type { FactCategory, MemoryFact, MemoryRule } from './memoryStore'
import { SLOT_POLICY, isMemorySlot, normalizeSlotValue } from './memorySlots'

export type MemoryVolatility = 'stable' | 'changeable' | 'historical'
export type MemorySensitivity = 'normal' | 'private' | 'restricted'
/** 有效状态:needs_confirmation 永远动态派生,不落盘(persisted status 仅 active|superseded) */
export type EffectiveStatus = 'active' | 'needs_confirmation' | 'superseded'
export type TraceOutcome = 'selected' | 'irrelevant' | 'expired' | 'privacy-blocked' | 'limit'
export type MemoryPurpose = 'passive-context' | 'explicit-search'

export interface SelectedMemory {
  id: string
  text: string
  source: 'passive' | 'search-tool'
  score: number
  effectiveStatus: EffectiveStatus
}

export interface MemoryCandidateTrace {
  id: string
  score: number
  outcome: TraceOutcome
  effectiveStatus: EffectiveStatus
}

export interface MemoryTrace {
  queriedAt: number
  used: { id: string; source: 'passive' | 'search-tool'; score: number }[]
  candidates: MemoryCandidateTrace[]
}

// ---------- 敏感度(取严合并,不是 AND——任何一源判敏即敏) ----------

const SENSITIVITY_ORDER: Record<MemorySensitivity, number> = { normal: 0, private: 1, restricted: 2 }

export function maxSensitivity(...values: (MemorySensitivity | undefined)[]): MemorySensitivity {
  return values.reduce<MemorySensitivity>(
    (acc, v) => (v && SENSITIVITY_ORDER[v] > SENSITIVITY_ORDER[acc] ? v : acc),
    'normal',
  )
}

/** 确定性敏感检测:不依赖模型自觉。restricted 是高精度表(宁可少判不可误伤"山药"),
 *  药物类只认"服药/用药/药物"等组合词,单独"药"字不触发 */
const RESTRICTED_RE = /过敏|忌口|服药|用药|药物|吃药|药片|胰岛素|抗抑郁|确诊|病史|病历|疾病|糖尿病|高血压|哮喘|身份证|证件|银行卡|卡号|护照/
const PRIVATE_RE = /住在|住址|详细地址|搬家|房租|工资|薪资|收入|存款|手机号|电话号码|体检/

export function detectSensitivity(content: string): MemorySensitivity {
  if (RESTRICTED_RE.test(content)) return 'restricted'
  if (PRIVATE_RE.test(content)) return 'private'
  return 'normal'
}

// ---------- 时效:确认窗与有效状态 ----------

/** 无 slot 时按类别给默认确认窗(天);null = 不按时间要求重新确认 */
const CATEGORY_CONFIRM_DAYS: Record<FactCategory, number | null> = {
  identity: 90,
  preference: 180,
  habit: 180,
  people: 120,
  event: null,
  other: 180,
}

/** 无 slot 时按类别给默认 volatility(event 是历史事实,时间只影响相关性不产生失效) */
export function defaultVolatility(category: FactCategory): MemoryVolatility {
  return category === 'event' ? 'historical' : 'changeable'
}

const DAY_MS = 86_400_000

/** 确认窗(毫秒):slot 政策优先,类别表兜底;private/restricted 取严覆盖(一律 14/7 天)。
 *  null = stable/历史事实不按时间要求重新确认 */
export function confirmWindowMs(fact: Pick<MemoryFact, 'slot' | 'category' | 'sensitivity' | 'volatility'>): number | null {
  if (fact.volatility === 'historical') return null
  let days: number | null
  if (isMemorySlot(fact.slot)) days = SLOT_POLICY[fact.slot].confirmDays
  else days = CATEGORY_CONFIRM_DAYS[fact.category] ?? 180
  // 敏感层级压窗:private 一律 ≤14 天,restricted 一律 ≤7 天(取严)
  if (fact.sensitivity === 'private') days = days === null ? 14 : Math.min(days, 14)
  if (fact.sensitivity === 'restricted') days = days === null ? 7 : Math.min(days, 7)
  return days === null ? null : days * DAY_MS
}

/** 时效基准:从未被用户确认过的事实从创建时刻起算 */
export function freshnessBase(fact: Pick<MemoryFact, 'lastConfirmedAt' | 'createdAt'>): number {
  return fact.lastConfirmedAt ?? fact.createdAt
}

/** 有效状态:needs_confirmation 永远由 status+时间戳+policy+now 派生,不落盘 */
export function effectiveStatus(fact: MemoryFact, now: number): EffectiveStatus {
  if (fact.status === 'superseded') return 'superseded'
  if (fact.confidence < 0.45) return 'needs_confirmation'
  const window = confirmWindowMs(fact)
  if (window !== null && now - freshnessBase(fact) > window) return 'needs_confirmation'
  return 'active'
}

// ---------- 相关性:2-gram 包含度(只做检索候选,不做冲突/身份判断) ----------

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[\s,,。.!!??;;::''"'"“”「」()()、|·~～\-—]/g, '')
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  const t = normalizeText(s)
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  if (t.length === 1) out.add(t)
  return out
}

/** 事实文本对 query 的包含度(0~1):事实的 2-gram 有多少出现在 query 里 */
export function relevance(factText: string, query: string): number {
  if (!query.trim()) return 0
  const fb = bigrams(factText)
  if (fb.size === 0) return 0
  const qb = bigrams(query)
  let hit = 0
  for (const g of fb) if (qb.has(g)) hit += 1
  return hit / fb.size
}

// ---------- 规则匹配(结构化 scope,不用裸字符串猜) ----------

export function ruleMatches(fact: Pick<MemoryFact, 'content' | 'slot' | 'category' | 'sensitivity'>, rule: MemoryRule): boolean {
  switch (rule.scope) {
    case 'slot':
      return fact.slot !== undefined && fact.slot === rule.value
    case 'category':
      return fact.category === rule.value
    case 'sensitivity':
      return fact.sensitivity === rule.value
    case 'phrase':
      return rule.value.trim().length > 0 && normalizeText(fact.content).includes(normalizeText(rule.value))
  }
}

// ---------- slot 冲突分类(同义值已按 slot 规范化) ----------

export type IncomingVerdict = 'reaffirm' | 'supersede' | 'none'

/** 判定新提取与既有条目的关系:同 slot 异值 = 旧条被替代;同 slot 同值且来自**新的**
 *  用户轮 = 重申确认(同一轮的重复提取不算);无 slot 不做冲突判断(2-gram 不可靠) */
export function classifyIncoming(
  existing: MemoryFact,
  incoming: { slot?: string; value?: string; turnId?: string | null },
): IncomingVerdict {
  if (existing.slot === undefined || !isMemorySlot(incoming.slot) || incoming.slot !== existing.slot) return 'none'
  const inVal = normalizeSlotValue(incoming.slot, incoming.value ?? '')
  const exVal = normalizeSlotValue(existing.slot, existing.value ?? '')
  if (!inVal || !exVal) return 'none'
  if (inVal === exVal) {
    const lastTurn = existing.evidence[existing.evidence.length - 1]?.turnId ?? existing.sourceTurnId
    return incoming.turnId != null && incoming.turnId !== lastTurn ? 'reaffirm' : 'none'
  }
  return 'supersede'
}

// ---------- 检索流水线:资格过滤 → 时效 → 相关性 → 加权 → 选择 ----------

export interface QueryOptions {
  query: string
  purpose: MemoryPurpose
  now: number
  n: number
  rules?: MemoryRule[]
}

const PRIVATE_PASSIVE_RELEVANCE = 0.35
const HISTORICAL_PASSIVE_RELEVANCE = 0.2

/** 事实评分:置信 0.5 + 相关性 0.4 + 固定 0.3 + 确认新近 0.1(全部确定性) */
export function scoreFact(fact: MemoryFact, query: string, now: number): number {
  const r = relevance(fact.content + (fact.value ?? ''), query)
  const base = fact.lastConfirmedAt ?? fact.createdAt
  const confirmRecency = Math.max(0, 1 - (now - base) / (365 * DAY_MS))
  return 0.5 * fact.confidence + 0.4 * r + (fact.pinned ? 0.3 : 0) + 0.1 * confirmRecency
}

/**
 * 唯一记忆检索入口:被动注入与显式搜索共用,差别只在资格宽度。
 * 返回 selected(注入集合,refs/promptFacts 均由它派生)与 candidates(归因 trace,
 * 只含 id/数字/枚举,不含正文——删除语义不破)。
 */
export function queryMemory(
  facts: MemoryFact[],
  opts: QueryOptions,
): { selected: SelectedMemory[]; candidates: MemoryCandidateTrace[]; queriedAt: number } {
  const { query, purpose, now, n, rules = [] } = opts
  const scored: { fact: MemoryFact; score: number }[] = []
  const candidates: MemoryCandidateTrace[] = []

  for (const fact of facts) {
    const eff = effectiveStatus(fact, now)
    const push = (outcome: TraceOutcome) =>
      candidates.push({ id: fact.id, score: 0, outcome, effectiveStatus: eff })
    if (rules.some((r) => ruleMatches(fact, r))) {
      push('privacy-blocked')
      continue
    }
    if (fact.status === 'superseded') {
      push('irrelevant')
      continue
    }
    const r = relevance(fact.content + (fact.value ?? ''), query)
    if (purpose === 'passive-context') {
      if (fact.sensitivity === 'restricted') {
        push('privacy-blocked')
        continue
      }
      if (eff !== 'active') {
        push('expired')
        continue
      }
      if (fact.sensitivity === 'private' && r < PRIVATE_PASSIVE_RELEVANCE) {
        push('privacy-blocked')
        continue
      }
      if (fact.volatility === 'historical' && r < HISTORICAL_PASSIVE_RELEVANCE) {
        push('irrelevant')
        continue
      }
    }
    scored.push({ fact, score: scoreFact(fact, query, now) })
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.fact.pinned) - Number(a.fact.pinned) ||
      b.fact.lastSeen - a.fact.lastSeen,
  )
  const source = purpose === 'passive-context' ? 'passive' : 'search-tool'
  const selected: SelectedMemory[] = scored.slice(0, n).map(({ fact, score }) => ({
    id: fact.id,
    text: fact.content,
    source,
    score,
    effectiveStatus: effectiveStatus(fact, now),
  }))
  for (const s of selected) {
    candidates.push({ id: s.id, score: s.score, outcome: 'selected', effectiveStatus: s.effectiveStatus })
  }
  for (const { fact, score } of scored.slice(n)) {
    candidates.push({ id: fact.id, score, outcome: 'limit', effectiveStatus: effectiveStatus(fact, now) })
  }
  return { selected, candidates, queriedAt: now }
}
