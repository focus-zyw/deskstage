// 使用者记忆库:appData/data/memory.json(v2)。三块内容——
// facts[]:从聊天里自动提取的"关于观众的事实",带完整元数据(confidence/volatility/
//   sensitivity/slot/来源 evidence/状态机,语义决策在 memoryPolicy);
// rules[]:禁止自动保存规则(结构化 scope:slot/category/sensitivity/phrase);
// topicStats/counters:话题种子计数与行为计数(与 facts 共库但语义独立)。
// 读写统一走 Rust 状态中心;**变更走 mutateMemory CAS 循环**(读 revision→应用纯
// mutation→data_set_if_revision 条件提交,conflict 则取最新值重放)——双窗并发
// (主窗后台提取 × 设置窗编辑)靠 revision 对比不丢更新,进程锁只串行化判定本身。
// 浏览器预览降级 localStorage(单窗,无 CAS 语义)。失败静默不影响演出。

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'
import {
  detectSensitivity,
  maxSensitivity,
  queryMemory,
  relevance,
  ruleMatches,
  classifyIncoming,
  defaultVolatility,
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

/** 来源证据种类(封闭白名单);evidence[0]=首次来源,末条=最近更新 */
export type MemoryEvidenceKind = 'extracted' | 'user-edited' | 'user-confirmed' | 'legacy'

export interface MemoryEvidence {
  turnId: string | null
  excerpt: string
  at: number
  kind: MemoryEvidenceKind
}

export interface MemoryFact {
  id: string
  content: string
  category: FactCategory
  /** 受控语义槽位(白名单见 memorySlots);冲突替代只在同 slot 间成立 */
  slot?: MemorySlot
  value?: string
  /** 提取可靠性 0~1:系统是否正确理解了用户原话(时间衰减不看它,看 confirmWindow) */
  confidence: number
  volatility: MemoryVolatility
  sensitivity: MemorySensitivity
  /** 持久化仅两态;needs_confirmation 由 policy 按 status+时间戳动态派生,不落盘 */
  status: 'active' | 'superseded'
  sourceTurnId: string | null
  sourceExcerpt: string
  createdAt: number
  lastSeen: number
  /** 最近一次被用户确认(编辑/明确重申/手动确认);机器提取命中不算。null=从未确认 */
  lastConfirmedAt: number | null
  pinned: boolean
  hits: number
  evidence: MemoryEvidence[]
}

export interface MemoryRule {
  id: string
  scope: 'slot' | 'category' | 'sensitivity' | 'phrase'
  value: string
  createdAt: number
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

export interface MemoryData {
  version: 2
  facts: MemoryFact[]
  rules: MemoryRule[]
  topicStats: Record<string, TopicStat>
  counters: { pokes: number; modeUses: Record<string, number> }
}

const MAX_FACTS = 200
const MAX_EVIDENCE = 4
/** pinned 软上限:不强制淘汰,超出时 UI 提示 */
export const MAX_PINNED_SOFT = 30
const LS_KEY = 'vc-memory'

const EMPTY: MemoryData = { version: 2, facts: [], rules: [], topicStats: {}, counters: { pokes: 0, modeUses: {} } }

let cache: MemoryData | null = null

function clone(data: MemoryData): MemoryData {
  return JSON.parse(JSON.stringify(data)) as MemoryData
}

function sanitizeEvidence(raw: unknown, createdAt: number, legacyTurnId: string | null, legacyExcerpt: string): MemoryEvidence[] {
  const kinds: MemoryEvidenceKind[] = ['extracted', 'user-edited', 'user-confirmed', 'legacy']
  if (Array.isArray(raw)) {
    const list = raw
      .slice(0, MAX_EVIDENCE)
      .map((e) => {
        const o = (e ?? {}) as Record<string, unknown>
        const kind = kinds.includes(o.kind as MemoryEvidenceKind) ? (o.kind as MemoryEvidenceKind) : 'legacy'
        return {
          turnId: typeof o.turnId === 'string' ? o.turnId.slice(0, 64) : null,
          excerpt: typeof o.excerpt === 'string' ? o.excerpt.slice(0, 120) : '',
          at: Number(o.at) || createdAt,
          kind,
        }
      })
    if (list.length > 0) return list
  }
  return [{ turnId: legacyTurnId, excerpt: legacyExcerpt.slice(0, 120), at: createdAt, kind: 'legacy' }]
}

/** 清洗一条来自文件/迁移的事实(v1 旧形状按 ts 识别并迁 v2),非法返回 null */
export function sanitizeFact(raw: unknown): MemoryFact | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const content = typeof o.content === 'string' ? o.content.trim().slice(0, 120) : ''
  if (!content) return null
  const cats: FactCategory[] = ['identity', 'preference', 'habit', 'people', 'event', 'other']
  const category = cats.includes(o.category as FactCategory) ? (o.category as FactCategory) : 'other'
  const now = Date.now()
  const slot = isMemorySlot(o.slot) ? o.slot : undefined
  const value = slot && typeof o.value === 'string' ? normalizeSlotValue(slot, o.value) : undefined
  const createdAt = Number(o.createdAt ?? o.ts) || now
  const modelSensitivity: MemorySensitivity | undefined =
    o.sensitivity === 'private' || o.sensitivity === 'restricted' || o.sensitivity === 'normal'
      ? o.sensitivity
      : undefined
  // 敏感度三源取严:模型标注 ∨ 确定性检测 ∨ slot 注册表
  const sensitivity = maxSensitivity(
    modelSensitivity,
    detectSensitivity(content),
    slot ? SLOT_POLICY[slot].sensitivity : undefined,
  )
  const volatility: MemoryVolatility =
    o.volatility === 'stable' || o.volatility === 'historical' || o.volatility === 'changeable'
      ? o.volatility
      : slot
        ? SLOT_POLICY[slot].volatility
        : defaultVolatility(category)
  const legacyTurnId = typeof o.sourceTurnId === 'string' ? o.sourceTurnId.slice(0, 64) : null
  const legacyExcerpt = typeof o.sourceExcerpt === 'string' ? o.sourceExcerpt : ''
  const lastConfirmedAt = o.lastConfirmedAt === null ? null : Number(o.lastConfirmedAt) || null
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : `f${now}${Math.random().toString(36).slice(2, 8)}`,
    content,
    category,
    slot,
    value,
    confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0.6)),
    volatility,
    sensitivity,
    status: o.status === 'superseded' ? 'superseded' : 'active',
    sourceTurnId: legacyTurnId,
    sourceExcerpt: legacyExcerpt.slice(0, 120),
    createdAt,
    lastSeen: Number(o.lastSeen) || createdAt,
    lastConfirmedAt,
    pinned: o.pinned === true,
    hits: Math.max(0, Number(o.hits) || 0),
    evidence: sanitizeEvidence(o.evidence, createdAt, legacyTurnId, legacyExcerpt),
  }
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
        id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
        scope,
        value,
        createdAt: Number(o.createdAt) || Date.now(),
      }
    })
    .filter((r): r is MemoryRule => r !== null)
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
  return {
    version: 2,
    facts: facts.slice(0, MAX_FACTS),
    rules: sanitizeRules(o.rules),
    topicStats,
    counters: { pokes: Math.max(0, Number(counters.pokes) || 0), modeUses },
  }
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

