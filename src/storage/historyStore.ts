// 聊天记录持久化：appData/data/history/{yyyy-MM-dd}.jsonl，逐行 JSON 追加。
// 一集 = 一次 appendHistory 落盘的所有行（共享同一 ts），ts 即集 ID。
// 收藏存独立整集拷贝 appData/data/favorites.json，与历史解耦：
// 删除历史不影响收藏，收藏对话因此不会被删除。
// 所有操作静默容错——存储失败不影响演出主流程。
import { readTextFile, writeTextFile, exists, mkdir, readDir, remove } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { clampPauseMs, sanitizeAction, sanitizeDelivery, type DialogLine, type Speaker } from '../performer/player'
import { withFileLock } from './writeLock'

export interface HistoryEntry extends DialogLine {
  ts: number
  mode: string
  topic?: string
}

/** 一集对话：历史按 ts 聚合；fav 来自收藏库 */
export interface Episode {
  ts: number
  mode: string
  lines: DialogLine[]
  fav: boolean
  topic?: string
}

type FavRecord = Omit<Episode, 'fav'>

let dirPromise: Promise<string> | null = null

/** appData/data/history 目录（懒创建，缓存 promise） */
function getHistoryDir(): Promise<string> {
  if (!dirPromise) {
    dirPromise = (async () => {
      const base = await appDataDir()
      const dir = await join(base, 'data', 'history')
      if (!(await exists(dir))) {
        await mkdir(dir, { recursive: true })
      }
      return dir
    })()
  }
  return dirPromise
}

/** appData/data 目录（config.json / favorites.json 所在） */
async function getDataDir(): Promise<string> {
  const base = await appDataDir()
  const dir = await join(base, 'data')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return dir
}

function todayFileId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function entryToLine(e: HistoryEntry): string {
  return JSON.stringify({
    ts: e.ts,
    mode: e.mode,
    speaker: e.speaker,
    text: e.text,
    action: e.action,
    topic: e.topic,
    // 演出信息:停顿/听者动作/语气,回放时还原节奏
    pauseBefore: e.pauseBefore,
    pauseAfter: e.pauseAfter,
    listenerAction: e.listenerAction,
    delivery: e.delivery,
  })
}

/** 解析一个日文件的全部行，跳过坏行 */
function parseEntries(raw: string): HistoryEntry[] {
  const parsed: HistoryEntry[] = []
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const obj = JSON.parse(line)
      if (obj.speaker === 'A' || obj.speaker === 'B') {
        parsed.push({
          ts: Number(obj.ts) || 0,
          mode: String(obj.mode || 'daily'),
          speaker: obj.speaker as Speaker,
          text: String(obj.text || ''),
          action: sanitizeAction(obj.action),
          topic: typeof obj.topic === 'string' && obj.topic ? obj.topic : undefined,
          pauseBefore: clampPauseMs(obj.pauseBefore),
          pauseAfter: clampPauseMs(obj.pauseAfter),
          listenerAction:
            typeof obj.listenerAction === 'string' && obj.listenerAction
              ? sanitizeAction(obj.listenerAction)
              : undefined,
          delivery: sanitizeDelivery(obj.delivery),
        })
      }
    } catch {
      // 跳过坏行
    }
  }
  return parsed
}

async function listHistoryFiles(dir: string): Promise<string[]> {
  const entries = await readDir(dir)
  return entries
    .filter((e) => e.isFile && e.name?.endsWith('.jsonl'))
    .map((e) => e.name!)
    .sort()
}

/** 一集生成成功后整段落盘;topic 可选(手动锁定主题时记录)。
 *  与 deleteEpisodes 的"读-重写"互斥,避免追加的行被重写吞掉 */
export async function appendHistory(lines: DialogLine[], mode: string, topic?: string): Promise<void> {
  try {
    await withFileLock('history', async () => {
      const dir = await getHistoryDir()
      const file = await join(dir, `${todayFileId()}.jsonl`)
      const ts = Date.now()
      const chunk =
        lines
          .map((l) =>
            entryToLine({ ts, mode, speaker: l.speaker, text: l.text, action: l.action, topic }),
          )
          .join('\n') + '\n'
      await writeTextFile(file, chunk, { append: true })
    })
  } catch (e) {
    console.warn('历史落盘失败（不影响演出）', e)
  }
}

/** 读取最近 n 条记录（从最新的日文件尾部取），用于启动恢复上下文 */
export async function loadRecentHistory(n = 20): Promise<HistoryEntry[]> {
  try {
    const dir = await getHistoryDir()
    const files = await listHistoryFiles(dir)
    if (files.length === 0) return []
    const result: HistoryEntry[] = []
    for (let i = files.length - 1; i >= 0 && result.length < n; i--) {
      const parsed = parseEntries(await readTextFile(await join(dir, files[i])))
      result.unshift(...parsed.slice(Math.max(0, parsed.length - (n - result.length))))
    }
    return result.slice(-n)
  } catch (e) {
    console.warn('历史读取失败', e)
    return []
  }
}

