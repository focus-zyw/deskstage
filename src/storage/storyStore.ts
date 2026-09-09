// 角色共同记忆(角色世界):appData/data/story.json。
// gags[]:两人之间的固定笑点/歪理(如"冰箱是甲的健身器材"),后续剧集可自然回收;
// threads[]:尚未了结的事件线(如"乙还欠甲一杯奶茶"),适合在包袱里了结。
// 与 memoryStore(观众事实)刻意分离:笑点回调只用角色共同经历,观众隐私只作亲切感语境。
// 全部写操作走 withFileLock;浏览器预览降级 localStorage。失败静默不影响演出。

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'

export interface StoryGag {
  id: string
  text: string
  lastSeen: number
  hits: number
}

export interface StoryThread {
  id: string
  text: string
  lastSeen: number
}

export interface StoryArc {
  id: string
  title: string
  /** 已演出的拍数;第 1 拍 = newArc 时的那集 */
  stage: number
  /** 下一拍要演出的进展/悬念 */
  nextHook: string
  status: 'active' | 'done'
  lastSeen: number
}

export interface StoryData {
  version: 1
  gags: StoryGag[]
  threads: StoryThread[]
  arcs: StoryArc[]
}

const MAX_GAGS = 30
const MAX_THREADS = 15
const MAX_ACTIVE_ARCS = 3
/** 剧情线拍到第 4 拍自动完结(多集小剧情,不宜无限拖) */
const MAX_ARC_STAGE = 4
const LS_KEY = 'vc-story'
const EMPTY: StoryData = { version: 1, gags: [], threads: [], arcs: [] }

let cache: StoryData | null = null

function clone(data: StoryData): StoryData {
  return JSON.parse(JSON.stringify(data)) as StoryData
}

async function storyFile(): Promise<string> {
  const base = await appDataDir()
  const dir = await join(base, 'data')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return join(dir, 'story.json')
}

