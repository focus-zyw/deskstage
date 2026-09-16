// Warm 上下文持久层:data/warm.json。两层结构(Pi compaction 的 checkpoint 语义):
// - 滚动层 WarmSession:当前会话的增量摘要链——每次压缩把"上次摘要 + 新出窗消息"
//   合并重写 rollingSummary,自身即累进器;foldedTurnIds 记已折叠的消息(防重复压缩)。
// - 冻结层 WarmEpisode:会话闭合(间隔超阈值)时把滚动摘要定稿为一条集摘要。
// 原始对话正文永远只活在 chatlog.jsonl——这里只存摘要,压缩只改"注入视图"不删历史。
// 遗忘纪律:集摘要 14 天过期即删、容量 30 LRU;restricted 内容不入此层(摘要含敏感
// 直接丢弃——已晋级到记忆系统的事实不受影响)。写入走 withFileLock;浏览器预览降级
// localStorage,与 configStore 同一套约定。
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'
import type { MemorySensitivity } from './memoryPolicy'

export interface WarmSession {
  id: string
  startedTs: number
  lastActiveTs: number
  /** 增量滚动摘要(目标 ≤150 字):每次压缩覆盖重写,携上一次摘要进模型(Pi previousSummary) */
  rollingSummary: string
  /** 本会话摘要覆盖的消息 id:集摘要的溯源清单(冻结时带进 WarmEpisode.sourceIds) */
  foldedTurnIds: string[]
}

export interface WarmEpisode {
  id: string
  fromTs: number
  toTs: number
  summary: string
  topic?: string
  sourceIds: string[]
  sensitivity: MemorySensitivity
}

export interface WarmData {
  version: 1
  current: WarmSession | null
  episodes: WarmEpisode[]
  /** 全局折叠账本(跨会话/跨重启):已折叠进某份摘要或被放弃的消息 id。
   *  与会话解耦是关键——会话冻结清零后,新会话不得把旧消息再折一遍 */
  foldedTurnIds: string[]
}

/** 集摘要容量(LRU,超出丢最旧)与保留期(过期即删=遗忘) */
export const EPISODE_CAP = 30
export const EPISODE_TTL_MS = 14 * 24 * 60 * 60 * 1000

const LS_KEY = 'vc-warm'
const FILE_NAME = 'warm.json'
const MAX_SUMMARY_CHARS = 600
const MAX_FOLDED_IDS = 500

let cache: WarmData | null = null

function genWarmId(): string {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeSession(raw: unknown): WarmSession | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const startedTs = typeof o.startedTs === 'number' && o.startedTs > 0 ? o.startedTs : 0
  const lastActiveTs = typeof o.lastActiveTs === 'number' && o.lastActiveTs > 0 ? o.lastActiveTs : startedTs
  const summary = typeof o.rollingSummary === 'string' ? o.rollingSummary.slice(0, MAX_SUMMARY_CHARS) : ''
  const ids = Array.isArray(o.foldedTurnIds)
    ? [...new Set(o.foldedTurnIds.filter((v): v is string => typeof v === 'string' && v.length > 0))].slice(-MAX_FOLDED_IDS)
    : []
  if (!startedTs) return null
  return { id: typeof o.id === 'string' && o.id ? o.id : genWarmId(), startedTs, lastActiveTs, rollingSummary: summary, foldedTurnIds: ids }
}

function sanitizeEpisode(raw: unknown): WarmEpisode | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const fromTs = typeof o.fromTs === 'number' ? o.fromTs : 0
  const toTs = typeof o.toTs === 'number' ? o.toTs : 0
  const summary = typeof o.summary === 'string' ? o.summary.trim().slice(0, MAX_SUMMARY_CHARS) : ''
  const ids = Array.isArray(o.sourceIds)
    ? [...new Set(o.sourceIds.filter((v): v is string => typeof v === 'string' && v.length > 0))].slice(-MAX_FOLDED_IDS)
    : []
  if (!fromTs || !toTs || !summary) return null
  return {
    id: typeof o.id === 'string' && o.id ? o.id : genWarmId(),
    fromTs,
    toTs,
    summary,
    ...(typeof o.topic === 'string' && o.topic.trim() ? { topic: o.topic.trim().slice(0, 40) } : {}),
    sourceIds: ids,
    sensitivity: o.sensitivity === 'restricted' || o.sensitivity === 'private' ? o.sensitivity : 'normal',
  }
}

/** 幂等清洗:坏档/旧档/半截档一律归一成合法 WarmData(测试与读档共用) */
export function sanitizeWarmData(raw: unknown): WarmData {
  const o = (raw ?? {}) as Record<string, unknown>
  const episodes = Array.isArray(o.episodes)
    ? o.episodes
        .map(sanitizeEpisode)
        .filter((e): e is WarmEpisode => e !== null && e.sensitivity !== 'restricted')
    : []
  const folded = Array.isArray(o.foldedTurnIds)
    ? [...new Set(o.foldedTurnIds.filter((v): v is string => typeof v === 'string' && v.length > 0))].slice(-MAX_FOLDED_IDS)
    : []
  return {
    version: 1,
    current: sanitizeSession(o.current),
    episodes,
    foldedTurnIds: folded,
  }
}

