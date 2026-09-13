// 使用者记忆:appData/data/memory.json。三块内容——
// facts[]:从聊天里自动提取的"关于观众的事实"(LLM 后台提取,本模块只管存取合并);
// topicStats:话题种子的 seen/favored/replays 计数,驱动 pickTopic 偏好加权;
// counters:戳/模式使用等行为计数。
// 全部写操作走 withFileLock;浏览器预览降级 localStorage。失败静默不影响演出。

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { notifyMainStoreChanged } from './crossWindow'
import { inTauri } from './configStore'

export type FactCategory = 'identity' | 'preference' | 'habit' | 'people' | 'event' | 'other'

export interface MemoryFact {
  id: string
  content: string
  category: FactCategory
  ts: number
  lastSeen: number
  hits: number
  pinned: boolean
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
  version: 1
  facts: MemoryFact[]
  topicStats: Record<string, TopicStat>
  counters: { pokes: number; modeUses: Record<string, number> }
}

const MAX_FACTS = 200
const LS_KEY = 'vc-memory'

const EMPTY: MemoryData = { version: 1, facts: [], topicStats: {}, counters: { pokes: 0, modeUses: {} } }

let cache: MemoryData | null = null

function clone(data: MemoryData): MemoryData {
  return JSON.parse(JSON.stringify(data)) as MemoryData
}

async function memoryFile(): Promise<string> {
  const base = await appDataDir()
  const dir = await join(base, 'data')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return join(dir, 'memory.json')
}

/** 清洗一条来自文件/LLM 的事实,非法返回 null */
function sanitizeFact(raw: unknown): MemoryFact | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const content = typeof o.content === 'string' ? o.content.trim().slice(0, 120) : ''
  if (!content) return null
  const cats: FactCategory[] = ['identity', 'preference', 'habit', 'people', 'event', 'other']
  const category = cats.includes(o.category as FactCategory) ? (o.category as FactCategory) : 'other'
  const now = Date.now()
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : `f${now}${Math.random().toString(36).slice(2, 8)}`,
    content,
    category,
    ts: Number(o.ts) || now,
    lastSeen: Number(o.lastSeen) || Number(o.ts) || now,
    hits: Math.max(0, Number(o.hits) || 0),
    pinned: o.pinned === true,
  }
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
    version: 1,
    facts: facts.slice(0, MAX_FACTS),
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
    const file = await memoryFile()
    if (await exists(file)) return sanitize(JSON.parse(await readTextFile(file)))
  } catch (e) {
    console.warn('记忆读取失败', e)
  }
  return clone(EMPTY)
}

/** 读全部记忆(内存缓存) */
export async function getMemory(): Promise<MemoryData> {
  if (!cache) cache = await loadRaw()
  return clone(cache)
}

/** 主窗侧刷新:设置窗改了记忆后经 store-changed 触发,丢弃缓存待下次读取 */
export function refreshMemoryFromDisk(): void {
  cache = null
}

/** 变更落盘(调用方已在锁内完成读改写计算) */
async function persist(next: MemoryData): Promise<void> {
  cache = next
  notifyMainStoreChanged('memory')
  if (!inTauri) {
    localStorage.setItem(LS_KEY, JSON.stringify(next))
    return
  }
  const file = await memoryFile()
  await writeTextFile(file, JSON.stringify(next, null, 2))
}

/** 淘汰排序:非置顶优先丢,lastSeen 旧者优先 */
function evict(facts: MemoryFact[]): MemoryFact[] {
  if (facts.length <= MAX_FACTS) return facts
  const overflow = facts.length - MAX_FACTS
  const droppable = facts
    .filter((f) => !f.pinned)
    .sort((a, b) => a.lastSeen - b.lastSeen || a.hits - b.hits)
    .slice(0, overflow)
    .map((f) => f.id)
  return facts.filter((f) => f.pinned || !droppable.includes(f.id))
}

/** 批量合并事实:内容完全一致视为同一条(刷新 lastSeen/hits),否则新增。返回新增/更新数 */
export async function mergeFacts(
  candidates: { content: string; category?: FactCategory }[],
): Promise<number> {
  if (candidates.length === 0) return 0
  return withFileLock('memory', async () => {
    const mem = await getMemory()
    const now = Date.now()
    let changed = 0
    for (const c of candidates) {
      const content = c.content.trim().slice(0, 120)
      if (!content) continue
      const existing = mem.facts.find((f) => f.content === content)
      if (existing) {
        existing.lastSeen = now
        existing.hits += 1
      } else {
        mem.facts.push({
          id: `f${now}${Math.random().toString(36).slice(2, 8)}`,
          content,
          category: c.category ?? 'other',
          ts: now,
          lastSeen: now,
          hits: 0,
          pinned: false,
        })
      }
      changed++
    }
    mem.facts = evict(mem.facts)
    await persist(mem)
    return changed
  })
}

export async function deleteFact(id: string): Promise<void> {
  await withFileLock('memory', async () => {
    const mem = await getMemory()
    mem.facts = mem.facts.filter((f) => f.id !== id)
    await persist(mem)
  })
}

export async function togglePinFact(id: string): Promise<void> {
  await withFileLock('memory', async () => {
    const mem = await getMemory()
    const f = mem.facts.find((x) => x.id === id)
    if (f) f.pinned = !f.pinned
    await persist(mem)
  })
}

/** 清空全部记忆(含话题统计与计数) */
export async function clearMemory(): Promise<void> {
  await withFileLock('memory', async () => {
    await persist(clone(EMPTY))
  })
}

/** 摘要 facts:pinned 优先,再按 lastSeen/hits 取前 n 条内容 */
export function topFacts(mem: MemoryData, n: number): string[] {
  return [...mem.facts]
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
  await withFileLock('memory', async () => {
    const mem = await getMemory()
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
    await persist(mem)
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
  void withFileLock('memory', async () => {
    const mem = await getMemory()
    mem.counters.pokes += 1
    await persist(mem)
  }).catch(() => {})
}

export function bumpMode(mode: string): void {
  void withFileLock('memory', async () => {
    const mem = await getMemory()
    mem.counters.modeUses[mode] = (mem.counters.modeUses[mode] ?? 0) + 1
    await persist(mem)
  }).catch(() => {})
}

/** 话题权重表:正信号(收藏×2/手动重放/看完×0.3/显式赞×1)与负信号(跳过×1.5/显式踩×1.5)
 *  合成,≤0 表示该主题已被负信号打穿,由 pickTopic 剔除出随机池 */
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