function newId(prefix: string): string {
  return `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeGag(v: unknown): StoryGag | null {
  const o = (v ?? {}) as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text.trim().slice(0, 60) : ''
  if (!text) return null
  const now = Date.now()
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : newId('g'),
    text,
    lastSeen: Number(o.lastSeen) || now,
    hits: Math.max(0, Number(o.hits) || 0),
  }
}

function sanitizeThread(v: unknown): StoryThread | null {
  const o = (v ?? {}) as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text.trim().slice(0, 60) : ''
  if (!text) return null
  const now = Date.now()
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : newId('t'),
    text,
    lastSeen: Number(o.lastSeen) || now,
  }
}

function sanitizeArc(v: unknown): StoryArc | null {
  const o = (v ?? {}) as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, 30) : ''
  const hook = typeof o.nextHook === 'string' ? o.nextHook.trim().slice(0, 60) : ''
  if (!title || !hook) return null
  const now = Date.now()
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : newId('a'),
    title,
    stage: Math.min(MAX_ARC_STAGE, Math.max(1, Number(o.stage) || 1)),
    nextHook: hook,
    status: o.status === 'done' ? 'done' : 'active',
    lastSeen: Number(o.lastSeen) || now,
  }
}

function sanitize(data: unknown): StoryData {
  const o = (data ?? {}) as Record<string, unknown>
  const gags = (Array.isArray(o.gags) ? o.gags : [])
    .map(sanitizeGag)
    .filter((g): g is StoryGag => g !== null)
    .slice(0, MAX_GAGS)
  const threads = (Array.isArray(o.threads) ? o.threads : [])
    .map(sanitizeThread)
    .filter((t): t is StoryThread => t !== null)
    .slice(0, MAX_THREADS)
  const arcs = (Array.isArray(o.arcs) ? o.arcs : [])
    .map(sanitizeArc)
    .filter((a): a is StoryArc => a !== null)
    .slice(0, 8)
  return { version: 1, gags, threads, arcs }
}

async function loadRaw(): Promise<StoryData> {
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitize(JSON.parse(raw))
    } catch (e) {
      console.warn('浏览器角色世界读取失败', e)
    }
    return clone(EMPTY)
  }
  try {
    const file = await storyFile()
    if (await exists(file)) return sanitize(JSON.parse(await readTextFile(file)))
  } catch (e) {
    console.warn('角色世界读取失败', e)
  }
  return clone(EMPTY)
}

/** 读全部角色世界(内存缓存) */
export async function getStory(): Promise<StoryData> {
  if (!cache) cache = await loadRaw()
  return clone(cache)
}

/** 变更落盘 */
async function persist(next: StoryData): Promise<void> {
  cache = next
  if (!inTauri) {
    localStorage.setItem(LS_KEY, JSON.stringify(next))
    return
  }
  await writeTextFile(await storyFile(), JSON.stringify(next, null, 2))
}

/** 蒸馏结果里的剧情线记账 */
export interface ArcAdvance {
  id: string
  nextHook: string
}

export interface NewArc {
  title: string
  hook: string
}

/** 合并一次蒸馏结果:
 *  - resolvedThreadIds:台词里已了结的事件线 → 结案移除,不再注入
 *  - reusedGagIds:台词里实际回收了的老梗 → hits+1(真实"被用过"计数)
 *  - newGags/newThreads:新素材,同文去重后入库,超上限按热度/新近度淘汰
 *  - arcAdvance:连续剧情推进一拍(stage+1,写入新钩子;拍数到顶自动完结)
 *  - newArc:本集冒出的新剧情线(活跃剧情线满 3 条时拒绝) */
export interface DistilledStory {
  newGags: string[]
  newThreads: string[]
  resolvedThreadIds: string[]
  reusedGagIds: string[]
  arcAdvance: ArcAdvance | null
  newArc: NewArc | null
}

export async function mergeStory(result: DistilledStory): Promise<void> {
  const hasNew = result.newGags.length > 0 || result.newThreads.length > 0
  const hasBookkeeping =
    result.resolvedThreadIds.length > 0 ||
    result.reusedGagIds.length > 0 ||
    !!result.arcAdvance ||
    !!result.newArc
  if (!hasNew && !hasBookkeeping) return
  await withFileLock('story', async () => {
    const story = await getStory()
    const now = Date.now()
    // 剧情线推进一拍
    if (result.arcAdvance) {
      const arc = story.arcs.find(
        (a) => a.id === result.arcAdvance!.id && a.status === 'active',
      )
      if (arc) {
        arc.stage += 1
        arc.nextHook = result.arcAdvance.nextHook.trim().slice(0, 60) || arc.nextHook
        arc.lastSeen = now
        if (arc.stage >= MAX_ARC_STAGE) arc.status = 'done'
      }
    }
    // 新剧情线:活跃位满 3 条时拒绝,防剧情线挤掉日常
    if (result.newArc) {
      const title = result.newArc.title.trim().slice(0, 30)
      const hook = result.newArc.hook.trim().slice(0, 60)
      if (title && hook && !story.arcs.some((a) => a.title === title && a.status === 'active')) {
        if (story.arcs.filter((a) => a.status === 'active').length < MAX_ACTIVE_ARCS) {
          story.arcs.push({
            id: newId('a'),
            title,
            stage: 1,
            nextHook: hook,
            status: 'active',
            lastSeen: now,
          })
        }
      }
    }
    // 结案:已了结的事件线移除
    if (result.resolvedThreadIds.length > 0) {
      story.threads = story.threads.filter((t) => !result.resolvedThreadIds.includes(t.id))
    }
    // 真实回收计数
    for (const id of result.reusedGagIds) {
      const gag = story.gags.find((g) => g.id === id)
      if (gag) {
        gag.hits += 1
        gag.lastSeen = now
      }
    }
    for (const raw of result.newGags) {
      const text = raw.trim().slice(0, 60)
      if (!text) continue
      const existing = story.gags.find((g) => g.text === text)
      if (existing) {
        existing.lastSeen = now
        existing.hits += 1
      } else {
        story.gags.push({ id: newId('g'), text, lastSeen: now, hits: 0 })
      }
    }
    for (const raw of result.newThreads) {
      const text = raw.trim().slice(0, 60)
      if (!text) continue
      const existing = story.threads.find((t) => t.text === text)
      if (existing) {
        existing.lastSeen = now
      } else {
        story.threads.push({ id: newId('t'), text, lastSeen: now })
      }
    }
    if (story.gags.length > MAX_GAGS) {
      story.gags = [...story.gags]
        .sort((a, b) => b.lastSeen - a.lastSeen || b.hits - a.hits)
        .slice(0, MAX_GAGS)
    }
    if (story.threads.length > MAX_THREADS) {
      story.threads = [...story.threads].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_THREADS)
    }
    await persist(story)
  })
}

export async function removeStoryItem(kind: 'gags' | 'threads', id: string): Promise<void> {
  await withFileLock('story', async () => {
    const story = await getStory()
    if (kind === 'gags') story.gags = story.gags.filter((x) => x.id !== id)
    else story.threads = story.threads.filter((x) => x.id !== id)
    await persist(story)
  })
}

/** 删除一条剧情线 */
export async function removeArc(id: string): Promise<void> {
  await withFileLock('story', async () => {
    const story = await getStory()
    story.arcs = story.arcs.filter((a) => a.id !== id)
    await persist(story)
  })
}

/** 抽一个连续剧情节拍:30% 概率命中(其余返回 null,本集走普通话题);
 *  多条活跃剧情线时推进"最久没演"的那条。rng 可注入便于测试 */
export function pickArcBeat(
  arcs: StoryArc[],
  rng: () => number = Math.random,
): { id: string; title: string; hook: string; stage: number } | null {
  const active = arcs.filter((a) => a.status === 'active')
  if (active.length === 0 || rng() >= 0.3) return null
  const arc = [...active].sort((a, b) => a.lastSeen - b.lastSeen)[0]!
  return { id: arc.id, title: arc.title, hook: arc.nextHook, stage: arc.stage }
}

/** 注入用:老梗按热度、事件线按新近度取前 n 条文本(空数组 = 没有素材) */
export async function storyContext(maxEach = 2): Promise<{ gags: string[]; threads: string[] }> {
  const inv = await storyInventory(maxEach)
  return {
    gags: inv.gags.map((g) => g.text),
    threads: inv.threads.map((t) => t.text),
  }
}

/** 蒸馏用:带 id 的已知素材清单(老梗按热度、事件线按新近度、剧情线全量活跃) */
export async function storyInventory(
  maxEach = 3,
): Promise<{
  gags: { id: string; text: string }[]
  threads: { id: string; text: string }[]
  arcs: { id: string; title: string; stage: number; hook: string }[]
}> {
  const story = await getStory()
  return {
    gags: [...story.gags]
      .sort((a, b) => b.hits - a.hits || b.lastSeen - a.lastSeen)
      .slice(0, maxEach)
      .map((g) => ({ id: g.id, text: g.text })),
    threads: [...story.threads]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, maxEach)
      .map((t) => ({ id: t.id, text: t.text })),
    arcs: story.arcs
      .filter((a) => a.status === 'active')
      .map((a) => ({ id: a.id, title: a.title, stage: a.stage, hook: a.nextHook })),
  }
}
