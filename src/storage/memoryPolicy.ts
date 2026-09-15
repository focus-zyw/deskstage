// 记忆策略 · 纯函数模块:检索流水线、时效判定、证据权威/支持度派生、事实更新裁决、
// 规则匹配、敏感检测。为什么独立于 memoryStore:这些是"该不该存/该怎么裁决/该不该
// 注入"的语义决策,必须能在 CI 里用确定性时间矩阵测死(tests/memoryPolicy.test.mjs);
// memoryStore 只管存取与 CAS。本模块导入期无副作用,对 memoryStore 仅 type 引用
// (编译期擦除,无运行时环)。
// V3:权威与支持度永远从 evidence 派生,不落盘——散字段会互相矛盾,证据不会;
// 同一 slot 不允许两个 active 事实同时进入检索,裁决矩阵(decideFactUpdate)保证
// 低权威信息永不静默覆盖高权威事实,分歧进冲突队列等用户裁决。
import type {
  FactCategory,
  FactProposal,
  MemoryConflict,
  MemoryEvidence,
  MemoryFact,
  MemoryRule,
} from './memoryStore'
import { SLOT_POLICY, isMemorySlot, normalizeSlotValue } from './memorySlots'

export type MemoryVolatility = 'stable' | 'changeable' | 'historical'
export type MemorySensitivity = 'normal' | 'private' | 'restricted'
/** 有效状态:needs-confirmation 永远动态派生,不落盘(persisted status 仅 active|superseded) */
export type EffectiveStatus = 'active' | 'needs-confirmation' | 'superseded'
export type AssessReason = 'low-support' | 'expired' | 'conflict'
export type TraceOutcome = 'selected' | 'irrelevant' | 'expired' | 'privacy-blocked' | 'conflict' | 'limit'
export type MemoryPurpose = 'passive-context' | 'explicit-search'

/** 权威等级(从 evidence 派生,不落盘):
 *  authored    用户亲自编辑
 *  confirmed   用户点击"仍然有效"/冲突页选择
 *  verified    可信结构化事件
 *  explicit    明确的记忆指令或用户明确陈述
 *  inferred    从普通对话中由模型提取
 *  legacy      无法定位原始证据的旧数据
 *  权威 ≠ 永不过期:用户曾亲自填写的住址仍要按确认窗重新确认 */
export type MemoryAuthority = 'legacy' | 'inferred' | 'explicit' | 'verified' | 'confirmed' | 'authored'

export interface SelectedMemory {
  id: string
  text: string
  source: 'passive' | 'search-tool'
  score: number
  effectiveStatus: EffectiveStatus
  reason?: AssessReason
}

