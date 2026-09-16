// ContextLifecycleManager:Hot→Warm→Cold 的生命周期裁判(唯一入口 observeTurn)。
//
// 位置边界(Pi compaction 语义):最新 HOT_WINDOW 条聊天保持原文注入,更早的未折叠
// 消息即为"待压缩前缀"。前缀 ≥ COMPACT_THRESHOLD 触发滚动压缩:把"上次摘要 + 本批
// 折叠消息"合并成新 rollingSummary(Pi 增量摘要),chatlog.jsonl 一字不动——压缩只改
// 注入视图,不删历史。
// 会话闭合:相邻消息间隔 > SESSION_GAP_MS 时,先把 pending 冲一冲,再把滚动摘要
// 冻结为集摘要(WarmEpisode),开新会话。
// Cold 晋级:每次成功压缩把折叠批次(privacy 过滤后)交 Mem0 做抽取-裁决写入,
// fire-and-forget,失败不影响 Warm。
// 纪律:restricted 消息不进压缩输入;摘要含 restricted → 丢弃摘要但推进折叠位
// (遗忘);任一步失败 pending 原样保留(未折叠 ⇒ 下次重试),绝不影响聊天。
import { compactWarmSession } from '../engine/llmClient'
import { listChatTurns, type ChatLogEntry } from '../storage/chatLogStore'
import { detectSensitivity } from '../storage/memoryPolicy'
import {
  currentSession,
  ensureSession,
  freezeCurrentSession,
  getWarmData,
  markTurnsFolded,
  saveCurrentSession,
  type WarmSession,
} from '../storage/warmStore'
import { mem0Memory } from '../cold/mem0Memory'

// ---- 生命周期参数(位置/阈值全部集中在此) ----
/** 保持原文的热窗口(与 turnWindow 上限、群聊已读尾一致) */
export const HOT_WINDOW = 10
/** 待压缩前缀达到此数量触发滚动压缩 */
export const COMPACT_THRESHOLD = 8
/** 单次压缩最多折叠的消息数 */
export const COMPACT_BATCH = 12
/** 前积压超过此数,最旧的直接放弃摘要(遗忘,不再追赶) */
export const PENDING_CAP = 40
/** 相邻消息间隔超过此值 = 会话闭合 */
export const SESSION_GAP_MS = 30 * 60_000
/** 单条消息进压缩输入的截断长度 */
const TURN_TEXT_MAX = 200
const FOLDED_CAP = 500

export interface LifecycleTurn {
  id: string
  who: string
  text: string
  ts: number
}

export interface ContextLifecycleDeps {
  /** 聊天记录事实源(旧在前);默认 listChatTurns */
  listTurns?: (limit: number) => Promise<Array<{ id?: string; who: string; text: string; ts: number }>>
  /** 增量摘要(模型调用);默认 compactWarmSession(6s 超时在内部) */
  compact?: (input: { previousSummary: string; turns: Array<{ who: string; text: string }> }) => Promise<string>
  /** 经历写入 Cold(Mem0);默认 mem0Memory */
  addExperienceTurns?: (turns: Array<{ who: string; text: string; ts: number }>) => Promise<boolean>
  now?: () => number
}

export interface ContextLifecycle {
  /** 每条聊天落盘后调用(含插话);内部串行、不阻塞聊天。返回链上任务供测试 await */
  observeTurn(turn: LifecycleTurn): Promise<void>
  /** 手动冲一轮压缩(设置页/诊断用);返回本轮折叠的消息数 */
  sweep(): Promise<number>
}

/** 折叠位 key:有 id 用 id;无 id 的旧条目(插话路径)按 ts+who 稳定派生 */
function foldKey(t: { id?: string; who: string; ts: number }): string {
  return t.id || `${t.ts}:${t.who}`
}

