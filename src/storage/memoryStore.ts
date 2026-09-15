// 使用者记忆库:appData/data/memory.json(v3)。三块内容——
// facts[]:从聊天里自动提取的"关于观众的事实",带 slot/敏感级/确认窗/状态机与完整
//   来源证据 evidence[];权威与支持度永远从 evidence 派生,不落盘(语义决策在 memoryPolicy);
// conflicts[]:同 slot 异值的裁决队列——低权威信息不静默覆盖,等用户在设置页二选一;
// ingestLog[]:摄取账本(最近 N 条:pending/applied/skipped/conflict/failed,只记 id 与
//   数量枚举,不存正文);
// rules[]:禁止自动保存规则(结构化 scope:slot/category/sensitivity/phrase);
// topicStats/counters:话题种子计数与行为计数(与 facts 共库但语义独立)。
// V3 不变量:同一 slot 任意时刻至多一个 active 事实(sanitize 兜底清槽 + ingest 裁决保证);
// 人工确认的事实(authored/confirmed)永不被机器提取静默覆盖。
// 读写统一走 Rust 状态中心;**变更走 mutateMemory CAS 循环**(读 revision→应用纯
// mutation→data_set_if_revision 条件提交,conflict 则取最新值重放)——双窗并发
// (主窗后台提取 × 设置窗编辑)靠 revision 对比不丢更新,进程锁只串行化判定本身。
// 一次摄取的事实/冲突/账本终态在同一个 mutation 内提交,不拆步。
// 浏览器预览降级 localStorage(单窗,无 CAS 语义)。失败静默不影响演出。

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'
import {
  authorityRank,
  decideFactUpdate,
  defaultVolatility,
  detectSensitivity,
  maxSensitivity,
  openFactSimilar,
  queryMemory,
  ruleMatches,
  supportOf,
  type MemoryCandidateTrace,
  type MemoryPurpose,
  type MemorySensitivity,
  type MemoryTrace,
  type MemoryVolatility,
  type SelectedMemory,
} from './memoryPolicy'
import { isMemorySlot, normalizeSlotValue, SLOT_POLICY, type MemorySlot } from './memorySlots'

export type FactCategory = 'identity' | 'preference' | 'habit' | 'people' | 'event' | 'other'
export type { MemorySensitivity, MemoryVolatility, MemorySlot }

/** 模型提取断言:explicit=用户明确说出,implicit=从发言间接体现;unknown=V2 迁移数据(未分级) */
export type FactAssertion = 'explicit' | 'implicit' | 'unknown'

/**
 * 来源证据(封闭白名单判别联合):一条事实"凭什么被相信"的完整履历。
 * evidence[0]=首次来源,末条=最近更新;权威/支持度/时效全部由此派生,不落盘。
 * - model-extraction:模型提取,必须带用户原句摘录(excerpt 能在原文中找到才收)
 * - explicit-command:明确的"记住…"指令(识别后续接入;证据同上)
 * - verified-event:可信结构化事件(eventId 幂等)
 * - user-confirmed / user-edited:用户本人的手;legacy:无法定位原始证据的旧数据
 */
export type MemoryEvidence =
  | { kind: 'model-extraction'; turnId: string | null; excerpt: string; assertion: FactAssertion; at: number }
  | { kind: 'explicit-command'; turnId: string | null; excerpt: string; at: number }
  | { kind: 'verified-event'; eventId: string; provider: string; at: number }
  | { kind: 'user-confirmed'; at: number }
  | { kind: 'user-edited'; text: string; at: number }
  | { kind: 'legacy'; at: number }

/** 待入库提案:摄取校验后的规范候选(裁决矩阵的输入) */
export interface FactProposal {
  content: string
  category: FactCategory
  slot?: MemorySlot
  value?: string
  volatility: MemoryVolatility
  sensitivity: MemorySensitivity
  evidence: MemoryEvidence[]
}

/** 摄取入口的宽松提案:分类/volatility/敏感度/slot 白名单由 normalizeProposal 在入库前归一 */
export interface FactProposalInput {
  content: string
  category?: FactCategory
  slot?: string
  value?: string
  volatility?: MemoryVolatility
  sensitivity?: MemorySensitivity
  evidence: MemoryEvidence[]
}

export interface MemoryFact {
  id: string
  content: string
  category: FactCategory
  /** 受控语义槽位(白名单见 memorySlots);冲突替代只在同 slot 间成立 */
  slot?: MemorySlot
  value?: string
  volatility: MemoryVolatility
  sensitivity: MemorySensitivity
  /** 持久化仅两态;needs-confirmation 由 policy 按 evidence+时间戳动态派生,不落盘 */
  status: 'active' | 'superseded'
  /** 被哪个事实替代(V3 冲突解决/迁移写入) */
  supersededBy?: string
  createdAt: number
  lastSeen: number
  pinned: boolean
  evidence: MemoryEvidence[]
}

export interface MemoryRule {
  id: string
  scope: 'slot' | 'category' | 'sensitivity' | 'phrase'
  value: string
  createdAt: number
}

export type MemoryConflictReason = 'lower-authority' | 'ambiguous-change' | 'confirmed-fact-changed'

/** 同 slot 异值的裁决队列:existingFactId 指向当前 active 事实,proposed 是挑战方 */
export interface MemoryConflict {
  id: string
  slot: MemorySlot
  existingFactId: string
  proposed: FactProposal
  reason: MemoryConflictReason
  createdAt: number
}

export type IngestReason = 'no-durable-fact' | 'invalid-evidence' | 'privacy-rule' | 'invalid-output' | 'model-error'

/** 摄取账本记录:只记 id/数量/枚举原因,不存用户正文 */
export interface MemoryIngestRecord {
  id: string
  turnId: string | null
  status: 'pending' | 'applied' | 'skipped' | 'conflict' | 'failed'
  candidateCount: number
  appliedFactIds: string[]
  supersededFactIds?: string[]
  conflictIds?: string[]
  rejected?: number
  reason?: IngestReason
  createdAt: number
  completedAt?: number
}