export interface MemoryCandidateTrace {
  id: string
  score: number
  outcome: TraceOutcome
  effectiveStatus: EffectiveStatus
  reason?: AssessReason
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

// ---------- 权威与支持度(全部从 evidence 派生,不落盘) ----------

const AUTHORITY_RANK: Record<MemoryAuthority, number> = {
  legacy: 0,
  inferred: 1,
  explicit: 2,
  verified: 3,
  confirmed: 4,
  authored: 5,
}

/** 单条证据的权威档 */
function evidenceAuthority(ev: MemoryEvidence): MemoryAuthority {
  switch (ev.kind) {
    case 'user-edited':
      return 'authored'
    case 'user-confirmed':
      return 'confirmed'
    case 'verified-event':
      return 'verified'
    case 'explicit-command':
      return 'explicit'
    case 'model-extraction':
      return ev.assertion === 'explicit' ? 'explicit' : 'inferred'
    case 'legacy':
      return 'legacy'
  }
}

/** 事实权威 = 全部 evidence 中的最高档 */
export function authorityOf(fact: Pick<MemoryFact, 'evidence'>): MemoryAuthority {
  let best: MemoryAuthority = 'legacy'
  for (const ev of fact.evidence) {
    const a = evidenceAuthority(ev)
    if (AUTHORITY_RANK[a] > AUTHORITY_RANK[best]) best = a
  }
  return best
}

/** 权威序数(迁移清槽/裁决比较用) */
export function authorityRank(fact: Pick<MemoryFact, 'evidence'>): number {
  return AUTHORITY_RANK[authorityOf(fact)]
}

/** 单条证据的基础支持度:legacy 0.50 / implicit 提取 0.55(assertion unknown 同档)/
 *  explicit 提取 0.72 / 明确指令 0.90 / 可信事件 0.95 / 用户确认 0.98 / 用户编辑 1.00 */
function evidenceSupport(ev: MemoryEvidence): number {
  switch (ev.kind) {
    case 'user-edited':
      return 1
    case 'user-confirmed':
      return 0.98
    case 'verified-event':
      return 0.95
    case 'explicit-command':
      return 0.9
    case 'model-extraction':
      return ev.assertion === 'explicit' ? 0.72 : 0.55
    case 'legacy':
      return 0.5
  }
}

/** 支持度(0~1,确定性,替代模型自报 confidence):
 *  - 不同回合的独立重申每个 turn +0.05;同一 turn 的重复结果只算一份证据,不加分
 *  - 纯模型提取封顶 0.90——再多重申也到不了"用户亲手确认"的档位(0.98/1.00) */
export function supportOf(fact: Pick<MemoryFact, 'evidence'>): number {
  let base = 0
  let cap = 1
  const turns = new Set<string>()
  for (const ev of fact.evidence) {
    const s = evidenceSupport(ev)
    if (s > base) {
      base = s
      cap = ev.kind === 'model-extraction' ? 0.9 : ev.kind === 'explicit-command' ? 0.98 : 1
    }
    if ((ev.kind === 'model-extraction' || ev.kind === 'explicit-command') && ev.turnId) turns.add(ev.turnId)
  }
  const reaffirmBonus = 0.05 * Math.max(0, turns.size - 1)
  return Math.min(cap, base + reaffirmBonus)
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

/** 最近一次用户确认(手动"仍然有效"或亲自编辑)的时间;机器提取/重申不算——
 *  时效只认用户本人的手,聊天里再多提几次也不会绕过确认窗 */
export function lastUserConfirmAtOf(fact: Pick<MemoryFact, 'evidence'>): number | null {
  let at: number | null = null
  for (const ev of fact.evidence) {
    if ((ev.kind === 'user-confirmed' || ev.kind === 'user-edited') && (at === null || ev.at > at)) at = ev.at
  }
  return at
}

/** 时效基准:从未被用户确认过的事实从创建时刻起算 */
export function freshnessBase(fact: Pick<MemoryFact, 'createdAt' | 'evidence'>): number {
  return lastUserConfirmAtOf(fact) ?? fact.createdAt
}

export interface FactAssessment {
  authority: MemoryAuthority
  support: number
  effectiveStatus: EffectiveStatus
  reason?: AssessReason
}

export interface AssessCtx {
  now: number
  /** 该事实被未解决冲突点名(裁决期间不注入) */
  hasOpenConflict?: boolean
}

/** 有效状态:永远由 evidence+policy+now 派生,不落盘。
 *  优先级:superseded > 冲突点名 > 支持度过低 > 超确认窗 > active */
export function assessFact(fact: MemoryFact, ctx: AssessCtx): FactAssessment {
  const authority = authorityOf(fact)
  const support = supportOf(fact)
  if (fact.status === 'superseded') return { authority, support, effectiveStatus: 'superseded' }
  if (ctx.hasOpenConflict) return { authority, support, effectiveStatus: 'needs-confirmation', reason: 'conflict' }
  if (support < 0.5) return { authority, support, effectiveStatus: 'needs-confirmation', reason: 'low-support' }
  const window = confirmWindowMs(fact)
  if (window !== null && ctx.now - freshnessBase(fact) > window)
    return { authority, support, effectiveStatus: 'needs-confirmation', reason: 'expired' }
  return { authority, support, effectiveStatus: 'active' }
}

// ---------- 相关性:2-gram 包含度(只做检索候选与去重,不做事实替代判断) ----------

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[\s,,。.!!??;;::''"'"“”「」()()、|·~～\-—]/g, '')
}