// ---------- 收藏 ----------

async function readFavorites(): Promise<FavRecord[]> {
  try {
    const file = await join(await getDataDir(), 'favorites.json')
    if (!(await exists(file))) return []
    const arr: unknown = JSON.parse(await readTextFile(file))
    if (!Array.isArray(arr)) return []
    const out: FavRecord[] = []
    for (const it of arr) {
      const ts = Number(it?.ts) || 0
      if (!ts || !Array.isArray(it.lines)) continue
      const lines: DialogLine[] = []
      for (const l of it.lines) {
        if (l && (l.speaker === 'A' || l.speaker === 'B') && typeof l.text === 'string') {
          lines.push({
            speaker: l.speaker,
            text: String(l.text),
            action: sanitizeAction(l.action),
            pauseBefore: clampPauseMs(l.pauseBefore),
            pauseAfter: clampPauseMs(l.pauseAfter),
            listenerAction:
              typeof l.listenerAction === 'string' && l.listenerAction
                ? sanitizeAction(l.listenerAction)
                : undefined,
            delivery: sanitizeDelivery(l.delivery),
          })
        }
      }
      if (lines.length > 0)
        out.push({ ts, mode: String(it.mode || 'daily'), lines, topic: String(it.topic || '') || undefined })
    }
    return out
  } catch (e) {
    console.warn('收藏读取失败', e)
    return []
  }
}

async function writeFavorites(favs: FavRecord[]): Promise<void> {
  const file = await join(await getDataDir(), 'favorites.json')
  await writeTextFile(file, JSON.stringify(favs, null, 2))
}

/** 切换某集收藏状态,返回切换后是否已收藏。
 *  读-改-写整体进锁:快速连点时不会互相覆盖 */
export async function toggleFavorite(ep: FavRecord): Promise<boolean> {
  try {
    return await withFileLock('favorites', async () => {
      const favs = await readFavorites()
      const idx = favs.findIndex((f) => f.ts === ep.ts)
      if (idx >= 0) {
        favs.splice(idx, 1)
        await writeFavorites(favs)
        return false
      }
      favs.push({ ts: ep.ts, mode: ep.mode, lines: ep.lines, topic: ep.topic })
      await writeFavorites(favs)
      return true
    })
  } catch (e) {
    console.warn('收藏切换失败', e)
    return false
  }
}

// ---------- 分集 / 删除 ----------

/**
 * 全部历史按 ts 聚合成分集（倒序），合并收藏库中已不在历史里的集，
 * 最多返回 limit 集。收藏集以 fav 标记。
 */
export async function listEpisodes(limit = 50): Promise<Episode[]> {
  try {
    const dir = await getHistoryDir()
    const byTs = new Map<number, Episode>()
    for (const name of await listHistoryFiles(dir)) {
      for (const e of parseEntries(await readTextFile(await join(dir, name)))) {
        let ep = byTs.get(e.ts)
        if (!ep) {
          ep = { ts: e.ts, mode: e.mode, lines: [], fav: false, topic: e.topic }
          byTs.set(e.ts, ep)
        }
        if (!ep.topic && e.topic) ep.topic = e.topic
        ep.lines.push({
          speaker: e.speaker,
          text: e.text,
          action: e.action,
          pauseBefore: e.pauseBefore,
          pauseAfter: e.pauseAfter,
          listenerAction: e.listenerAction,
          delivery: e.delivery,
        })
      }
    }
    for (const f of await readFavorites()) {
      const ep = byTs.get(f.ts)
      if (ep) ep.fav = true
      else byTs.set(f.ts, { ts: f.ts, mode: f.mode, lines: f.lines, fav: true, topic: f.topic })
    }
    return [...byTs.values()].sort((a, b) => b.ts - a.ts).slice(0, limit)
  } catch (e) {
    console.warn('历史分集读取失败', e)
    return []
  }
}

/**
 * 删除指定 ts 的历史集（重写受影响日文件，删空则移除整个文件）。
 * 收藏库不受影响——UI 层负责不让删除收藏集。
 */
export async function deleteEpisodes(tsSet: Set<number>): Promise<void> {
  if (tsSet.size === 0) return
  try {
    await withFileLock('history', async () => {
      const dir = await getHistoryDir()
      for (const name of await listHistoryFiles(dir)) {
        const file = await join(dir, name)
        const entries = parseEntries(await readTextFile(file))
        const kept = entries.filter((e) => !tsSet.has(e.ts))
        if (kept.length === entries.length) continue
        if (kept.length === 0) {
          await remove(file)
        } else {
          await writeTextFile(file, kept.map(entryToLine).join('\n') + '\n')
        }
      }
    })
  } catch (e) {
    console.warn('历史删除失败', e)
  }
}