export interface MemoryData {
  version: 3
  facts: MemoryFact[]
  conflicts: MemoryConflict[]
  ingestLog: MemoryIngestRecord[]
  rules: MemoryRule[]
  topicStats: Record<string, TopicStat>
  counters: { pokes: number; modeUses: Record<string, number> }
}

export interface TopicStat {
  seen: number
  favored: number
  replays: number
  /** 看完一集的弱正信号(自动重放不计,防系统自播自我强化) */
  watched: number
  /** 演出中途按停止的负信号(播过 80% 以上不算) */
  skipped: number
  /** 观众显式点赞(弱于收藏:看完都不点的那一下比收藏轻) */
  liked: number
  /** 观众显式点踩(改评/撤销可逆,±记账) */
  disliked: number
}

const MAX_FACTS = 200
const MAX_EVIDENCE = 4
const MAX_CONFLICTS = 30
const INGEST_LOG_MAX = 150
/** pinned 软上限:不强制淘汰,超出时 UI 提示 */
export const MAX_PINNED_SOFT = 30
const LS_KEY = 'vc-memory'

const EMPTY: MemoryData = {
  version: 3,
  facts: [],
  conflicts: [],
  ingestLog: [],
  rules: [],
  topicStats: {},
  counters: { pokes: 0, modeUses: {} },
}

let cache: MemoryData | null = null

function clone(data: MemoryData): MemoryData {
  return JSON.parse(JSON.stringify(data)) as MemoryData
}

function genId(prefix: string): string {
  return `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 8)}`
}

// ---------- 清洗与迁移(读路径:任意旧形状 → 合法 v3;保守、幂等、不伪造证据) ----------

function sanitizeEvidenceList(raw: unknown, createdAt: number): MemoryEvidence[] {
  const out: MemoryEvidence[] = []
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (out.length >= MAX_EVIDENCE) break
      const o = (e ?? {}) as Record<string, unknown>
      const at = Number(o.at) || createdAt
      const turnId = typeof o.turnId === 'string' && o.turnId ? o.turnId.slice(0, 64) : null
      const excerpt = typeof o.excerpt === 'string' ? o.excerpt.slice(0, 120) : ''
      switch (o.kind) {
        case 'model-extraction': {
          const assertion = o.assertion === 'explicit' || o.assertion === 'implicit' ? o.assertion : 'unknown'
          out.push({ kind: 'model-extraction', turnId, excerpt, assertion, at })
          break
        }
        case 'explicit-command':
          out.push({ kind: 'explicit-command', turnId, excerpt, at })
          break
        case 'verified-event':
          if (typeof o.eventId === 'string' && o.eventId)
            out.push({
              kind: 'verified-event',
              eventId: o.eventId.slice(0, 80),
              provider: typeof o.provider === 'string' && o.provider ? o.provider.slice(0, 40) : 'unknown',
              at,
            })
          break
        case 'user-confirmed':
          out.push({ kind: 'user-confirmed', at })
          break
        case 'user-edited':
          out.push({ kind: 'user-edited', text: (typeof o.text === 'string' && o.text ? o.text : excerpt).slice(0, 120), at })
          break
        case 'legacy':
          out.push({ kind: 'legacy', at })
          break
        case 'extracted':
          // V2 形状映射为 model-extraction(assertion=unknown:不伪造分级,支持度按 implicit 档)
          out.push({ kind: 'model-extraction', turnId, excerpt, assertion: 'unknown', at })
          break
        default:
          break // 未知种类丢弃,不伪造
      }
    }
  }
  if (out.length === 0) out.push({ kind: 'legacy', at: createdAt })
  return out
}

/** 事实/提案共用字段清洗:白名单、敏感三源取严、volatility 兜底 */
function cleanFactFields(o: Record<string, unknown>): {
  content: string
  category: FactCategory
  slot: MemorySlot | undefined
  value: string | undefined
  sensitivity: MemorySensitivity
  volatility: MemoryVolatility
  createdAt: number
} | null {
  const content = typeof o.content === 'string' ? o.content.trim().slice(0, 120) : ''
  if (!content) return null
  const cats: FactCategory[] = ['identity', 'preference', 'habit', 'people', 'event', 'other']
  const category = cats.includes(o.category as FactCategory) ? (o.category as FactCategory) : 'other'
  const slot = isMemorySlot(o.slot) ? o.slot : undefined
  // slot 有值时必须带非空 value,否则整条降级为开放事实(开放事实永不参与槽位替代)
  const rawValue = typeof o.value === 'string' ? o.value.trim() : ''
  const value = slot && rawValue ? normalizeSlotValue(slot, rawValue) : undefined
  const effectiveSlot = value ? slot : undefined
  const modelSensitivity: MemorySensitivity | undefined =
    o.sensitivity === 'private' || o.sensitivity === 'restricted' || o.sensitivity === 'normal'
      ? o.sensitivity
      : undefined
  // 敏感度三源取严:模型标注 ∨ 确定性检测 ∨ slot 注册表
  const sensitivity = maxSensitivity(
    modelSensitivity,
    detectSensitivity(content),
    effectiveSlot ? SLOT_POLICY[effectiveSlot].sensitivity : undefined,
  )
  const volatility: MemoryVolatility =
    o.volatility === 'stable' || o.volatility === 'historical' || o.volatility === 'changeable'
      ? o.volatility
      : effectiveSlot
        ? SLOT_POLICY[effectiveSlot].volatility
        : defaultVolatility(category)
  const createdAt = Number(o.createdAt ?? o.ts) || Date.now()
  return { content, category, slot: effectiveSlot, value, sensitivity, volatility, createdAt }
}

