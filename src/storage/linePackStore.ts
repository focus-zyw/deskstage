// 每日互动台词包存档:data/linepacks.json。开关开启时每天由 LLM 生成一整套
// 角色C的互动小台词(戳/摸头/投喂/点播),最多保留 7 份,超出删最早;
// 取用链:今天的包 → 存档里最早的一份(逐份找该类目还有存货的)→ null(调用方回退内置预置)。
// 与 config.json(开关)/ interactions.json(账本)互不干涉;浏览器预览降级 localStorage。

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { inTauri } from './configStore'

/** 台词包覆盖的互动类目(与 App 内置台词池一一对应) */
export type LineKind =
  | 'poke' // 戳一戳(轻戳档)
  | 'headpat' // 摸头长按
  | 'feed' // 投喂零食
  | 'joke' // 右键点播:讲个笑话
  | 'nap' // 右键点播:睡午觉
  | 'work' // 右键点播:干点活
  | 'dance' // 右键点播:跳个舞
  | 'trick' // 右键点播:来个绝活

export const LINE_KINDS: readonly LineKind[] = [
  'poke', 'headpat', 'feed', 'joke', 'nap', 'work', 'dance', 'trick',
]

export type LinePackLines = Partial<Record<LineKind, string[]>>

export interface LinePack {
  /** 本地日期 YYYY-MM-DD(生成当天) */
  date: string
  lines: LinePackLines
}

/** 存档上限:一周的量,超出删最早(今天的包也参与排序,今天总在最新端) */
const MAX_PACKS = 7
const LS_KEY = 'vc-linepacks'
/** 单类目行数与单句长度上限:防模型跑飞把存档撑爆 */
const MAX_LINES_PER_KIND = 12
const MAX_LINE_LEN = 30

let cache: LinePack[] | null = null

/** 本地日期键(取用链的"今天"以本机时区为准) */
export function dayKey(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${d}`
}

/** 字段级清洗:日期非法的包整份丢弃,类目截断、单句裁剪去空 */
export function sanitizeLinePacks(v: unknown): LinePack[] {
  if (!Array.isArray(v)) return []
  const out: LinePack[] = []
  for (const raw of v) {
    const o = (raw ?? {}) as Record<string, unknown>
    if (typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) continue
    const src = (o.lines ?? {}) as Record<string, unknown>
    const lines: LinePackLines = {}
    for (const kind of LINE_KINDS) {
      const arr = src[kind]
      if (!Array.isArray(arr)) continue
      const cleaned = arr
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim().slice(0, MAX_LINE_LEN))
        .filter(Boolean)
      if (cleaned.length > 0) lines[kind] = cleaned.slice(0, MAX_LINES_PER_KIND)
    }
    out.push({ date: o.date, lines })
  }
  // 按日期升序(最早在前);同日重复包只保留最后出现的(视为新写入)
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const deduped = new Map<string, LinePack>()
  for (const p of out) deduped.set(p.date, p)
  return [...deduped.values()].slice(-MAX_PACKS)
}

async function readAll(): Promise<LinePack[]> {
  if (cache) return cache
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) cache = sanitizeLinePacks(JSON.parse(raw))
    } catch { /* ignore */ }
    return (cache ??= [])
  }
  try {
    const base = await appDataDir()
    const file = await join(base, 'data', 'linepacks.json')
    if (await exists(file)) cache = sanitizeLinePacks(JSON.parse(await readTextFile(file)))
  } catch (e) {
    console.warn('台词包存档读取失败(静默)', e)
  }
  return (cache ??= [])
}

async function writeAll(packs: LinePack[]): Promise<void> {
  cache = packs
  if (!inTauri) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(packs)) } catch { /* ignore */ }
    return
  }
  try {
    const base = await appDataDir()
    const dir = await join(base, 'data')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    await writeTextFile(await join(dir, 'linepacks.json'), JSON.stringify(packs, null, 2))
  } catch (e) {
    console.warn('台词包存档落盘失败(静默)', e)
  }
}

/** 启动时预热内存缓存(takePackLine 是同步接口,须先 load) */
export async function loadLinePacks(): Promise<LinePack[]> {
  return readAll()
}

/** 保存今天的包:已有同日包则覆盖,按日期排序后裁掉超限最早的 */
export async function saveLinePack(pack: LinePack): Promise<void> {
  const packs = (await readAll()).filter((p) => p.date !== pack.date)
  packs.push({ date: pack.date, lines: sanitizeLinePacks([pack])[0]?.lines ?? {} })
  packs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  await writeAll(packs.slice(-MAX_PACKS))
}

// ---------- 取用(内存队列,重启即重置——跨会话可重复,不必持久化消费进度) ----------

/** 各类目的当日剩余队列:键 = `${date}:${kind}` */
const queues = new Map<string, string[]>()

function queueFor(pack: LinePack, kind: LineKind): string[] {
  const key = `${pack.date}:${kind}`
  let q = queues.get(key)
  if (!q) {
    q = [...(pack.lines[kind] ?? [])]
    // 洗牌:随机弹出但不重复,直到取空
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[q[i], q[j]] = [q[j], q[i]]
    }
    queues.set(key, q)
  }
  return q
}

/**
 * 取一句台词包台词(同步;须先 loadLinePacks)。
 * 今天的包优先;没有今天的,从存档最早的包起逐份找该类目还有存货的(旧包在被淘汰前先用掉);
 * 一份都没有返回 null,调用方回退本地预置池。
 */
export function takePackLine(kind: LineKind, today: string = dayKey()): string | null {
  const packs = cache
  if (!packs || packs.length === 0) return null
  const candidates = [...packs].sort((a, b) => (a.date < b.date ? -1 : 1))
  const todayIdx = candidates.findIndex((p) => p.date === today)
  if (todayIdx >= 0) {
    const line = queueFor(candidates[todayIdx], kind).pop()
    if (line) return line
  }
  for (const pack of candidates) {
    const line = queueFor(pack, kind).pop()
    if (line) return line
  }
  return null
}
