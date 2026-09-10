// 预生成对话持久化:data/prefetch.json,与 history/ 完全独立。
// 预生成的集按 模式+主题 区分暂存在此;真正播出时由调用方 appendHistory
// 写入历史并从这里移除("移入")。历史删除只碰 history/,永不波及本文件。
// 所有操作静默容错——失败不影响演出主流程。
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import {
  sanitizeChoicePoint,
  sanitizeDialog,
  sanitizeSceneCard,
  type ContextAdoption,
  type PerformanceScript,
} from '../performer/dialogSchema'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'

export interface PrefetchEntry {
  mode: string
  topic: string
  script: PerformanceScript
  /** 连续剧情预生成项携带剧情 ID/拍数，供跨模式去重；普通话题没有此字段 */
  arc?: { id: string; stage: number }
}

/** 缓冲总量上限,超出丢最旧(两个模式累加也不会触顶,防御性保留) */
const MAX_ENTRIES = 6
const LS_KEY = 'vc-prefetch'

async function getFile(): Promise<string> {
  const base = await appDataDir()
  const dir = await join(base, 'data')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return join(dir, 'prefetch.json')
}

/** 预生成暂缓的上下文采纳,缓存读取时原样恢复(坏形丢弃,不阻断命中) */
function sanitizeAdoption(v: unknown): ContextAdoption | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const ids = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(0, 4) : []
  const gagIds = ids(o.gagIds)
  const threadIds = ids(o.threadIds)
  if (gagIds.length === 0 && threadIds.length === 0 && o.hasRecap !== true) return undefined
  return { gagIds, threadIds, hasRecap: o.hasRecap === true }
}

function sanitizeEntries(v: unknown): PrefetchEntry[] {
  if (!Array.isArray(v)) return []
  const out: PrefetchEntry[] = []
  for (const it of v) {
    const mode = typeof it?.mode === 'string' ? it.mode : ''
    const topic = typeof it?.topic === 'string' ? it.topic : ''
    const rawArc = it?.arc && typeof it.arc === 'object' ? it.arc : null
    const arcId = typeof rawArc?.id === 'string' ? rawArc.id.slice(0, 40) : ''
    const arcStage = Math.max(1, Number(rawArc?.stage) || 0)
    const arc = arcId && arcStage ? { id: arcId, stage: arcStage } : undefined
    // 旧格式只有 lines[]，choice/after 已不可恢复；缓存是临时数据，直接失效并重新生成。
    const rawScript = it?.script && typeof it.script === 'object' ? it.script : null
    if (!rawScript) continue
    const before = sanitizeDialog(rawScript.before)
    const choice = sanitizeChoicePoint(rawScript?.choice)
    const after: PerformanceScript['after'] = {}
    if (rawScript?.after && typeof rawScript.after === 'object') {
      for (const [branchId, branchLines] of Object.entries(rawScript.after)) {
        const id = branchId.trim().slice(0, 24)
        const lines = sanitizeDialog(branchLines)
        if (id && lines.length > 0) after[id] = lines
      }
    }
    const completeChoice =
      choice && choice.options.every((option) => (after[option.id]?.length ?? 0) > 0)
        ? choice
        : undefined
    const script: PerformanceScript = {
      before,
      card: sanitizeSceneCard(rawScript.card),
      choice: completeChoice,
      after: completeChoice ? after : {},
      adoption: sanitizeAdoption(rawScript.adoption),
    }
    if (mode && topic && before.length > 0) out.push({ mode, topic, script, arc })
  }
  return out
}

async function readAll(): Promise<PrefetchEntry[]> {
  try {
    if (!inTauri) {
      const raw = localStorage.getItem(LS_KEY)
      return raw ? sanitizeEntries(JSON.parse(raw)) : []
    }
    const file = await getFile()
    if (!(await exists(file))) return []
    return sanitizeEntries(JSON.parse(await readTextFile(file)))
  } catch (e) {
    console.warn('预生成读取失败(静默)', e)
    return []
  }
}

async function writeAll(entries: PrefetchEntry[]): Promise<void> {
  if (!inTauri) {
    localStorage.setItem(LS_KEY, JSON.stringify(entries))
    return
  }
  const file = await getFile()
  await writeTextFile(file, JSON.stringify(entries, null, 2))
}

const entryKey = (e: PrefetchEntry) =>
  e.arc ? `arc\n${e.arc.id}\n${e.arc.stage}` : `${e.mode}\n${e.topic}`

/** 保存一条预生成:按 模式+主题 去重(同主题只留最新),超出上限丢最旧。
 *  读-改-写进锁,与 takePrefetch(同为读-改-写)互斥 */
export async function savePrefetchEntry(entry: PrefetchEntry): Promise<void> {
  try {
    await withFileLock('prefetch', async () => {
      const entries = (await readAll()).filter((e) => entryKey(e) !== entryKey(entry))
      entries.push(entry)
      while (entries.length > MAX_ENTRIES) entries.shift()
      await writeAll(entries)
    })
  } catch (e) {
    console.warn('预生成落盘失败(静默)', e)
  }
}

/** 取出该模式的一条预生成并从文件移除;没有则 null。
 *  topic 传入时只取 mode+topic 都匹配的条目(手动主题);
 *  不传时维持 FIFO,任意条目都合法(随机主题) */
export async function takePrefetch(mode: string, topic?: string): Promise<PrefetchEntry | null> {
  try {
    return await withFileLock('prefetch', async () => {
      const entries = await readAll()
      const idx = topic ? entries.findIndex((e) => e.mode === mode && e.topic === topic) : entries.findIndex((e) => e.mode === mode)
      if (idx < 0) return null
      const [hit] = entries.splice(idx, 1)
      await writeAll(entries)
      return hit ?? null
    })
  } catch (e) {
    console.warn('预生成取出失败(静默)', e)
    return null
  }
}

/** 已落入缓存、尚未播放的剧情 ID；剧情占用协调器据此避开跨模式重复预生成。 */
export async function listPrefetchedArcIds(): Promise<Set<string>> {
  return withFileLock('prefetch', async () =>
    new Set((await readAll()).flatMap((entry) => (entry.arc ? [entry.arc.id] : []))),
  )
}