/** 清洗一条来自文件/迁移的事实(v1 按 ts、v2 按散字段识别并迁 v3),非法返回 null。
 *  confidence/sourceTurnId/sourceExcerpt/lastConfirmedAt/hits 不再持久化——丢弃,
 *  权威与支持度改由 evidence 派生(V2 evidence 原样映射,不伪造分级) */
export function sanitizeFact(raw: unknown): MemoryFact | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const fields = cleanFactFields(o)
  if (!fields) return null
  const { content, category, slot, value, sensitivity, volatility, createdAt } = fields
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : genId('f'),
    content,
    category,
    slot,
    value,
    volatility,
    sensitivity,
    status: o.status === 'superseded' ? 'superseded' : 'active',
    supersededBy: typeof o.supersededBy === 'string' && o.supersededBy ? o.supersededBy.slice(0, 40) : undefined,
    createdAt,
    lastSeen: Number(o.lastSeen) || createdAt,
    pinned: o.pinned === true,
    evidence: sanitizeEvidenceList(o.evidence, createdAt),
  }
}

function sanitizeProposal(raw: unknown): FactProposal | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const fields = cleanFactFields(o)
  if (!fields) return null
  const { content, category, slot, value, sensitivity, volatility, createdAt } = fields
  return { content, category, slot, value, volatility, sensitivity, evidence: sanitizeEvidenceList(o.evidence, createdAt) }
}

function sanitizeRules(raw: unknown): MemoryRule[] {
  if (!Array.isArray(raw)) return []
  const scopes = ['slot', 'category', 'sensitivity', 'phrase']
  return raw
    .slice(0, 100)
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>
      const scope = scopes.includes(o.scope as string) ? (o.scope as MemoryRule['scope']) : null
      const value = typeof o.value === 'string' ? o.value.trim().slice(0, 80) : ''
      if (!scope || !value) return null
      return {
        id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : genId('r'),
        scope,
        value,
        createdAt: Number(o.createdAt) || Date.now(),
      }
    })
    .filter((r): r is MemoryRule => r !== null)
}

function sanitizeConflicts(raw: unknown, facts: MemoryFact[]): MemoryConflict[] {
  if (!Array.isArray(raw)) return []
  const reasons: MemoryConflictReason[] = ['lower-authority', 'ambiguous-change', 'confirmed-fact-changed']
  const out: MemoryConflict[] = []
  for (const c of raw.slice(0, MAX_CONFLICTS)) {
    const o = (c ?? {}) as Record<string, unknown>
    const slot = isMemorySlot(o.slot) ? o.slot : null
    const existingFactId = typeof o.existingFactId === 'string' ? o.existingFactId : ''
    if (!slot || !existingFactId || !reasons.includes(o.reason as MemoryConflictReason)) continue
    // 指向已删事实的冲突单自愈丢弃
    if (!facts.some((f) => f.id === existingFactId)) continue
    const proposed = sanitizeProposal(o.proposed)
    if (!proposed) continue
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : genId('c'),
      slot,
      existingFactId: existingFactId.slice(0, 40),
      proposed,
      reason: o.reason as MemoryConflictReason,
      createdAt: Number(o.createdAt) || Date.now(),
    })
  }
  return out
}

function sanitizeIngestLog(raw: unknown): MemoryIngestRecord[] {
  if (!Array.isArray(raw)) return []
  const statuses = ['pending', 'applied', 'skipped', 'conflict', 'failed']
  const out: MemoryIngestRecord[] = []
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>
    if (typeof o.status !== 'string' || !statuses.includes(o.status)) continue
    const ids = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : []
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : genId('ing'),
      turnId: typeof o.turnId === 'string' ? o.turnId.slice(0, 64) : null,
      status: o.status as MemoryIngestRecord['status'],
      candidateCount: Math.max(0, Number(o.candidateCount) || 0),
      appliedFactIds: ids(o.appliedFactIds),
      supersededFactIds: ids(o.supersededFactIds),
      conflictIds: ids(o.conflictIds),
      rejected: Math.max(0, Number(o.rejected) || 0),
      reason: typeof o.reason === 'string' ? (o.reason as IngestReason) : undefined,
      createdAt: Number(o.createdAt) || Date.now(),
      completedAt: Number(o.completedAt) || undefined,
    })
  }
  return out.slice(-INGEST_LOG_MAX)
}

/** V3 不变量落地(每次 sanitize 兜底,幂等):同 slot 只留权威最高的 active
 *  (平手取最近看到),其余转 superseded 并登记冲突等用户裁决 */
function dedupeSlotActives(data: MemoryData): MemoryData {
  const bySlot = new Map<MemorySlot, MemoryFact[]>()
  for (const f of data.facts) {
    if (f.status !== 'active' || f.slot === undefined) continue
    const list = bySlot.get(f.slot) ?? []
    list.push(f)
    bySlot.set(f.slot, list)
  }
  for (const [slot, list] of bySlot) {
    if (list.length <= 1) continue
    const ranked = [...list].sort(
      (a, b) => authorityRank(b) - authorityRank(a) || b.lastSeen - a.lastSeen,
    )
    const winner = ranked[0]
    for (const loser of ranked.slice(1)) {
      loser.status = 'superseded'
      loser.supersededBy = winner.id
      if (!data.conflicts.some((c) => c.slot === slot)) {
        data.conflicts.push({
          id: genId('c'),
          slot,
          existingFactId: winner.id,
          proposed: factToProposal(loser),
          reason: authorityRank(winner) > authorityRank(loser) ? 'lower-authority' : 'ambiguous-change',
          createdAt: Date.now(),
        })
      }
    }
  }
  if (data.conflicts.length > MAX_CONFLICTS) data.conflicts = data.conflicts.slice(-MAX_CONFLICTS)
  return data
}

