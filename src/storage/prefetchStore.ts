// 预生成对话持久化:data/prefetch.json,与 history/ 完全独立。
// 预生成的集按 话题计划(TopicPlan) 暂存在此;真正开播时由调用方 appendHistory
// 写入历史并从这里移除("移入")。历史删除只碰 history/,永不波及本文件。
// 消费语义(动态话题系统):peekCompatiblePrefetch 按缓存兼容令牌挑选 → 采纳成功后才
// dropPrefetchEntry 删除——"缓存至多消费一次":CAS 冲突允许浪费缓存,绝不误播旧计划。
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
import { sanitizeTopicCard } from '../topic/store'
import type { TopicPlan } from '../topic/types'

export interface PrefetchEntry {
  mode: string
  /** 话题快照(展示与 legacy 记账用):等于 topicPlan.card.title */
  topic: string
  /** 产出该剧本的话题计划(缓存兼容令牌在其中) */
  topicPlan: TopicPlan
  script: PerformanceScript
  /** 连续剧情预生成项携带剧情 ID/拍数,供跨模式去重;普通话题没有此字段 */
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
    // 旧格式(只有 topic 字符串、无 topicPlan)直接失效丢弃:缓存是临时数据,重新生成
    if (!it?.topicPlan || typeof it.topicPlan !== 'object') continue
    const topicPlan = it.topicPlan as TopicPlan
    const rawArc = it?.arc && typeof it.arc === 'object' ? it.arc : null
    const arcId = typeof rawArc?.id === 'string' ? rawArc.id.slice(0, 40) : ''
    const arcStage = Math.max(1, Number(rawArc?.stage) || 0)
    const arc = arcId && arcStage ? { id: arcId, stage: arcStage } : undefined
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
    const card = sanitizeTopicCard(topicPlan.card)
    if (mode && card && before.length > 0) {
      out.push({ mode, topic: card.title, topicPlan: { ...topicPlan, card }, script, arc })
    }
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
  e.arc ? `arc\n${e.arc.id}\n${e.arc.stage}` : `plan\n${e.mode}\n${e.topicPlan.card.fingerprint}\n${e.topicPlan.intent}`

/** 保存一条预生成:按 剧情拍 / 模式+计划指纹 去重(同计划只留最新),超出上限丢最旧。
 *  读-改-写进锁,与 peek/drop(同为读-改-写)互斥 */
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

/** 缓存兼容令牌(动态话题系统构建;十条检查的数据面) */
export interface PrefetchCheck {
  /** 请求意图与计划意图必须一致(同 revision 下同世界状态,意图天然对齐) */
  intent: string
  /** 明确点播(手动文本或点卡):计划卡指纹必须一致,杜绝点 A 卡命中他卡缓存;
   *  自动请求:手动计划的卡不可消费 */
  requestedFingerprint?: string
  sessionRevision: number
  banHash: string
  modeHash: string
  /** 话题策略指纹(默认值+来源开关+个人策略):策略变了旧剧本不误用 */
  topicPolicyHash: string
  /** 演员阵容指纹(人设/名字/性别):阵容变了,带旧名字/旧世界的剧本不误播 */
  castHash: string
  plannerVersion: number
  /** 最近话题指纹:计划卡若已在 recent(如另一窗刚播过)则不可消费 */
  recentFingerprints: readonly string[]
  /** arcId → 剧情线当前拍号:缓存拍与当前拍不一致(他窗推进/完结)则不可消费 */
  arcStages?: Record<string, number>
  now: number
}

function compatible(entry: PrefetchEntry, mode: string, check: PrefetchCheck): boolean {
  const p = entry.topicPlan
  if (entry.mode !== mode) return false
  if (!p?.card || !p.compatibility) return false
  if (p.expiresAt < check.now) return false
  const c = p.compatibility
  if (c.sessionRevision !== check.sessionRevision) return false
  if (c.banHash !== check.banHash) return false
  if (c.modeHash !== check.modeHash) return false
  if (c.topicPolicyHash !== check.topicPolicyHash) return false
  if (c.castHash !== check.castHash) return false
  if (c.plannerVersion !== check.plannerVersion) return false
  // 意图兼容:普通点播(intent new)可消费会话推进条目(intent continue)——同 revision
  // 下两者解析为同一"下一集";换角度/换台/惊喜必须意图严格一致
  if (p.intent !== check.intent && !(check.intent === 'new' && p.intent === 'continue')) return false
  if (check.requestedFingerprint !== undefined) {
    if (p.card.fingerprint !== check.requestedFingerprint) return false
  } else if (p.card.source === 'manual') {
    return false
  }
  if (check.recentFingerprints.includes(p.card.fingerprint)) return false
  if (entry.arc) {
    if (!check.arcStages || check.arcStages[entry.arc.id] !== entry.arc.stage) return false
  }
  return true
}

/** 查看该模式下第一条兼容预生成(不删除):采纳成功后才由 dropPrefetchEntry 消费 */
export async function peekCompatiblePrefetch(mode: string, check: PrefetchCheck): Promise<PrefetchEntry | null> {
  try {
    return await withFileLock('prefetch', async () =>
      (await readAll()).find((e) => compatible(e, mode, check)) ?? null,
    )
  } catch (e) {
    console.warn('预生成兼容查询失败(静默)', e)
    return null
  }
}

/** 删除一条预生成(采纳成功后消费;stale 丢弃也走这里)。找不到视为已清理 */
export async function dropPrefetchEntry(entry: PrefetchEntry): Promise<void> {
  try {
    await withFileLock('prefetch', async () => {
      const entries = (await readAll()).filter((e) => entryKey(e) !== entryKey(entry))
      await writeAll(entries)
    })
  } catch (e) {
    console.warn('预生成移除失败(静默)', e)
  }
}

/** 已落入缓存、尚未播放的剧情 ID；剧情占用协调器据此避开跨模式重复预生成。 */
export async function listPrefetchedArcIds(): Promise<Set<string>> {
  return withFileLock('prefetch', async () =>
    new Set((await readAll()).flatMap((entry) => (entry.arc ? [entry.arc.id] : []))),
  )
}