/** 淘汰:超 200 条时按 superseded(保留最近 5 条历史)→ 非固定低置信最旧 → 固定最旧
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
        (a, b) => Number(a.pinned) - Number(b.pinned) || a.confidence - b.confidence || a.lastSeen - b.lastSeen,
      ),
  ]
  const drop = new Set<string>()
  for (const f of dropOrder) {
    if (drop.size >= overflow) break
    drop.add(f.id)
  }
  return facts.filter((f) => !drop.has(f.id))
}

// ---------- 变更 API(全部经 mutateMemory) ----------

export interface FactCandidate {
  content: string
  category?: FactCategory
  slot?: string
  value?: string
  volatility?: MemoryVolatility
  sensitivity?: MemorySensitivity
  /** 来源用户轮 id(贯穿 chatLog/提取);null = 无稳定来源 */
  turnId?: string | null
  /** 用户原句摘录(来源证据) */
  excerpt?: string
}

function pushEvidence(fact: MemoryFact, ev: MemoryEvidence): void {
  fact.evidence = [...fact.evidence, ev].slice(-MAX_EVIDENCE)
  if (fact.evidence[0] && fact.evidence.length >= MAX_EVIDENCE && fact.evidence[0].kind !== 'legacy') {
    // 保留首次来源:第二条起才允许被挤掉——首条换到前面保住
    const [origin, ...rest] = fact.evidence
    fact.evidence = [origin, ...rest.slice(0, MAX_EVIDENCE - 1)]
  }
}

