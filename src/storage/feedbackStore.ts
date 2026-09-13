// 演出评价持久化:data/feedback.json。按 eid 记录观众对一集对话的显式评价(赞/踩)。
// 与 history/*.jsonl 分开:历史是只追加的原始台词,评价是后到的可变状态(改评/撤销都要写)。
// 与 mood.json 同一套约定:写入走 withFileLock;浏览器预览降级 localStorage;
// 上限 MAX_ENTRIES,超出按 ratedAt 淘汰最旧。失败静默不影响演出。

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'

export type Rating = 'up' | 'down'

export interface FeedbackEntry {
  rating: Rating
  /** 集的对话时间(评价时近似取当下,与 history 行 ts 无需严格对齐) */
  ts: number
  mode: string
  topic?: string
  /** 最近一次评价时间(改评/撤销刷新,淘汰排序用) */
  ratedAt: number
}

export type FeedbackTable = Record<string, FeedbackEntry>

const LS_KEY = 'vc-feedback'
const FILE_NAME = 'feedback.json'
const VERSION = 1
const MAX_ENTRIES = 500

let cache: FeedbackTable | null = null

const shape = (table: FeedbackTable) => ({ version: VERSION, table })

function sanitizeTable(raw: unknown): FeedbackTable {
  const out: FeedbackTable = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [eid, v] of Object.entries(raw as Record<string, unknown>)) {
    const o = (v ?? {}) as Record<string, unknown>
    if (o.rating !== 'up' && o.rating !== 'down') continue
    out[eid.slice(0, 48)] = {
      rating: o.rating,
      ts: Number(o.ts) || 0,
      mode: String(o.mode || 'daily'),
      topic: typeof o.topic === 'string' && o.topic ? o.topic : undefined,
      ratedAt: Number(o.ratedAt) || Date.now(),
    }
  }
  return out
}

/** 超上限裁掉最旧(按 ratedAt);纯函数,单测覆盖 */
export function trimTable(table: FeedbackTable, max = MAX_ENTRIES): FeedbackTable {
  const entries = Object.entries(table)
  if (entries.length <= max) return table
  return Object.fromEntries(entries.sort((a, b) => a[1].ratedAt - b[1].ratedAt).slice(-max))
}

async function readFile(): Promise<FeedbackTable> {
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitizeTable((JSON.parse(raw) as { table?: unknown }).table)
    } catch {
      // 坏数据按空表处理
    }
    return {}
  }
  try {
    const base = await appDataDir()
    const file = await join(base, 'data', FILE_NAME)
    if (await exists(file)) {
      return sanitizeTable((JSON.parse(await readTextFile(file)) as { table?: unknown }).table)
    }
  } catch (e) {
    console.warn('演出评价读取失败(按空表处理)', e)
  }
  return {}
}

async function writeFile(table: FeedbackTable): Promise<void> {
  cache = table
  if (!inTauri) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(shape(table)))
    } catch {
      /* ignore */
    }
    return
  }
  try {
    const base = await appDataDir()
    const dir = await join(base, 'data')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    await writeTextFile(await join(dir, FILE_NAME), JSON.stringify(shape(table), null, 2))
  } catch (e) {
    console.warn('演出评价落盘失败(静默)', e)
  }
}

/** 读单集评价;未评过返回 null */
export async function getEpisodeRating(eid: string): Promise<Rating | null> {
  if (!cache) cache = await readFile()
  return cache[eid]?.rating ?? null
}

/** 读全部评价(历史页按 eid 贴标签用) */
export async function getRatings(): Promise<FeedbackTable> {
  if (!cache) cache = await readFile()
  return cache
}

/** 评价一集并同步口味权重(赞→liked+1/踩→disliked+1);改评/撤销传新值或 null,
 *  旧信号自动 -1 回退,权重可逆。内部先落盘拿到评价前的值,再做 ± 记账 */
export async function rateEpisode(
  eid: string,
  meta: { ts: number; mode: string; topic?: string },
  rating: Rating | null,
): Promise<void> {
  const prev = await withFileLock('feedback', async (): Promise<Rating | null> => {
    if (!cache) cache = await readFile()
    const prev: Rating | null = cache[eid]?.rating ?? null
    if (prev === rating) return prev
    const next = { ...cache }
    if (rating) {
      next[eid] = { rating, ts: meta.ts, mode: meta.mode, topic: meta.topic, ratedAt: Date.now() }
    } else {
      delete next[eid]
    }
    await writeFile(trimTable(next))
    return prev
  })
  if (prev === rating) return
  // 口味记账已收口到 TopicDirector.record(rating-changed 事件),此处只管 feedback.json
}

/** 删除集时联动清理评价(旧数据无 eid 的集本来就没有评价) */
export async function removeRatings(eids: Iterable<string | undefined>): Promise<void> {
  const ids = [...eids].filter((x): x is string => typeof x === 'string' && x.length > 0)
  if (ids.length === 0) return
  await withFileLock('feedback', async () => {
    if (!cache) cache = await readFile()
    const next = { ...cache }
    let changed = false
    for (const id of ids) {
      if (id in next) {
        delete next[id]
        changed = true
      }
    }
    if (changed) await writeFile(next)
  })
}