export function createContextLifecycle(deps: ContextLifecycleDeps = {}): ContextLifecycle {
  const listTurns = deps.listTurns ?? (async (limit: number) => (await listChatTurns(limit)) as ChatLogEntry[])
  const compact = deps.compact ?? (async (input) => await compactWarmSession(input))
  const addExperienceTurns = deps.addExperienceTurns ?? ((turns) => mem0Memory.addExperienceTurns(turns))
  const nowOf = deps.now ?? (() => Date.now())

  let lastObservedTs = 0
  /** 最近已知的会话活跃时间:observeTurn 的同步判隙用(异步读档来不及);
   *  启动时从 warm.json 恢复,落盘会话时随手推进 */
  let lastActiveOfCache = 0
  void currentSession()
    .then((s) => {
      lastActiveOfCache = Math.max(lastActiveOfCache, s?.lastActiveTs ?? 0)
    })
    .catch(() => {})
  let running: Promise<void> = Promise.resolve()

  /** 当前未折叠的窗口外消息(旧在前)。折叠账本在 WarmData 全局层(跨会话/跨重启),
   *  不随会话冻结清零——否则新会话会把旧消息再折一遍 */
  async function pendingTurns(): Promise<Array<{ id?: string; who: string; text: string; ts: number }>> {
    const [all, warmData] = await Promise.all([listTurns(400), getWarmData()])
    const folded = new Set(warmData.foldedTurnIds)
    const outOfWindow = all.slice(0, Math.max(all.length - HOT_WINDOW, 0))
    return outOfWindow.filter((t) => !folded.has(foldKey(t)))
  }

  async function saveSession(session: WarmSession): Promise<void> {
    await saveCurrentSession(session)
    lastActiveOfCache = Math.max(lastActiveOfCache, session.lastActiveTs)
  }

  /** 跑一轮压缩,返回折叠数。flush=true 时无视阈值(会话闭合前的冲刷) */
  async function compactOnce(flush: boolean): Promise<number> {
    let pending = await pendingTurns()
    // 前积压超限:最旧的直接放弃(标记折叠,不进摘要——遗忘)
    const overflow = pending.length - PENDING_CAP
    const skipped = overflow > 0 ? pending.slice(0, overflow) : []
    pending = overflow > 0 ? pending.slice(overflow) : pending
    if (pending.length < (flush ? 1 : COMPACT_THRESHOLD)) {
      await markTurnsFolded(skipped.map((t) => foldKey(t)))
      return 0
    }
    const session = await ensureSession(nowOf())
    const batch = pending.slice(0, COMPACT_BATCH)
    const usable = batch
      .filter((t) => t.text.trim())
      .filter((t) => detectSensitivity(t.text) !== 'restricted')
      .map((t) => ({ who: t.who, text: t.text.slice(0, TURN_TEXT_MAX), ts: t.ts }))
    const summary = await compact({
      previousSummary: session.rollingSummary,
      turns: usable.map(({ who, text }) => ({ who, text })),
    })
    const clean = summary.trim().length > 0 && detectSensitivity(summary) !== 'restricted'
    await saveSession({
      ...session,
      // 摘要含 restricted → 丢弃新摘要(保留旧的),折叠位照常推进:这批内容被遗忘
      rollingSummary: clean ? summary.trim() : session.rollingSummary,
      foldedTurnIds: [...session.foldedTurnIds, ...batch.map((t) => foldKey(t))].slice(-FOLDED_CAP),
      // 活跃时间跟消息走,不跟墙钟走:间隙判定以最后一条观测消息为锚
      lastActiveTs: lastObservedTs || nowOf(),
    })
    // 全局账本:折叠的 + 放弃的,都不再参与后续判定
    await markTurnsFolded([...batch, ...skipped].map((t) => foldKey(t)))
    // Cold 晋级:折叠批次交 Mem0 抽取-裁决;fire-and-forget,失败不影响 Warm
    if (usable.length > 0) void addExperienceTurns(usable)
    return batch.length
  }

  /** 会话闭合:先冲 pending(一轮),再把滚动摘要冻结为集摘要 */
  async function closeSession(): Promise<void> {
    try {
      await compactOnce(true)
    } catch {
      // 冲刷失败照常冻结(fail-open)
    }
    const session = await currentSession()
    if (!session || !session.rollingSummary.trim()) return
    await freezeCurrentSession(nowOf(), detectSensitivity(session.rollingSummary) || 'normal')
  }

  return {
    observeTurn(turn) {
      const gapClosed =
        lastObservedTs > 0 && turn.ts - Math.max(lastObservedTs, lastActiveOfCache) > SESSION_GAP_MS
      lastObservedTs = turn.ts
      // 串行链:上一轮压缩未完不打断;失败吞掉,链不断
      running = running
        .then(async () => {
          if (gapClosed) await closeSession()
          await ensureSession(turn.ts)
          const pending = await pendingTurns()
          if (pending.length >= COMPACT_THRESHOLD) await compactOnce(false)
        })
        .catch(() => {})
      return running
    },

    sweep: async () => {
      let folded = 0
      // 冲到没有可折叠的为止(至多 PENDING_CAP/COMPACT_BATCH 轮,防御性上限 8)
      for (let i = 0; i < 8; i++) {
        const n = await compactOnce(true)
        folded += n
        if (n < COMPACT_BATCH) break
      }
      return folded
    },
  }
}

/** 生产单例(开关由调用方按 config.contextLifecycle 控制) */
export const contextLifecycle: ContextLifecycle = createContextLifecycle()