/** 批量合并提取候选:规则闸 → 近似/槽位去重 → slot 冲突替代 → 新建。
 *  命中规则的候选直接丢弃(第二道闸,第一道在提取 prompt)。
 *  返回写入摘要(诊断用:id 级决策,正文永不回传) */
export interface MergeFactsSummary {
  changed: number
  /** 新建条目的 id */
  addedIds: string[]
  /** 被 slot 冲突替代的旧条目 id */
  supersededIds: string[]
  /** 被规则闸/空内容拒绝的候选数 */
  rejected: number
}

export async function mergeFacts(candidates: FactCandidate[]): Promise<MergeFactsSummary> {
  if (candidates.length === 0) return { changed: 0, addedIds: [], supersededIds: [], rejected: 0 }
  return mutateMemory((mem) => {
    const now = Date.now()
    let changed = 0
    let rejected = 0
    const addedIds: string[] = []
    const supersededIds: string[] = []
    for (const c of candidates) {
      const content = c.content.trim().slice(0, 120)
      if (!content) {
        rejected++
        continue
      }
      const slot = isMemorySlot(c.slot) ? c.slot : undefined
      const value = slot && c.value ? normalizeSlotValue(slot, c.value) : undefined
      const sensitivity = maxSensitivity(
        c.sensitivity,
        detectSensitivity(content),
        slot ? SLOT_POLICY[slot].sensitivity : undefined,
      )
      const volatility: MemoryVolatility =
        c.volatility ?? (slot ? SLOT_POLICY[slot].volatility : defaultVolatility(c.category ?? 'other'))
      // 规则闸:命中禁止规则的内容永不入库
      if (mem.rules.some((r) => ruleMatches({ content, slot, category: c.category ?? 'other', sensitivity }, r))) {
        rejected++
        continue
      }
      // 定位既有条目:优先同 slot 同值,其次精确同文,最后 2-gram 近似(≥0.85 双向)
      let existing = slot
        ? mem.facts.find((f) => f.status === 'active' && f.slot === slot && f.value === value && f.slot !== undefined)
        : undefined
      existing =
        existing ??
        mem.facts.find((f) => f.status === 'active' && f.content === content) ??
        mem.facts.find(
          (f) =>
            f.status === 'active' &&
            f.slot === undefined &&
            Math.min(relevance(f.content, content), relevance(content, f.content)) >= 0.85,
        )
      if (existing) {
        // slot 重申:同 slot 同值且来自新的用户轮 → 视为用户再次确认
        const verdict = slot ? classifyIncoming(existing, { slot, value, turnId: c.turnId ?? null }) : 'none'
        existing.lastSeen = now
        existing.hits += 1
        existing.confidence = Math.min(0.9, existing.confidence + 0.05)
        if (verdict === 'reaffirm') {
          existing.lastConfirmedAt = now
        } else if (verdict === 'supersede') {
          existing.status = 'superseded'
          supersededIds.push(existing.id)
          const fresh = newFact({ ...c, content, category: c.category ?? existing.category, slot, value, sensitivity, volatility }, now)
          mem.facts.push(fresh)
          addedIds.push(fresh.id)
        } else {
          pushEvidence(existing, {
            turnId: c.turnId ?? null,
            excerpt: (c.excerpt ?? '').slice(0, 120),
            at: now,
            kind: 'extracted',
          })
        }
        changed++
        continue
      }
      const fresh = newFact({ ...c, content, category: c.category ?? 'other', slot, value, sensitivity, volatility }, now)
      mem.facts.push(fresh)
      addedIds.push(fresh.id)
      changed++
    }
    mem.facts = evict(mem.facts)
    return { data: mem, result: { changed, addedIds, supersededIds, rejected } }
  })

  function newFact(
    c: FactCandidate & { category: FactCategory; slot?: MemorySlot; value?: string; sensitivity: MemorySensitivity; volatility: MemoryVolatility },
    now: number,
  ): MemoryFact {
    return {
      id: `f${now}${Math.random().toString(36).slice(2, 8)}`,
      content: c.content,
      category: c.category,
      slot: c.slot,
      value: c.value,
      confidence: 0.7,
      volatility: c.volatility,
      sensitivity: c.sensitivity,
      status: 'active',
      sourceTurnId: c.turnId ?? null,
      sourceExcerpt: (c.excerpt ?? '').slice(0, 120),
      createdAt: now,
      lastSeen: now,
      lastConfirmedAt: null,
      pinned: false,
      hits: 0,
      evidence: [
        { turnId: c.turnId ?? null, excerpt: (c.excerpt ?? '').slice(0, 120), at: now, kind: 'extracted' },
      ],
    }
  }
}

