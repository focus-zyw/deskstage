// 招牌怪癖·存储与配额规则(设计方案 §2/§3)。
// 持久化 data/quirks.json(浏览器预览降级 localStorage),与 moodStore 同一套约定;
// 配额规则是纯函数(导出供测试):红 5 + 蓝 5 价态配额、每价态锁定 ≤3、
// 满员时同价态未锁定者中随机替换一条,价态全锁定则拒绝(不跨价态顶替)。

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from '../storage/writeLock'
import { inTauri } from '../storage/configStore'
import {
  QUIRK_SLOTS,
  QUIRK_TYPES,
  type ActorSlot,
  type QuirkBook,
  type QuirkCauseType,
  type QuirkEntry,
  type QuirkType,
  type QuirkValence,
} from './types'

const LS_KEY = 'vc-quirks'
const FILE_NAME = 'quirks.json'
const VERSION = 1

/** 每价态怪癖上限(红 5 + 蓝 5 = 总 10) */
export const MAX_PER_VALENCE = 5
/** 每价态锁定上限(保证每价态始终 ≥2 条未锁定,替换永远可行) */
export const LOCK_CAP_PER_VALENCE = 3

export interface QuirkPersistShape {
  version: number
  /** 主演出集数(每次点播/预生成 +1),怪癖 createdAtEp/lastUsedEp 的记账基准 */
  episode: number
  quirks: QuirkBook
}

export function defaultBook(): QuirkBook {
  return { A: [], B: [], C: [] }
}

export function defaultShape(): QuirkPersistShape {
  return { version: VERSION, episode: 0, quirks: defaultBook() }
}

function isValence(v: unknown): v is QuirkValence {
  return v === 'red' || v === 'blue'
}

function isCauseType(v: unknown): v is QuirkCauseType {
  return v === 'memory' || v === 'interaction' || v === 'inferred'
}

function isQuirkType(v: unknown): v is QuirkType {
  return typeof v === 'string' && (QUIRK_TYPES as readonly string[]).includes(v)
}

function sanitizeEntry(v: unknown): QuirkEntry | null {
  if (typeof v !== 'object' || v === null) return null
  const e = v as Record<string, unknown>
  if (!isValence(e.valence)) return null
  const trigger = typeof e.trigger === 'string' ? e.trigger.trim().slice(0, 80) : ''
  const behavior = typeof e.behavior === 'string' ? e.behavior.trim().slice(0, 80) : ''
  if (!trigger || !behavior) return null
  return {
    id: typeof e.id === 'string' && e.id ? e.id : makeId(),
    trigger,
    behavior,
    valence: e.valence,
    type: isQuirkType(e.type) ? e.type : '触发式',
    cause: typeof e.cause === 'string' ? e.cause.trim().slice(0, 120) : '',
    causeType: isCauseType(e.causeType) ? e.causeType : 'inferred',
    source: e.source === 'crystallized' ? 'crystallized' : 'cold',
    locked: e.locked === true,
    createdAtEp: typeof e.createdAtEp === 'number' && Number.isFinite(e.createdAtEp) ? e.createdAtEp : 0,
    lastUsedEp: typeof e.lastUsedEp === 'number' && Number.isFinite(e.lastUsedEp) ? e.lastUsedEp : -1,
  }
}

export function sanitizeShape(v: unknown): QuirkPersistShape {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const raw = (typeof o.quirks === 'object' && o.quirks !== null ? o.quirks : {}) as Record<string, unknown>
  const quirks = defaultBook()
  for (const slot of QUIRK_SLOTS) {
    const list = Array.isArray(raw[slot]) ? raw[slot] : []
    const cleaned: QuirkEntry[] = []
    for (const item of list) {
      const entry = sanitizeEntry(item)
      if (entry) cleaned.push(entry)
    }
    // 落盘数据也守配额:同价态超 5 保留前 5;锁定超 3 解多余锁(数据修复,不抛错)
    const kept: QuirkEntry[] = []
    const perValence = { red: 0, blue: 0 }
    const locks = { red: 0, blue: 0 }
    for (let entry of cleaned) {
      if (perValence[entry.valence] >= MAX_PER_VALENCE) continue
      perValence[entry.valence] += 1
      if (entry.locked && locks[entry.valence] >= LOCK_CAP_PER_VALENCE) entry = { ...entry, locked: false }
      if (entry.locked) locks[entry.valence] += 1
      kept.push(entry)
    }
    quirks[slot] = kept
  }
  return {
    version: VERSION,
    episode: typeof o.episode === 'number' && Number.isFinite(o.episode) && o.episode >= 0 ? Math.floor(o.episode) : 0,
    quirks,
  }
}

export function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  } catch {
    /* ignore */
  }
  return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

// ---------- 纯配额规则(导出供测试) ----------

export type InsertResult =
  | { ok: true; book: QuirkBook; replaced: QuirkEntry | null }
  | { ok: false; reason: 'valence-full-locked' }