/** 证据摘录校验:摘录归一化(去空白/标点/大小写)后必须出现在原文里——
 *  模型编造的"原句"在这里被拦下 */
export function evidenceExcerptHolds(source: string, excerpt: string): boolean {
  const q = normalizeText(excerpt)
  if (!q) return false
  return normalizeText(source).includes(q)
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

/** 开放事实(无 slot)的高相似判定:双向 2-gram ≥ 0.85,只用于去重合并,不用于替代 */
export function openFactSimilar(a: string, b: string): boolean {
  return Math.min(relevance(a, b), relevance(b, a)) >= 0.85
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

// ---------- 事实更新裁决矩阵 ----------

export type SupersedeDecision =
  | { kind: 'merge' }
  | { kind: 'replace' }
  | { kind: 'conflict'; reason: MemoryConflict['reason'] }
  | { kind: 'coexist' }

function proposalAuthority(proposal: FactProposal): MemoryAuthority {
  let best: MemoryAuthority = 'legacy'
  for (const ev of proposal.evidence) {
    const a = evidenceAuthority(ev)
    if (AUTHORITY_RANK[a] > AUTHORITY_RANK[best]) best = a
  }
  return best
}

/**
 * 同 slot 更新裁决(V3 核心)。不变量:同一 slot 不允许两个 active 事实同时进入检索;
 * 低权威新信息永不静默覆盖高权威旧事实,分歧一律进冲突队列。
 *
 * 同 slot 同值(归一化后)→ merge:合并 evidence、刷新 lastSeen,权威/支持度只升不降。
 * 同 slot 异值:
 *   - incoming 带用户编辑 → replace(用户亲手改的值永远说了算)
 *   - 旧事实是人工事实(authored/confirmed),incoming 来自机器 → conflict(confirmed-fact-changed)
 *   - 旧事实 inferred/legacy:incoming 为明确陈述(explicit)或可信事件(verified)→ replace;
 *     含糊的普通提取说不清谁新谁旧 → conflict(ambiguous-change)
 *   - 旧事实 verified:可信事件对可信事件 → replace;提取/指令 → conflict(lower-authority)
 *   - 其余按权威序数:高过旧事实 → replace;低过 → conflict(lower-authority);平权 → conflict(ambiguous-change)
 * 开放事实(无 slot):不靠模糊文本判矛盾——调用方按同文/高相似定位后 merge,否则 coexist。
 */
export function decideFactUpdate(existing: MemoryFact, incoming: FactProposal): SupersedeDecision {
  const inSlot = isMemorySlot(incoming.slot) && (incoming.value ?? '').trim() ? incoming.slot : undefined
  if (existing.slot !== undefined && inSlot !== undefined && existing.slot === inSlot) {
    const exVal = normalizeSlotValue(existing.slot, existing.value ?? '')
    const inVal = normalizeSlotValue(inSlot, incoming.value ?? '')
    if (exVal && inVal) {
      if (exVal === inVal) return { kind: 'merge' }
      if (incoming.evidence.some((e) => e.kind === 'user-edited')) return { kind: 'replace' }
      const exAuth = authorityOf(existing)
      const inAuth = proposalAuthority(incoming)
      if (exAuth === 'authored' || exAuth === 'confirmed') return { kind: 'conflict', reason: 'confirmed-fact-changed' }
      if (exAuth === 'inferred' || exAuth === 'legacy') {
        return inAuth === 'explicit' || inAuth === 'verified'
          ? { kind: 'replace' }
          : { kind: 'conflict', reason: 'ambiguous-change' }
      }
      if (exAuth === 'verified' && inAuth === 'verified') return { kind: 'replace' }
      if (AUTHORITY_RANK[inAuth] < AUTHORITY_RANK[exAuth]) return { kind: 'conflict', reason: 'lower-authority' }
      return { kind: 'conflict', reason: 'ambiguous-change' }
    }
  }
  if (existing.slot === undefined && inSlot === undefined) return { kind: 'merge' }
  return { kind: 'coexist' }
}

// ---------- 检索流水线:资格过滤 → 时效 → 相关性 → 加权 → 选择 ----------

export interface QueryOptions {
  query: string
  purpose: MemoryPurpose
  now: number
  n: number
  rules?: MemoryRule[]
  /** 未解决冲突:对应 slot 在被动注入里整体封禁(裁决期间不站队);显式搜索不受限 */
  conflicts?: MemoryConflict[]
}

const PRIVATE_PASSIVE_RELEVANCE = 0.35
const HISTORICAL_PASSIVE_RELEVANCE = 0.2

/** 事实评分:支持度 0.5 + 相关性 0.4 + 固定 0.3 + 确认新近 0.1(全部确定性) */
export function scoreFact(fact: MemoryFact, query: string, now: number): number {
  const r = relevance(fact.content + (fact.value ?? ''), query)
  const base = freshnessBase(fact)
  const confirmRecency = Math.max(0, 1 - (now - base) / (365 * DAY_MS))
  return 0.5 * supportOf(fact) + 0.4 * r + (fact.pinned ? 0.3 : 0) + 0.1 * confirmRecency
}

/**
 * 唯一记忆检索入口:被动注入与显式搜索共用,差别只在资格宽度。
 * 返回 selected(注入集合,refs/promptFacts 均由它派生)与 candidates(归因 trace,
 * 只含 id/分数/枚举,不含正文——删除语义不破)。
 */
export function queryMemory(
  facts: MemoryFact[],
  opts: QueryOptions,
): { selected: SelectedMemory[]; candidates: MemoryCandidateTrace[]; queriedAt: number } {
  const { query, purpose, now, n, rules = [], conflicts = [] } = opts
  const conflictedFactIds = new Set(conflicts.map((c) => c.existingFactId))
  const blockedSlots = new Set(conflicts.map((c) => c.slot))
  const scored: { fact: MemoryFact; score: number }[] = []
  const candidates: MemoryCandidateTrace[] = []

  for (const fact of facts) {
    const eff = assessFact(fact, { now, hasOpenConflict: conflictedFactIds.has(fact.id) })
    const push = (outcome: TraceOutcome) =>
      candidates.push({ id: fact.id, score: 0, outcome, effectiveStatus: eff.effectiveStatus, reason: eff.reason })
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
      // 冲突裁决期间该 slot 整体封禁:新旧谁对由用户说了算,角色先不站队
      if ((fact.slot !== undefined && blockedSlots.has(fact.slot)) || eff.reason === 'conflict') {
        push('conflict')
        continue
      }
      if (eff.effectiveStatus !== 'active') {
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
  const selected: SelectedMemory[] = scored.slice(0, n).map(({ fact, score }) => {
    const eff = assessFact(fact, { now, hasOpenConflict: conflictedFactIds.has(fact.id) })
    return {
      id: fact.id,
      text: fact.content,
      source,
      score,
      effectiveStatus: eff.effectiveStatus,
      reason: eff.reason,
    }
  })
  for (const s of selected) {
    candidates.push({ id: s.id, score: s.score, outcome: 'selected', effectiveStatus: s.effectiveStatus, reason: s.reason })
  }
  for (const { fact, score } of scored.slice(n)) {
    const eff = assessFact(fact, { now, hasOpenConflict: conflictedFactIds.has(fact.id) })
    candidates.push({ id: fact.id, score, outcome: 'limit', effectiveStatus: eff.effectiveStatus, reason: eff.reason })
  }
  return { selected, candidates, queriedAt: now }
}