/** 过期即删 + 容量 LRU(保留最近 EPISODE_CAP 条)。纯函数,读侧与写侧共用 */
export function pruneEpisodes(list: WarmEpisode[], now: number): WarmEpisode[] {
  const fresh = list.filter((e) => now - e.toTs < EPISODE_TTL_MS)
  return fresh.length > EPISODE_CAP ? fresh.slice(-EPISODE_CAP) : fresh
}

function emptyData(): WarmData {
  return { version: 1, current: null, episodes: [], foldedTurnIds: [] }
}

async function readFile(): Promise<WarmData> {
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitizeWarmData(JSON.parse(raw))
    } catch {
      // 坏数据按空档处理
    }
    return emptyData()
  }
  try {
    const base = await appDataDir()
    const file = await join(base, 'data', FILE_NAME)
    if (await exists(file)) {
      return sanitizeWarmData(JSON.parse(await readTextFile(file)))
    }
  } catch (e) {
    console.warn('Warm 上下文读取失败(按空档处理)', e)
  }
  return emptyData()
}

async function writeFile(data: WarmData): Promise<void> {
  cache = data
  if (!inTauri) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data))
    } catch {
      /* ignore */
    }
    return
  }
  try {
    const base = await appDataDir()
    const dir = await join(base, 'data')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    await writeTextFile(await join(dir, FILE_NAME), JSON.stringify(data, null, 2))
  } catch (e) {
    console.warn('Warm 上下文落盘失败(静默)', e)
  }
}

/** 启动预载(可选):首个读写会自取,无需强制 */
export async function ensureWarmLoaded(): Promise<void> {
  if (!cache) cache = await readFile()
}

/** 读全档:读侧先做过期裁剪(不回写,随下次写入自然落盘,与 mood 惰性衰减同策略) */
export async function getWarmData(): Promise<WarmData> {
  if (!cache) cache = await readFile()
  return { ...cache, episodes: pruneEpisodes(cache.episodes, Date.now()) }
}

/** 当前滚动会话(裁剪后视图) */
export async function currentSession(): Promise<WarmSession | null> {
  return (await getWarmData()).current
}

/** 冻结后的集摘要(裁剪后视图) */
export async function listEpisodes(): Promise<WarmEpisode[]> {
  return (await getWarmData()).episodes
}

/** 取当前会话,无则新建(会话开启) */
export async function ensureSession(now: number): Promise<WarmSession> {
  await withFileLock('warm', async () => {
    if (!cache) cache = await readFile()
    if (cache.current) return
    cache = {
      ...cache,
      current: {
        id: genWarmId(),
        startedTs: now,
        lastActiveTs: now,
        rollingSummary: '',
        foldedTurnIds: [],
      },
    }
    await writeFile(cache)
  })
  return cache!.current!
}

/** 保存滚动会话(压缩结果:覆盖摘要 + 追加折叠 id + 推进活跃时间) */
export async function saveCurrentSession(session: WarmSession): Promise<void> {
  await withFileLock('warm', async () => {
    if (!cache) cache = await readFile()
    await writeFile({ ...cache, current: session })
  })
}

/** 全局折叠账本追加(跨会话持久):这些消息不再参与任何后续压缩判定 */
export async function markTurnsFolded(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await withFileLock('warm', async () => {
    if (!cache) cache = await readFile()
    const merged = [...new Set([...cache.foldedTurnIds, ...ids])].slice(-MAX_FOLDED_IDS)
    if (merged.length === cache.foldedTurnIds.length) return
    await writeFile({ ...cache, foldedTurnIds: merged })
  })
}

/** 会话闭合:滚动摘要定稿为集摘要。restricted 敏感度的摘要整条丢弃(遗忘),
 *  但 current 照样清零——会话已经结束,残留只会污染下一次冻结。
 *  返回定稿的集摘要;无可冻结或被丢弃时返回 null */
export async function freezeCurrentSession(
  toTs: number,
  sensitivity: MemorySensitivity,
  topic?: string,
): Promise<WarmEpisode | null> {
  let frozen: WarmEpisode | null = null
  await withFileLock('warm', async () => {
    if (!cache) cache = await readFile()
    const cur = cache.current
    if (!cur) return
    const next: WarmData = { ...cache, current: null }
    if (sensitivity !== 'restricted' && cur.rollingSummary.trim()) {
      frozen = {
        id: genWarmId(),
        fromTs: cur.startedTs,
        toTs,
        summary: cur.rollingSummary,
        ...(topic ? { topic } : {}),
        sourceIds: [...cur.foldedTurnIds],
        sensitivity,
      }
      next.episodes = pruneEpisodes([...next.episodes, frozen], toTs)
    }
    await writeFile(next)
  })
  return frozen
}

/** 设置页复位:全清(事实骨干在 memory.json,不受影响) */
export async function resetWarm(): Promise<void> {
  await withFileLock('warm', async () => {
    await writeFile(emptyData())
  })
}