/** 插入一条怪癖:同价态未满直接追加;已满(MAX_PER_VALENCE)时从该价态未锁定者中
 *  均匀随机替换一条;该价态全部锁定则拒绝(调用方本轮放弃,不跨价态顶替) */
export function insertQuirk(
  book: QuirkBook,
  slot: ActorSlot,
  entry: QuirkEntry,
  rng: () => number = Math.random,
): InsertResult {
  const list = book[slot]
  const sameValence = list.filter((q) => q.valence === entry.valence)
  if (sameValence.length < MAX_PER_VALENCE) {
    const next = { ...book, [slot]: [...list, entry] } as QuirkBook
    return { ok: true, book: next, replaced: null }
  }
  const unlocked = sameValence.filter((q) => !q.locked)
  if (unlocked.length === 0) return { ok: false, reason: 'valence-full-locked' }
  const victim = unlocked[Math.floor(rng() * unlocked.length) % unlocked.length]
  const idx = list.findIndex((q) => q.id === victim.id)
  const nextList = [...list]
  nextList[idx] = entry
  return { ok: true, book: { ...book, [slot]: nextList } as QuirkBook, replaced: victim }
}

export type LockResult = { ok: true; book: QuirkBook } | { ok: false; reason: 'lock-cap' }

/** 锁定/解锁:锁定时校验该价态锁定数上限(LOCK_CAP_PER_VALENCE) */
export function setQuirkLocked(book: QuirkBook, slot: ActorSlot, id: string, locked: boolean): LockResult {
  const target = book[slot].find((q) => q.id === id)
  if (!target) return { ok: true, book }
  if (locked && !target.locked) {
    const locks = book[slot].filter((q) => q.valence === target.valence && q.locked).length
    if (locks >= LOCK_CAP_PER_VALENCE) return { ok: false, reason: 'lock-cap' }
  }
  const nextList = book[slot].map((q) => (q.id === id ? { ...q, locked } : q))
  return { ok: true, book: { ...book, [slot]: nextList } as QuirkBook }
}

export function removeQuirk(book: QuirkBook, slot: ActorSlot, id: string): QuirkBook {
  return { ...book, [slot]: book[slot].filter((q) => q.id !== id) } as QuirkBook
}

// ---------- 持久化(与 moodStore 同一套约定) ----------

let cache: QuirkPersistShape | null = null
const listeners = new Set<() => void>()

const shapeOf = (s: QuirkPersistShape) => ({ version: VERSION, episode: s.episode, quirks: s.quirks })

async function readFile(): Promise<QuirkPersistShape> {
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitizeShape(JSON.parse(raw))
    } catch {
      // 坏数据按默认处理
    }
    return defaultShape()
  }
  try {
    const base = await appDataDir()
    const file = await join(base, 'data', FILE_NAME)
    if (await exists(file)) {
      return sanitizeShape(JSON.parse(await readTextFile(file)))
    }
  } catch (e) {
    console.warn('怪癖存储读取失败(按默认处理)', e)
  }
  return defaultShape()
}

async function writeFile(state: QuirkPersistShape): Promise<void> {
  cache = state
  if (!inTauri) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(shapeOf(state)))
    } catch {
      /* ignore */
    }
    return
  }
  try {
    const base = await appDataDir()
    const dir = await join(base, 'data')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    await writeTextFile(await join(dir, FILE_NAME), JSON.stringify(shapeOf(state), null, 2))
  } catch (e) {
    console.warn('怪癖存储落盘失败(静默)', e)
  }
}

/** 启动预载:渲染注入与设置页都要读,App 启动时调用一次 */
export async function ensureQuirksLoaded(): Promise<void> {
  if (!cache) cache = await readFile()
}

function emitChange(): void {
  for (const l of listeners) l()
}

/** 订阅变更(设置页刷新/测试);返回退订函数 */
export function subscribeQuirks(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 同步读(注入渲染用);未加载时回空册 */
export function getBookSync(): QuirkBook {
  return cache?.quirks ?? defaultBook()
}

/** 同步读当前集数 */
export function getEpisodeSync(): number {
  return cache?.episode ?? 0
}

export async function getShape(): Promise<QuirkPersistShape> {
  if (!cache) cache = await readFile()
  return cache
}

/** 原子变更:锁内读改写;变更后广播 */
export async function mutateShape(
  mutate: (state: QuirkPersistShape) => QuirkPersistShape | Promise<QuirkPersistShape>,
): Promise<void> {
  await withFileLock('quirks', async () => {
    const next = await mutate(await getShape())
    await writeFile(next)
  })
  emitChange()
}

/** 主演出集数 +1(generateDialog 每集调用;纯记账,不触发生成) */
export async function bumpEpisode(): Promise<number> {
  let episode = 0
  await mutateShape((s) => {
    episode = s.episode + 1
    return { ...s, episode }
  })
  return episode
}