function sanitize(data: unknown): MemoryData {
  const o = (data ?? {}) as Record<string, unknown>
  const facts = Array.isArray(o.facts)
    ? o.facts.map(sanitizeFact).filter((f): f is MemoryFact => f !== null)
    : []
  const topicStats: Record<string, TopicStat> = {}
  if (o.topicStats && typeof o.topicStats === 'object') {
    for (const [k, v] of Object.entries(o.topicStats as Record<string, unknown>)) {
      const s = (v ?? {}) as Record<string, unknown>
      topicStats[k.slice(0, 80)] = {
        seen: Math.max(0, Number(s.seen) || 0),
        favored: Math.max(0, Number(s.favored) || 0),
        replays: Math.max(0, Number(s.replays) || 0),
        watched: Math.max(0, Number(s.watched) || 0),
        skipped: Math.max(0, Number(s.skipped) || 0),
        liked: Math.max(0, Number(s.liked) || 0),
        disliked: Math.max(0, Number(s.disliked) || 0),
      }
    }
  }
  const counters = (o.counters ?? {}) as Record<string, unknown>
  const modeUses: Record<string, number> = {}
  if (counters.modeUses && typeof counters.modeUses === 'object') {
    for (const [k, v] of Object.entries(counters.modeUses as Record<string, unknown>)) {
      modeUses[k.slice(0, 40)] = Math.max(0, Number(v) || 0)
    }
  }
  const next: MemoryData = {
    version: 3,
    facts: facts.slice(0, MAX_FACTS),
    conflicts: sanitizeConflicts(o.conflicts, facts),
    ingestLog: sanitizeIngestLog(o.ingestLog),
    rules: sanitizeRules(o.rules),
    topicStats,
    counters: { pokes: Math.max(0, Number(counters.pokes) || 0), modeUses },
  }
  return clone(dedupeSlotActives(next))
}

/** 整仓清洗/迁移(v2→v3 幂等;测试与导出前可用) */
export function sanitizeMemoryData(data: unknown): MemoryData {
  return sanitize(data)
}

async function loadRaw(): Promise<MemoryData> {
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitize(JSON.parse(raw))
    } catch (e) {
      console.warn('浏览器记忆读取失败', e)
    }
    return clone(EMPTY)
  }
  try {
    // Rust 状态中心:进程锁串行 + 内存缓存,坏数据/缺文件按空仓处理
    const res = await invoke<{ revision: number; value: unknown }>('data_get_with_revision', { store: 'memory' })
    return sanitize(res.value)
  } catch (e) {
    console.warn('记忆读取失败', e)
  }
  return clone(EMPTY)
}

/** 回合记忆上下文:selected 是唯一事实源,promptFacts/refs 由它派生(结构保证
 *  "实际注入 = 界面显示"的同构,不靠两份数组人工对齐) */
export interface TurnMemoryContext {
  selected: SelectedMemory[]
  candidates: MemoryCandidateTrace[]
  queriedAt: number
  promptFacts: string[]
  refs: { id: string; source: 'passive' | 'search-tool' }[]
}

export function emptyTurnMemory(): TurnMemoryContext {
  return { selected: [], candidates: [], queriedAt: 0, promptFacts: [], refs: [] }
}

/** 唯一检索入口:被动注入与显式搜索(search_memory)都走这里,策略只在 memoryPolicy 一处 */
export async function prepareTurnMemory(opts: {
  query: string
  n?: number
  purpose?: MemoryPurpose
}): Promise<TurnMemoryContext> {
  const mem = await getMemory()
  const r = queryMemory(mem.facts, {
    query: opts.query,
    purpose: opts.purpose ?? 'passive-context',
    now: Date.now(),
    n: opts.n ?? 3,
    rules: mem.rules,
    conflicts: mem.conflicts,
  })
  return {
    selected: r.selected,
    candidates: r.candidates,
    queriedAt: r.queriedAt,
    promptFacts: r.selected.map((s) => s.text),
    refs: r.selected.map((s) => ({ id: s.id, source: s.source })),
  }
}

/** 回合检索的完整 trace(仅 id/分数/枚举,无正文);debug 显示档才落盘到聊天日志 */
export function traceOf(ctx: TurnMemoryContext): MemoryTrace {
  return {
    queriedAt: ctx.queriedAt,
    used: ctx.selected.map((s) => ({ id: s.id, source: s.source, score: s.score })),
    candidates: ctx.candidates,
  }
}

/** 读全部记忆(内存缓存;store-changed 广播保持两窗一致) */
export async function getMemory(): Promise<MemoryData> {
  if (!cache) cache = await loadRaw()
  return clone(cache)
}

/**
 * CAS 变更循环:读(带 revision)→ 应用纯 mutation → 条件提交。
 * conflict = 另一窗先写了:采纳返回的最新值,重放本 mutation(≤3 次,仍冲突则报错——
 * 说明竞争极烈,由调用方的静默降级兜底)。withFileLock 串行化本窗并发,减少无谓重放。
 */
async function mutateMemory<T>(fn: (data: MemoryData) => { data: MemoryData; result: T }): Promise<T> {
  return withFileLock('memory', async () => {
    if (!inTauri) {
      const cur = cache ?? (await loadRaw())
      const { data, result } = fn(cur)
      cache = sanitize(data)
      localStorage.setItem(LS_KEY, JSON.stringify(cache))
      return result
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await invoke<{ revision: number; value: unknown }>('data_get_with_revision', { store: 'memory' })
      const fresh = sanitize(cur.value)
      cache = fresh
      const { data, result } = fn(fresh)
      const res = await invoke<{ status: 'ok' | 'conflict'; revision?: number; value?: unknown }>(
        'data_set_if_revision',
        { store: 'memory', expectedRevision: cur.revision, value: data },
      )
      if (res.status === 'ok') {
        cache = sanitize(res.value)
        return result
      }
      // conflict:采纳最新值,下一圈重放 mutation
      cache = sanitize(res.value)
    }
    throw new Error('记忆写入冲突:连续 3 次版本过期')
  })
}

