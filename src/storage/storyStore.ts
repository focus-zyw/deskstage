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

export interface StoryData {
  version: 1
  gags: StoryGag[]
  threads: StoryThread[]
}

const MAX_GAGS = 30
const MAX_THREADS = 15
const LS_KEY = 'vc-story'
const EMPTY: StoryData = { version: 1, gags: [], threads: [] }

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
  return { version: 1, gags, threads }
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

/** 合并蒸馏结果:同文去重(刷新 lastSeen/hits),超出上限按热度/新近度淘汰 */
export async function mergeStory(candidates: { gags: string[]; threads: string[] }): Promise<void> {
  if (candidates.gags.length === 0 && candidates.threads.length === 0) return
  await withFileLock('story', async () => {
    const story = await getStory()
    const now = Date.now()
    for (const raw of candidates.gags) {
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
    for (const raw of candidates.threads) {
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

/** 注入用:老梗按热度、事件线按新近度取前 n 条文本(空数组 = 没有素材) */
export async function storyContext(maxEach = 2): Promise<{ gags: string[]; threads: string[] }> {
  const story = await getStory()
  return {
    gags: [...story.gags]
      .sort((a, b) => b.hits - a.hits || b.lastSeen - a.lastSeen)
      .slice(0, maxEach)
      .map((g) => g.text),
    threads: [...story.threads].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, maxEach).map((t) => t.text),
  }
}
