// 话题状态持久化:data/topic-state.json。复用 memoryStore 的 CAS 通路——
// Tauri 走 Rust 状态中心(data_get_with_revision / data_set_if_revision,进程锁 +
// 原子写 + store-changed 双窗广播),浏览器预览与 Vite 测试降级 localStorage(单窗)。
// 同窗并发用 withFileLock('topic-state') 串行化,CAS 冲突取最新值重放 ≤3 次。
//
// 注意区分两种 revision:Rust 文件 revision(CAS 令牌,Rust 侧计数)与本文件的
// 话题域 revision(TopicStateV1.revision,只在 adopt() 推进,预生成缓存兼容性判断用)。
// 读模型(getTopicSnapshot/subscribeTopicState)是纯查询:开面板不耗随机数、不建预约。

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { withFileLock } from '../storage/writeLock'
import { inTauri } from '../storage/configStore'
import {
  TOPIC_CATEGORIES,
  TOPIC_SOURCES,
  type DiscoveryState,
  type EpisodeTopicSignal,
  type RecentTopic,
  type TopicCard,
  type TopicSnapshot,
  type TopicStateV1,
  type TopicSession,
} from './types'
import { fingerprintOf } from './planner'

export const STORE_NAME = 'topic-state'
const LS_KEY = 'vc-topic-state'
/** AI 候选仓上限(超出丢最旧/最先过期) */
export const MAX_RESERVOIR = 40
/** 最近话题条数(硬去重与 avoid 的窗口) */
export const MAX_RECENT = 20
/** 一集话题信号投影保留条数(按 updatedAt 淘汰最旧) */
export const MAX_EPISODE_SIGNALS = 500

const EMPTY_DISCOVERY: DiscoveryState = {
  lastAttemptAt: 0,
  consumedSinceRestock: 0,
  attemptDay: '',
  attemptCount: 0,
}

const EMPTY: TopicStateV1 = {
  version: 1,
  revision: 0,
  session: null,
  reservoir: [],
  recent: [],
  episodeSignals: {},
  discovery: { ...EMPTY_DISCOVERY },
}

export function defaultTopicState(): TopicStateV1 {
  return JSON.parse(JSON.stringify(EMPTY)) as TopicStateV1
}

let cache: TopicStateV1 | null = null
let snapshotCache: TopicSnapshot | null = null
const listeners = new Set<() => void>()

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

// ---------- sanitize(文件/广播/迁移来的形状一律先清洗) ----------

const str = (v: unknown, cap: number): string => (typeof v === 'string' ? v.trim().slice(0, cap) : '')

/** 话题卡清洗:字段缺失/越界钳制;指纹缺失时由标题重算。非法(无标题)返回 null */
export function sanitizeTopicCard(raw: unknown, now = Date.now()): TopicCard | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const title = str(o.title, 60)
  if (!title) return null
  const category = (TOPIC_CATEGORIES as readonly string[]).includes(o.category as string)
    ? (o.category as TopicCard['category'])
    : 'life'
  const source = (TOPIC_SOURCES as readonly string[]).includes(o.source as string)
    ? (o.source as TopicCard['source'])
    : 'curated'
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim().slice(0, 12)).slice(0, 5)
    : []
  const sensitivity =
    o.sensitivity === 'personal' || o.sensitivity === 'sensitive' ? o.sensitivity : 'normal'
  const fingerprint = str(o.fingerprint, 32) || fingerprintOf(title)
  const modeAffinity = Array.isArray(o.modeAffinity)
    ? o.modeAffinity.filter((m): m is string => typeof m === 'string').slice(0, 6)
    : undefined
  const card: TopicCard = {
    id: str(o.id, 40) || `tc-${fingerprint}`,
    title,
    hook: str(o.hook, 120) || title,
    category,
    tags,
    source,
    fingerprint,
    sensitivity,
    generatedAt: Number(o.generatedAt) || now,
  }
  if (modeAffinity && modeAffinity.length > 0) card.modeAffinity = modeAffinity
  if (typeof o.bridge === 'string' && o.bridge.trim()) card.bridge = o.bridge.trim().slice(0, 120)
  if (Number(o.expiresAt) > 0) card.expiresAt = Number(o.expiresAt)
  return card
}