if (inTauri) {
  // Rust 状态中心的广播(data_set / data_set_if_revision 成功后发给全部窗口,含写者,
  // 幂等采纳):任一窗改了记忆,两窗缓存与 revision 即时对齐
  void listen<{ store?: string; value?: unknown; revision?: number }>('store-changed', (e) => {
    if (e.payload?.store !== 'memory' || e.payload.value === undefined) return
    cache = sanitize(e.payload.value)
  })
}

// ---------- 淘汰 ----------

/** 淘汰:超 200 条时按 superseded(保留最近 5 条历史)→ 非固定低支持度最旧 → 固定最旧
 *  的顺序丢;pinned 不豁免总量(软上限由 UI 提示,不在此强制) */
export function evict(facts: MemoryFact[]): MemoryFact[] {
  if (facts.length <= MAX_FACTS) return facts
  const overflow = facts.length - MAX_FACTS
  const supersededOldFirst = facts
    .filter((f) => f.status === 'superseded')
    .sort((a, b) => a.lastSeen - b.lastSeen)
  const dropOrder = [
    ...supersededOldFirst.slice(0, Math.max(0, supersededOldFirst.length - 5)), // 最近 5 条历史保留
    ...facts
      .filter((f) => f.status !== 'superseded')
      .sort(
        (a, b) =>
          Number(a.pinned) - Number(b.pinned) ||
          supportOf(a) - supportOf(b) ||
          a.lastSeen - b.lastSeen,
      ),
  ]
  const drop = new Set<string>()
  for (const f of dropOrder) {
    if (drop.size >= overflow) break
    drop.add(f.id)
  }
  return facts.filter((f) => !drop.has(f.id))
}

// ---------- 摄取(原子:事实/冲突/账本终态一次 mutation 提交) ----------

export interface FactCandidate {
  content: string
  category?: FactCategory
  slot?: string
  value?: string
  volatility?: MemoryVolatility
  sensitivity?: MemorySensitivity
  /** 模型断言:explicit=用户明确说出,implicit=间接体现 */
  assertion?: 'explicit' | 'implicit'
  /** 用户原句摘录(来源证据;必须能在原文中找到) */
  excerpt?: string
}

export interface IngestInput {
  turnId: string | null
  proposals: FactProposalInput[]
  /** 校验前的候选总数(账本记录用) */
  candidateCount?: number
  /** 证据校验被拒的候选数(reason 归因用) */
  invalidCount?: number
}

export interface MemoryIngestReport {
  status: 'applied' | 'skipped' | 'conflict' | 'failed'
  candidateCount: number
  appliedFactIds: string[]
  supersededFactIds: string[]
  conflictIds: string[]
  rejected: number
  reason?: IngestReason
}

function pushEvidence(fact: MemoryFact, ev: MemoryEvidence): void {
  fact.evidence = [...fact.evidence, ev].slice(-MAX_EVIDENCE)
  if (fact.evidence[0] && fact.evidence.length >= MAX_EVIDENCE && fact.evidence[0].kind !== 'legacy') {
    // 保留首次来源:第二条起才允许被挤掉——首条换到前面保住
    const [origin, ...rest] = fact.evidence
    fact.evidence = [origin, ...rest.slice(0, MAX_EVIDENCE - 1)]
  }
}

function factToProposal(f: MemoryFact): FactProposal {
  return {
    content: f.content,
    category: f.category,
    slot: f.slot,
    value: f.value,
    volatility: f.volatility,
    sensitivity: f.sensitivity,
    evidence: f.evidence,
  }
}

/** 提案规范化:清洗字段、slot 白名单+缺 value 降级为开放事实、敏感三源取严、volatility 兜底 */
function normalizeProposal(p: FactProposalInput): FactProposal {
  const slot = isMemorySlot(p.slot) && (p.value ?? '').trim() ? p.slot : undefined
  const value = slot ? normalizeSlotValue(slot, (p.value ?? '').trim()) : undefined
  const content = p.content.trim().slice(0, 120)
  const category = p.category ?? 'other'
  return {
    content,
    category,
    slot,
    value,
    sensitivity: maxSensitivity(p.sensitivity, detectSensitivity(content), slot ? SLOT_POLICY[slot].sensitivity : undefined),
    volatility: p.volatility ?? (slot ? SLOT_POLICY[slot].volatility : defaultVolatility(category)),
    evidence: p.evidence,
  }
}

function newFactFromProposal(p: FactProposal, now: number): MemoryFact {
  return {
    id: genId('f'),
    content: p.content,
    category: p.category,
    slot: p.slot,
    value: p.value,
    volatility: p.volatility,
    sensitivity: p.sensitivity,
    status: 'active',
    createdAt: now,
    lastSeen: now,
    pinned: false,
    evidence: p.evidence,
  }
}

/**
 * 纯摄取计划器(测试可直接调):规则闸 → 定位既有事实(同 slot 任意值的 active 优先,
 * 再精确同文,再无 slot 高相似)→ decideFactUpdate 裁决 → merge/replace/建冲突/新建
 * → 冲突与账本容量收敛 → 淘汰。所有写入结果在同一个返回的 data 里,由调用方一次提交。
 */