export async function deleteFact(id: string): Promise<void> {
  await mutateMemory((mem) => {
    mem.facts = mem.facts.filter((f) => f.id !== id)
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

/** 用户编辑内容 = 明确确认:confidence 1、lastConfirmedAt=now、evidence 记 user-edited */
export async function editFact(id: string, content: string): Promise<void> {
  const text = content.trim().slice(0, 120)
  if (!text) return
  await mutateMemory((mem) => {
    const f = mem.facts.find((x) => x.id === id)
    if (!f) return { data: mem, result: undefined as void }
    const now = Date.now()
    f.content = text
    f.confidence = 1
    f.lastConfirmedAt = now
    pushEvidence(f, { turnId: null, excerpt: text.slice(0, 120), at: now, kind: 'user-edited' })
    f.sensitivity = maxSensitivity(f.sensitivity, detectSensitivity(text), f.slot ? SLOT_POLICY[f.slot].sensitivity : undefined)
    return { data: mem, result: undefined as void }
  })
}

/** 手动"仍然有效":只更新 lastConfirmedAt(status 不动——needs_confirmation 是派生态) */
export async function confirmFact(id: string): Promise<void> {
  await mutateMemory((mem) => {
    const f = mem.facts.find((x) => x.id === id)
    if (!f) return { data: mem, result: undefined as void }
    const now = Date.now()
    f.lastConfirmedAt = now
    pushEvidence(f, { turnId: null, excerpt: '', at: now, kind: 'user-confirmed' })
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
      id: `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
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

/** 清空自动记忆:只清 facts,保留禁止规则/话题统计/画像——"删干净"不等于解除隐私偏好 */
export async function clearAutoMemory(): Promise<void> {
  await mutateMemory((mem) => {
    mem.facts = []
    return { data: mem, result: undefined as void }
  })
}

/** 重置整个记忆系统:facts+rules+topicStats+counters 全清(二次确认入口) */
export async function resetAllMemory(): Promise<void> {
  await mutateMemory((mem) => {
    mem.facts = []
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

/** 导出记忆数据(显式动作;不含凭据,含 facts/rules/统计) */
export async function exportMemory(): Promise<string> {
  const mem = await getMemory()
  return JSON.stringify(mem, null, 2)
}

/** 摘要 facts:pinned 优先,再按 lastSeen/hits 取前 n 条内容(遗留接口;策略检索见 memoryPolicy) */
export function topFacts(mem: MemoryData, n: number): string[] {
  return [...mem.facts]
    .filter((f) => f.status === 'active')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastSeen - a.lastSeen || b.hits - a.hits)
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