function sanitizeSession(raw: unknown): TopicSession | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const rootCard = sanitizeTopicCard(o.rootCard)
  const currentCard = sanitizeTopicCard(o.currentCard) ?? rootCard
  if (!rootCard || !currentCard) return null
  const fps = Array.isArray(o.usedFingerprints)
    ? o.usedFingerprints.filter((f): f is string => typeof f === 'string').slice(-40)
    : []
  const angles = Array.isArray(o.usedAngles)
    ? o.usedAngles.filter((a): a is string => typeof a === 'string').slice(-40)
    : []
  const policy = o.policy === 'strict' ? 'strict' : 'guided'
  const duration = o.duration === 'until-cleared' ? 'until-cleared' : 'three-episodes'
  return {
    id: str(o.id, 40) || 'ts-unknown',
    rootCard,
    currentCard,
    policy,
    duration,
    remainingEpisodes:
      duration === 'until-cleared' ? null : Math.max(0, Math.min(3, Number(o.remainingEpisodes) || 0)),
    stage:
      o.stage === 'deepen' || o.stage === 'escalate' || o.stage === 'payoff' ? o.stage : 'open',
    usedFingerprints: fps,
    usedAngles: angles,
    revision: Math.max(0, Number(o.revision) || 0),
    createdAt: Number(o.createdAt) || Date.now(),
    updatedAt: Number(o.updatedAt) || Date.now(),
    ...(typeof o.migratedFromOverride === 'string' && o.migratedFromOverride
      ? { migratedFromOverride: o.migratedFromOverride.slice(0, 32) }
      : {}),
  }
}

function sanitizeRecent(raw: unknown): RecentTopic[] {
  if (!Array.isArray(raw)) return []
  const out: RecentTopic[] = []
  for (const it of raw.slice(-MAX_RECENT)) {
    const o = (it ?? {}) as Record<string, unknown>
    const title = str(o.title, 60)
    if (!title) continue
    out.push({
      fingerprint: str(o.fingerprint, 32) || fingerprintOf(title),
      title,
      category: (TOPIC_CATEGORIES as readonly string[]).includes(o.category as string)
        ? (o.category as RecentTopic['category'])
        : 'life',
      source: (TOPIC_SOURCES as readonly string[]).includes(o.source as string)
        ? (o.source as RecentTopic['source'])
        : 'curated',
      ts: Number(o.ts) || 0,
    })
  }
  return out.slice(-MAX_RECENT)
}

function sanitizeSignals(raw: unknown): Record<string, EpisodeTopicSignal> {
  if (!raw || typeof raw !== 'object') return {}
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([eid, v]) => {
      const o = (v ?? {}) as Record<string, unknown>
      const signal: EpisodeTopicSignal = {
        fingerprint: str(o.fingerprint, 32),
        category: (TOPIC_CATEGORIES as readonly string[]).includes(o.category as string)
          ? (o.category as EpisodeTopicSignal['category'])
          : 'life',
        source: (TOPIC_SOURCES as readonly string[]).includes(o.source as string)
          ? (o.source as EpisodeTopicSignal['source'])
          : 'curated',
        started: o.started === true,
        completed: o.completed === true,
        ...(Number.isFinite(Number(o.skippedProgress)) ? { skippedProgress: Number(o.skippedProgress) } : {}),
        rating: o.rating === 'up' || o.rating === 'down' ? o.rating : null,
        favored: o.favored === true,
        updatedAt: Number(o.updatedAt) || 0,
      }
      return [eid.slice(0, 40), signal] as const
    })
    // eid 形如 ep-时间戳-随机,字符串序 ≈ 时间序;保尾500(最新)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-MAX_EPISODE_SIGNALS)
  return Object.fromEntries(entries)
}

function sanitizeDiscovery(raw: unknown): DiscoveryState {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    lastAttemptAt: Math.max(0, Number(o.lastAttemptAt) || 0),
    consumedSinceRestock: Math.max(0, Number(o.consumedSinceRestock) || 0),
    attemptDay: str(o.attemptDay, 10),
    attemptCount: Math.max(0, Number(o.attemptCount) || 0),
  }
}

export function sanitizeTopicState(raw: unknown): TopicStateV1 {
  const o = (raw ?? {}) as Record<string, unknown>
  const reservoir = Array.isArray(o.reservoir)
    ? o.reservoir
        .map((c) => sanitizeTopicCard(c))
        .filter((c): c is TopicCard => c !== null)
        .slice(-MAX_RESERVOIR)
    : []
  return {
    version: 1,
    revision: Math.max(0, Number(o.revision) || 0),
    session: sanitizeSession(o.session),
    reservoir,
    recent: sanitizeRecent(o.recent),
    episodeSignals: sanitizeSignals(o.episodeSignals),
    discovery: sanitizeDiscovery(o.discovery),
  }
}