function applyIngest(
  mem: MemoryData,
  input: IngestInput,
  now: number,
): { data: MemoryData; report: MemoryIngestReport } {
  const report: MemoryIngestReport = {
    status: 'skipped',
    candidateCount: input.candidateCount ?? input.proposals.length,
    appliedFactIds: [],
    supersededFactIds: [],
    conflictIds: [],
    rejected: 0,
  }
  for (const raw of input.proposals) {
    const p = normalizeProposal(raw)
    // 规则闸:命中禁止规则的内容永不入库(第一道在提取 prompt)
    if (mem.rules.some((r) => ruleMatches({ content: p.content, slot: p.slot, category: p.category, sensitivity: p.sensitivity }, r))) {
      report.rejected++
      continue
    }
    // 定位既有条目:同 slot 任意值的 active 优先(V3 修复:值变化也要找到旧事实裁决)
    let existing: MemoryFact | undefined
    if (p.slot !== undefined && p.value !== undefined)
      existing = mem.facts.find((f) => f.status === 'active' && f.slot === p.slot)
    existing =
      existing ??
      mem.facts.find((f) => f.status === 'active' && f.content === p.content) ??
      (p.slot === undefined
        ? mem.facts.find((f) => f.status === 'active' && f.slot === undefined && openFactSimilar(f.content, p.content))
        : undefined)
    const decision = existing ? decideFactUpdate(existing, p) : undefined
    if (existing && (decision?.kind === 'merge' || decision?.kind === 'coexist')) {
      // 同值重申/开放事实高相似:合并证据,权威与支持度只升不降;同轮重复不加分(supportOf 按 turnId 去重)
      for (const ev of p.evidence) pushEvidence(existing, ev)
      existing.lastSeen = now
      report.appliedFactIds.push(existing.id)
    } else if (existing && decision?.kind === 'replace') {
      const fresh = newFactFromProposal(p, now)
      existing.status = 'superseded'
      existing.supersededBy = fresh.id
      mem.facts.push(fresh)
      report.appliedFactIds.push(fresh.id)
      report.supersededFactIds.push(existing.id)
    } else if (existing && decision?.kind === 'conflict') {
      // 同 slot 只留一张等待裁决的冲突单:新提议覆盖旧提议(以最近一次用户陈述为准)
      const prev = mem.conflicts.findIndex((c) => c.slot === p.slot)
      const row: MemoryConflict = {
        id: prev >= 0 ? mem.conflicts[prev].id : genId('c'),
        slot: p.slot as MemorySlot,
        existingFactId: existing.id,
        proposed: p,
        reason: decision.reason,
        createdAt: now,
      }
      if (prev >= 0) mem.conflicts[prev] = row
      else mem.conflicts.push(row)
      report.conflictIds.push(row.id)
    } else {
      // 无既有条目:新建(开放事实永不靠模糊文本替代别人)
      const fresh = newFactFromProposal(p, now)
      mem.facts.push(fresh)
      report.appliedFactIds.push(fresh.id)
    }
  }
  if (mem.conflicts.length > MAX_CONFLICTS) mem.conflicts = mem.conflicts.slice(-MAX_CONFLICTS)
  mem.facts = evict(mem.facts)
  report.status = report.conflictIds.length > 0 ? 'conflict' : report.appliedFactIds.length > 0 ? 'applied' : 'skipped'
  if (report.status === 'skipped')
    report.reason =
      report.candidateCount === 0
        ? 'no-durable-fact'
        : (input.invalidCount ?? 0) > 0
          ? 'invalid-evidence'
          : report.rejected > 0
            ? 'privacy-rule'
            : 'no-durable-fact'
  else if (report.rejected > 0) report.reason = 'privacy-rule'
  return { data: mem, report }
}

/** 账本收口:移除同轮 pending(崩溃恢复场景可能没有),追加终态记录 */
function finalizeIngestRecord(mem: MemoryData, turnId: string | null, report: MemoryIngestReport, now: number): void {
  mem.ingestLog = mem.ingestLog.filter((r) => !(r.status === 'pending' && r.turnId === turnId))
  mem.ingestLog.push({
    id: genId('ing'),
    turnId,
    status: report.status,
    candidateCount: report.candidateCount,
    appliedFactIds: report.appliedFactIds,
    supersededFactIds: report.supersededFactIds,
    conflictIds: report.conflictIds,
    rejected: report.rejected,
    reason: report.reason,
    createdAt: now,
    completedAt: now,
  })
  if (mem.ingestLog.length > INGEST_LOG_MAX) mem.ingestLog = mem.ingestLog.slice(-INGEST_LOG_MAX)
}

/** 原子摄取入口:事实/冲突/账本终态在同一次 CAS mutation 内提交 */
export async function ingestFacts(input: IngestInput): Promise<MemoryIngestReport> {
  return mutateMemory((mem) => {
    const now = Date.now()
    const { data, report } = applyIngest(mem, input, now)
    finalizeIngestRecord(data, input.turnId, report, now)
    return { data, result: report }
  })
}

/** 摄取账本:提取开始前写 pending(幂等;失败不阻断提取) */
export async function beginIngestRecord(turnId: string | null): Promise<void> {
  await mutateMemory((mem) => {
    if (mem.ingestLog.some((r) => r.status === 'pending' && r.turnId === turnId))
      return { data: mem, result: undefined as void }
    mem.ingestLog.push({
      id: genId('ing'),
      turnId,
      status: 'pending',
      candidateCount: 0,
      appliedFactIds: [],
      createdAt: Date.now(),
    })
    if (mem.ingestLog.length > INGEST_LOG_MAX) mem.ingestLog = mem.ingestLog.slice(-INGEST_LOG_MAX)
    return { data: mem, result: undefined as void }
  }).catch(() => {})
}

/** 摄取账本:模型失败记 failed(不影响聊天) */
export async function failIngestRecord(turnId: string | null, reason: IngestReason): Promise<void> {
  await mutateMemory((mem) => {
    const now = Date.now()
    mem.ingestLog = mem.ingestLog.filter((r) => !(r.status === 'pending' && r.turnId === turnId))
    mem.ingestLog.push({
      id: genId('ing'),
      turnId,
      status: 'failed',
      candidateCount: 0,
      appliedFactIds: [],
      reason,
      createdAt: now,
      completedAt: now,
    })
    if (mem.ingestLog.length > INGEST_LOG_MAX) mem.ingestLog = mem.ingestLog.slice(-INGEST_LOG_MAX)
    return { data: mem, result: undefined as void }
  }).catch(() => {})
}

export interface VerifiedEventInput {
  eventId: string
  provider: string
  content: string
  category?: FactCategory
  slot?: string
  value?: string
}

/** 可信结构化事件入库(未来直播会员身份等):按 eventId 幂等,重复事件原样返回;
 *  与既有同 slot 事实走同一套裁决矩阵(可信事件可替代 inferred/legacy,遇人工事实进冲突) */
