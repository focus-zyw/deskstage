// 预生成对话持久化:data/prefetch.json,与 history/ 完全独立。
// 预生成的集按 模式+主题 区分暂存在此;真正播出时由调用方 appendHistory
// 写入历史并从这里移除("移入")。历史删除只碰 history/,永不波及本文件。
// 所有操作静默容错——失败不影响演出主流程。
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import type { DialogLine, Speaker } from '../performer/player'

export interface PrefetchEntry {
  mode: string
  topic: string
  lines: DialogLine[]
}

/** 缓冲总量上限,超出丢最旧(两个模式累加也不会触顶,防御性保留) */
const MAX_ENTRIES = 6

async function getFile(): Promise<string> {
  const base = await appDataDir()
  const dir = await join(base, 'data')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return join(dir, 'prefetch.json')
}

function sanitizeEntries(v: unknown): PrefetchEntry[] {
  if (!Array.isArray(v)) return []
  const out: PrefetchEntry[] = []
  for (const it of v) {
    const mode = typeof it?.mode === 'string' ? it.mode : ''
    const topic = typeof it?.topic === 'string' ? it.topic : ''
    const lines: DialogLine[] = []
    if (Array.isArray(it?.lines)) {
      for (const l of it.lines) {
        if (l && (l.speaker === 'A' || l.speaker === 'B') && typeof l.text === 'string') {
          lines.push({
            speaker: l.speaker as Speaker,
            text: String(l.text),
            action: String(l.action || 'talk'),
          })
        }
      }
    }
    if (mode && topic && lines.length > 0) out.push({ mode, topic, lines })
  }
  return out
}

async function readAll(): Promise<PrefetchEntry[]> {
  try {
    const file = await getFile()
    if (!(await exists(file))) return []
    return sanitizeEntries(JSON.parse(await readTextFile(file)))
  } catch (e) {
    console.warn('预生成读取失败(静默)', e)
    return []
  }
}

async function writeAll(entries: PrefetchEntry[]): Promise<void> {
  const file = await getFile()
  await writeTextFile(file, JSON.stringify(entries, null, 2))
}

const entryKey = (e: PrefetchEntry) => `${e.mode}\n${e.topic}`

/** 保存一条预生成:按 模式+主题 去重(同主题只留最新),超出上限丢最旧 */
export async function savePrefetchEntry(entry: PrefetchEntry): Promise<void> {
  try {
    const entries = (await readAll()).filter((e) => entryKey(e) !== entryKey(entry))
    entries.push(entry)
    while (entries.length > MAX_ENTRIES) entries.shift()
    await writeAll(entries)
  } catch (e) {
    console.warn('预生成落盘失败(静默)', e)
  }
}

/** 取出该模式的一条预生成(FIFO)并从文件移除;没有则 null */
export async function takePrefetch(mode: string): Promise<PrefetchEntry | null> {
  try {
    const entries = await readAll()
    const idx = entries.findIndex((e) => e.mode === mode)
    if (idx < 0) return null
    const [hit] = entries.splice(idx, 1)
    await writeAll(entries)
    return hit ?? null
  } catch (e) {
    console.warn('预生成取出失败(静默)', e)
    return null
  }
}