// ---------- 读取 / CAS 变更 / 双窗同步 ----------

async function loadRaw(): Promise<TopicStateV1> {
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitizeTopicState(JSON.parse(raw))
    } catch (e) {
      console.warn('浏览器话题状态读取失败', e)
    }
    return clone(EMPTY)
  }
  try {
    const res = await invoke<{ revision: number; value: unknown }>('data_get_with_revision', {
      store: STORE_NAME,
    })
    return sanitizeTopicState(res.value)
  } catch (e) {
    console.warn('话题状态读取失败', e)
  }
  return clone(EMPTY)
}

/** 读全部话题状态(内存缓存;store-changed 广播保持两窗一致) */
export async function getTopicState(): Promise<TopicStateV1> {
  if (!cache) cache = await loadRaw()
  return clone(cache)
}

/** 同步读缓存(未预热返回 null)。读模型/热路径用,不触发磁盘 IO */
export function peekTopicState(): TopicStateV1 | null {
  return cache ? clone(cache) : null
}

/** 启动预热:提前把 topic-state 拉进内存,点播热路径不等待磁盘 */
export async function warmTopicState(): Promise<void> {
  if (!cache) cache = await loadRaw()
}

function commit(next: TopicStateV1): void {
  cache = next
  snapshotCache = null
  for (const l of listeners) {
    try {
      l()
    } catch {
      // 快照订阅方异常不扩散到写路径
    }
  }
}

/**
 * CAS 变更循环:读(带 Rust revision)→ 应用纯 mutation → 条件提交。
 * conflict = 另一窗先写了:采纳返回的最新值重放本 mutation(≤3 次)。
 * 注意:mutation 拿到的是全新深拷贝,直接改它并在返回值里给出即可。
 */
export async function mutateTopicState<T>(
  fn: (state: TopicStateV1) => { state: TopicStateV1; result: T },
): Promise<T> {
  return withFileLock(STORE_NAME, async () => {
    if (!inTauri) {
      const cur = cache ?? (await loadRaw())
      const { state, result } = fn(clone(cur))
      const clean = sanitizeTopicState(state)
      commit(clean)
      localStorage.setItem(LS_KEY, JSON.stringify(clean))
      return result
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await invoke<{ revision: number; value: unknown }>('data_get_with_revision', {
        store: STORE_NAME,
      })
      const fresh = sanitizeTopicState(cur.value)
      commit(fresh)
      const { state, result } = fn(clone(fresh))
      const res = await invoke<{ status: 'ok' | 'conflict'; revision?: number; value?: unknown }>(
        'data_set_if_revision',
        { store: STORE_NAME, expectedRevision: cur.revision, value: sanitizeTopicState(state) },
      )
      if (res.status === 'ok') {
        commit(sanitizeTopicState(res.value))
        return result
      }
      // conflict:采纳最新值,下一圈重放 mutation
      commit(sanitizeTopicState(res.value))
    }
    throw new Error('话题状态写入冲突:连续 3 次版本过期')
  })
}

if (inTauri) {
  // Rust 广播:任一窗写了 topic-state,两窗缓存即时对齐(幂等采纳)
  void listen<{ store?: string; value?: unknown }>('store-changed', (e) => {
    if (e.payload?.store !== STORE_NAME || e.payload.value === undefined) return
    commit(sanitizeTopicState(e.payload.value))
  })
}

// ---------- 读模型(command/query 分离的 query 侧) ----------

function buildSnapshot(s: TopicStateV1): TopicSnapshot {
  return {
    revision: s.revision,
    session: s.session,
    currentTitle: s.session?.currentCard.title ?? s.recent[s.recent.length - 1]?.title ?? '',
    currentHook: s.session?.currentCard.hook ?? '',
    recent: s.recent,
    reservoirCount: s.reservoir.filter((c) => !c.expiresAt || c.expiresAt > Date.now()).length,
  }
}

/** 同步快照(useSyncExternalStore 的 getSnapshot;memoized,数据不变则同一对象) */
export function getTopicSnapshot(): TopicSnapshot {
  if (!snapshotCache) snapshotCache = buildSnapshot(cache ?? EMPTY)
  return snapshotCache
}

/** 订阅话题状态变化(本窗写入与跨窗广播都触发) */
export function subscribeTopicState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