export async function ingestVerifiedEvent(input: VerifiedEventInput): Promise<MemoryIngestReport> {
  return mutateMemory((mem) => {
    const now = Date.now()
    if (mem.facts.some((f) => f.evidence.some((e) => e.kind === 'verified-event' && e.eventId === input.eventId))) {
      return {
        data: mem,
        result: {
          status: 'skipped',
          candidateCount: 1,
          appliedFactIds: [],
          supersededFactIds: [],
          conflictIds: [],
          rejected: 0,
        } as MemoryIngestReport,
      }
    }
    const ev: MemoryEvidence = {
      kind: 'verified-event',
      eventId: input.eventId.slice(0, 80),
      provider: (input.provider || 'unknown').slice(0, 40),
      at: now,
    }
    const proposal = normalizeProposal({
      content: input.content,
      category: input.category ?? 'other',
      slot: input.slot,
      value: input.value,
      volatility: input.slot && isMemorySlot(input.slot) ? SLOT_POLICY[input.slot].volatility : undefined,
      sensitivity: input.slot && isMemorySlot(input.slot) ? SLOT_POLICY[input.slot].sensitivity : undefined,
      evidence: [ev],
    })
    const turnId = `verified:${input.eventId.slice(0, 48)}`
    const { data, report } = applyIngest(mem, { turnId, proposals: [proposal], candidateCount: 1 }, now)
    finalizeIngestRecord(data, turnId, report, now)
    return { data, result: report }
  })
}

// ---------- 冲突解决 ----------

/**
 * 冲突二选一(原子清除冲突单):
 * - keep:现 active 事实追加 user-confirmed(用户拍板"旧值还对")
 * - accept:同 slot 同值的被替代事实若存在则重新激活,否则按 proposal 建新事实;
 *   新值事实获得 user-confirmed,旧事实 superseded(supersededBy 指向新事实)
 */
export async function resolveConflict(id: string, choice: 'keep' | 'accept'): Promise<void> {
  await mutateMemory((mem) => {
    const idx = mem.conflicts.findIndex((c) => c.id === id)
    if (idx < 0) return { data: mem, result: undefined as void }
    const [conflict] = mem.conflicts.splice(idx, 1)
    const existing = mem.facts.find((f) => f.id === conflict.existingFactId)
    const now = Date.now()
    if (choice === 'keep') {
      if (existing) pushEvidence(existing, { kind: 'user-confirmed', at: now })
      return { data: mem, result: undefined as void }
    }
    const slot = conflict.slot
    const val = normalizeSlotValue(slot, conflict.proposed.value ?? '')
    const reactivated =
      val
        ? mem.facts.find(
            (f) =>
              f.id !== conflict.existingFactId &&
              f.slot === slot &&
              f.status === 'superseded' &&
              normalizeSlotValue(slot, f.value ?? '') === val,
          )
        : undefined
    if (reactivated) {
      reactivated.status = 'active'
      delete reactivated.supersededBy
      reactivated.lastSeen = now
      pushEvidence(reactivated, { kind: 'user-confirmed', at: now })
      if (existing) {
        existing.status = 'superseded'
        existing.supersededBy = reactivated.id
      }
    } else {
      const fresh = newFactFromProposal(conflict.proposed, now)
      pushEvidence(fresh, { kind: 'user-confirmed', at: now })
      if (existing) {
        existing.status = 'superseded'
        existing.supersededBy = fresh.id
      }
      mem.facts.push(fresh)
    }
    return { data: mem, result: undefined as void }
  })
}

// ---------- 变更 API(全部经 mutateMemory) ----------

export async function deleteFact(id: string): Promise<void> {
  await mutateMemory((mem) => {
    mem.facts = mem.facts.filter((f) => f.id !== id)
    // 指向已删事实的冲突单一并清除(sanitize 侧还有自愈兜底)
    mem.conflicts = mem.conflicts.filter((c) => c.existingFactId !== id)
    return { data: mem, result: undefined as void }
  })
}

export async function togglePinFact(id: string): Promise<void> {
  await mutateMemory((mem) => {
    const f = mem.facts.find((x) => x.id === id)
    if (f) f.pinned = !f.pinned
    return { data: mem, result: undefined as void }
  })
}

/** 用户编辑内容 = 最高权威(authored):追加 user-edited 证据,敏感度重取严 */
export async function editFact(id: string, content: string): Promise<void> {
  const text = content.trim().slice(0, 120)
  if (!text) return
  await mutateMemory((mem) => {
    const f = mem.facts.find((x) => x.id === id)
    if (!f) return { data: mem, result: undefined as void }
    const now = Date.now()
    f.content = text
    pushEvidence(f, { kind: 'user-edited', text: text.slice(0, 120), at: now })
    f.sensitivity = maxSensitivity(f.sensitivity, detectSensitivity(text), f.slot ? SLOT_POLICY[f.slot].sensitivity : undefined)
    return { data: mem, result: undefined as void }
  })
}

/** 手动"仍然有效":追加 user-confirmed 证据(status 不动——needs-confirmation 是派生态) */
export async function confirmFact(id: string): Promise<void> {
  await mutateMemory((mem) => {
    const f = mem.facts.find((x) => x.id === id)
    if (!f) return { data: mem, result: undefined as void }
    pushEvidence(f, { kind: 'user-confirmed', at: Date.now() })
    return { data: mem, result: undefined as void }
  })
}

export async function addRule(rule: { scope: MemoryRule['scope']; value: string }): Promise<MemoryRule | null> {
  const value = rule.value.trim().slice(0, 80)
  if (!value) return null
  return mutateMemory((mem) => {
    if (mem.rules.some((r) => r.scope === rule.scope && r.value === value)) {
      return { data: mem, result: mem.rules.find((r) => r.scope === rule.scope && r.value === value) ?? null }
    }
    const created: MemoryRule = {
      id: genId('r'),
      scope: rule.scope,
      value,
      createdAt: Date.now(),
    }
    mem.rules.push(created)
    return { data: mem, result: created }
  })
}

