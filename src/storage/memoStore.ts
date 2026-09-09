// 备忘录:appData/data/memos.json。每条 = 待办内容 + 截止时间 + 可选单独提前量。
// 提醒触发后 fired=true(前端常驻气泡由用户关掉,重启后未完成的过期备忘会再弹一次);
// done=true 的不再提醒。全部写操作走 withFileLock;浏览器预览降级 localStorage。
// 注意隐私:备忘内容会注入生成讨论,添加时前端会提醒用户别写密码/验证码等敏感信息。

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'

export interface Memo {
  id: string
  /** 待办内容(≤200字) */
  text: string
  /** 截止时间(绝对时间戳 ms) */
  dueAt: number
  /** 单独设置的提前提醒分钟数;null = 用设置里的默认提前量 */
  advanceMin: number | null
  /** 提醒是否已触发(触发后常驻气泡由用户关闭) */
  fired: boolean
  /** 已完成 */
  done: boolean
  createdAt: number
}

export interface MemoData {
  version: 1
  memos: Memo[]
}

const MAX_MEMOS = 100
const LS_KEY = 'vc-memo'

let cache: MemoData | null = null

function clone(data: MemoData): MemoData {
  return JSON.parse(JSON.stringify(data)) as MemoData
}

async function memoFile(): Promise<string> {
  const base = await appDataDir()
  const dir = await join(base, 'data')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return join(dir, 'memos.json')
}

function newId(): string {
  return `m${Date.now()}${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeMemo(v: unknown): Memo | null {
  const o = (v ?? {}) as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text.trim().slice(0, 200) : ''
  const dueAt = Number(o.dueAt)
  if (!text || !Number.isFinite(dueAt) || dueAt <= 0) return null
  const adv = Number(o.advanceMin)
  const now = Date.now()
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : newId(),
    text,
    dueAt,
    advanceMin: Number.isFinite(adv) && adv > 0 ? Math.min(1440, Math.round(adv)) : null,
    fired: o.fired === true,
    done: o.done === true,
    createdAt: Number(o.createdAt) || now,
  }
}

function sanitize(data: unknown): MemoData {
  const o = (data ?? {}) as Record<string, unknown>
  const memos = (Array.isArray(o.memos) ? o.memos : [])
    .map(sanitizeMemo)
    .filter((m): m is Memo => m !== null)
  return { version: 1, memos: memos.slice(0, MAX_MEMOS) }
}

async function loadRaw(): Promise<MemoData> {
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitize(JSON.parse(raw))
    } catch (e) {
      console.warn('浏览器备忘读取失败', e)
    }
    return clone({ version: 1, memos: [] })
  }
  try {
    const file = await memoFile()
    if (await exists(file)) return sanitize(JSON.parse(await readTextFile(file)))
  } catch (e) {
    console.warn('备忘读取失败', e)
  }
  return { version: 1, memos: [] }
}

/** 读全部备忘(内存缓存) */
export async function getMemos(): Promise<Memo[]> {
  if (!cache) cache = await loadRaw()
  return clone(cache).memos.sort((a, b) => a.dueAt - b.dueAt)
}

/** 添加一条备忘,返回新条目 */
export async function addMemo(text: string, dueAt: number, advanceMin: number | null): Promise<Memo> {
  return withFileLock('memo', async () => {
    const data = cache ?? (await loadRaw())
    const memo: Memo = {
      id: newId(),
      text: text.trim().slice(0, 200),
      dueAt,
      advanceMin: advanceMin !== null ? Math.min(1440, Math.max(1, Math.round(advanceMin))) : null,
      fired: false,
      done: false,
      createdAt: Date.now(),
    }
    data.memos.push(memo)
    while (data.memos.length > MAX_MEMOS) {
      const doneIdx = data.memos.findIndex((m) => m.done)
      data.memos.splice(doneIdx >= 0 ? doneIdx : 0, 1)
    }
    await persist(data)
    return memo
  })
}

/** 更新备忘字段(勾选完成/标记已触发等) */
export async function updateMemo(id: string, patch: Partial<Pick<Memo, 'fired' | 'done'>>): Promise<void> {
  await withFileLock('memo', async () => {
    const data = cache ?? (await loadRaw())
    const m = data.memos.find((x) => x.id === id)
    if (!m) return
    if (patch.fired !== undefined) m.fired = patch.fired
    if (patch.done !== undefined) m.done = patch.done
    await persist(data)
  })
}

/** 删除一条备忘 */
export async function removeMemo(id: string): Promise<void> {
  await withFileLock('memo', async () => {
    const data = cache ?? (await loadRaw())
    data.memos = data.memos.filter((x) => x.id !== id)
    await persist(data)
  })
}

/** 到达提醒窗口的未完成备忘(已 fired 的不重复返回)。
 *  defaultAdvanceMin:未单独设置提前量时使用的默认提前分钟数(设置里的默认值) */
export async function getDueMemos(
  now = Date.now(),
  defaultAdvanceMin = 0,
): Promise<Memo[]> {
  const all = await getMemos()
  return all.filter((m) => {
    if (m.done || m.fired) return false
    const advance = m.advanceMin ?? defaultAdvanceMin
    return now >= m.dueAt - advance * 60_000
  })
}

async function persist(data: MemoData): Promise<void> {
  cache = data
  if (!inTauri) {
    localStorage.setItem(LS_KEY, JSON.stringify(data))
    return
  }
  await writeTextFile(await memoFile(), JSON.stringify(data, null, 2))
}