export async function removeRule(id: string): Promise<void> {
  await mutateMemory((mem) => {
    mem.rules = mem.rules.filter((r) => r.id !== id)
    return { data: mem, result: undefined as void }
  })
}

/** 清空自动记忆:facts 与冲突单清空,保留禁止规则/摄取账本/话题统计/画像——
 *  "删干净"不等于解除隐私偏好 */
export async function clearAutoMemory(): Promise<void> {
  await mutateMemory((mem) => {
    mem.facts = []
    mem.conflicts = []
    return { data: mem, result: undefined as void }
  })
}

/** 重置整个记忆系统:facts+conflicts+ingestLog+rules+topicStats+counters 全清(二次确认入口) */
export async function resetAllMemory(): Promise<void> {
  await mutateMemory((mem) => {
    mem.facts = []
    mem.conflicts = []
    mem.ingestLog = []
    mem.rules = []
    mem.topicStats = {}
    mem.counters = { pokes: 0, modeUses: {} }
    return { data: mem, result: undefined as void }
  })
}

/** 兼容旧 UI:等价 resetAllMemory(完整清空) */
export async function clearMemory(): Promise<void> {
  await resetAllMemory()
}

/** 导出记忆数据(显式动作;不含凭据,含 facts/conflicts/ingestLog/rules/统计) */
export async function exportMemory(): Promise<string> {
  const mem = await getMemory()
  return JSON.stringify(mem, null, 2)
}

/** 摘要 facts:pinned 优先,再按 lastSeen/支持度取前 n 条内容(遗留接口;策略检索见 memoryPolicy) */
export function topFacts(mem: MemoryData, n: number): string[] {
  return [...mem.facts]
    .filter((f) => f.status === 'active')
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || b.lastSeen - a.lastSeen || supportOf(b) - supportOf(a),
    )
    .slice(0, n)
    .map((f) => f.content)
}

// ---------- 话题统计与加权 ----------

/** 剥掉"种子（角度）"里的角度后缀,还原种子 */
export function stripAngle(topic: string | undefined): string {
  if (!topic) return ''
  return topic.replace(/（[^）]*）\s*$/, '').trim()
}

async function bumpTopic(
  topic: string | undefined,
  key: keyof Omit<TopicStat, never>,
  delta = 1,
): Promise<void> {
  const seed = stripAngle(topic)
  if (!seed || !Number.isFinite(delta) || delta === 0) return
  await mutateMemory((mem) => {
    // 七个键必须齐:漏键会让 stat[key] += 1 从 undefined 起步算出 NaN,污染权重
    const stat = mem.topicStats[seed] ?? {
      seen: 0,
      favored: 0,
      replays: 0,
      watched: 0,
      skipped: 0,
      liked: 0,
      disliked: 0,
    }
    stat[key] = Math.max(0, stat[key] + delta)
    mem.topicStats[seed] = stat
    return { data: mem, result: undefined as void }
  })
}

export function bumpTopicSeen(topic: string | undefined): void {
  void bumpTopic(topic, 'seen').catch(() => {})
}
export function bumpTopicFavored(topic: string | undefined): void {
  void bumpTopic(topic, 'favored').catch(() => {})
}
export function bumpTopicReplays(topic: string | undefined): void {
  void bumpTopic(topic, 'replays').catch(() => {})
}
export function bumpTopicWatched(topic: string | undefined): void {
  void bumpTopic(topic, 'watched').catch(() => {})
}
export function bumpTopicSkipped(topic: string | undefined): void {
  void bumpTopic(topic, 'skipped').catch(() => {})
}

/** 观众显式评价记账(feedbackStore 调):delta=-1 回退改评/撤销前的旧信号。
 *  返回 promise 供调用方等待(fire-and-forget 的调用方忽略即可) */
export function bumpTopicRated(
  topic: string | undefined,
  rating: 'up' | 'down',
  delta: 1 | -1,
): Promise<void> {
  return bumpTopic(topic, rating === 'up' ? 'liked' : 'disliked', delta).catch(() => {})
}

export function bumpPoke(): void {
  void mutateMemory((mem) => {
    mem.counters.pokes += 1
    return { data: mem, result: undefined as void }
  }).catch(() => {})
}

export function bumpMode(mode: string): void {
  void mutateMemory((mem) => {
    mem.counters.modeUses[mode] = (mem.counters.modeUses[mode] ?? 0) + 1
    return { data: mem, result: undefined as void }
  }).catch(() => {})
}

/** 话题权重表(legacy,只读):正信号(收藏×2/手动重放/看完×0.3/显式赞×1)与负信号
 *  (跳过×1.5/显式踩×1.5)合成。动态话题系统的评分把它并入 relevance 作为历史口味;
 *  新反馈不再写 topicStats(改走 TopicDirector.record → episodeSignals) */
export async function getTopicWeights(): Promise<Record<string, number>> {
  const mem = await getMemory()
  const out: Record<string, number> = {}
  for (const [seed, s] of Object.entries(mem.topicStats)) {
    out[seed] =
      1 + s.favored * 2 + s.replays + s.watched * 0.3 + (s.liked ?? 0) - (s.disliked ?? 0) * 1.5 - s.skipped * 1.5
  }
  return out
}

/** 口味摘要:取 favored+replays 最高的话题名,顿号连接(最多 n 个) */
export async function tasteSummary(n = 3): Promise<string> {
  const mem = await getMemory()
  return Object.entries(mem.topicStats)
    .sort((a, b) => b[1].favored * 2 + b[1].replays - (a[1].favored * 2 + a[1].replays))
    .filter(([, s]) => s.favored + s.replays > 0)
    .slice(0, n)
    .map(([seed]) => seed)
    .join('、')
}
