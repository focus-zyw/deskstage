// 自主档位与防失控护栏(纯逻辑,时钟注入,零 IO)。
//
// · 因果链预算:每条用户消息开一条链,角色每条公开回复消耗一点;预算耗尽后消息仍投递、
//   仍 ACK,但请求里 maySpeak=false 只能 listen——prompt 里的 maySpeak 只是提示,
//   提交临界区的 tryConsumeReplyBudget 才是权威(防三角色并发超卖,见 roomRouter)。
// · 调用限流:统计所有 invocation(speak/listen/解析失败/重试),不只公开回复。
// · 重复护栏:归一化后与该角色近期回复重复 → 按 listen 提交(ACK 推进),不烧重试。
// · 失败退避:指数退避(1s 起步封顶 30s),连续失败达阈值角色 paused,等用户新消息复位。

import type { ActorId, AutonomyLevel } from './types'

// ---------- 预算表(评审确认档位) ----------

export const AUTONOMY_PRESETS: Record<
  AutonomyLevel,
  { maxReplies: number; maxDepth: number; durationMs: number }
> = {
  quiet: { maxReplies: 4, maxDepth: 3, durationMs: 45_000 },
  natural: { maxReplies: 12, maxDepth: 8, durationMs: 120_000 },
  lively: { maxReplies: 30, maxDepth: 16, durationMs: 300_000 },
}

/** 因果链运行态:由 roomRouter 持有,预算扣减只在提交临界区内发生 */
export interface ConversationChainState {
  rootMessageId: string
  epoch: number
  remainingPublicReplies: number
  maxDepth: number
  expiresAt: number
  status: 'open' | 'awaiting-user' | 'closed'
}

export function createConversationChain(
  rootMessageId: string,
  epoch: number,
  level: AutonomyLevel,
  now: number,
): ConversationChainState {
  const preset = AUTONOMY_PRESETS[level]
  return {
    rootMessageId,
    epoch,
    remainingPublicReplies: preset.maxReplies,
    maxDepth: preset.maxDepth,
    expiresAt: now + preset.durationMs,
    status: 'open',
  }
}

/** 该链是否还允许发言(深度按"将产生的回复深度"校验)。不扣减——扣减是提交期的原子动作 */
export function chainMaySpeak(chain: ConversationChainState, replyDepth: number, now: number): boolean {
  if (chain.status !== 'open') return false
  if (now >= chain.expiresAt) return false
  if (chain.remainingPublicReplies <= 0) return false
  return replyDepth <= chain.maxDepth
}

/** 消耗一点回复预算(提交临界区内调用,互斥保证原子) */
export function consumeChainReply(chain: ConversationChainState): void {
  chain.remainingPublicReplies -= 1
}

export function closeChain(chain: ConversationChainState): void {
  chain.status = 'closed'
}

// ---------- 调用限流(统计所有 invocation,滑动 60s 窗口) ----------

export const ACTOR_MAX_INVOCATIONS_PER_MIN = 12

export interface InvocationLimiter {
  count(actor: ActorId, now: number): void
  canInvoke(actor: ActorId, now: number): boolean
  /** 该角色何时恢复可调用(0 = 现在);backoff 定时用 */
  retryAt(actor: ActorId, now: number): number
  clear(): void
}

export function createInvocationLimiter(
  maxPerMin = ACTOR_MAX_INVOCATIONS_PER_MIN,
): InvocationLimiter {
  const WINDOW_MS = 60_000
  const hits: Record<ActorId, number[]> = { A: [], B: [], C: [] }
  const prune = (actor: ActorId, now: number) => {
    hits[actor] = hits[actor].filter((t) => now - t < WINDOW_MS)
  }
  return {
    count(actor, now) {
      prune(actor, now)
      hits[actor].push(now)
    },
    canInvoke(actor, now) {
      prune(actor, now)
      return hits[actor].length < maxPerMin
    },
    retryAt(actor, now) {
      prune(actor, now)
      if (hits[actor].length < maxPerMin) return 0
      const oldest = hits[actor][0]
      return Math.max(250, WINDOW_MS - (now - oldest))
    },
    clear() {
      hits.A = []
      hits.B = []
      hits.C = []
    },
  }
}

// ---------- 重复护栏 ----------

export const DUPLICATE_WINDOW = 6

/** 归一化(与 relaySchema.normalizeRelayText 同思路):去标点空白、小写 */
export function normalizeForDuplicate(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s,，。、!！?？.。;；~～'"「」『』《》（）()——…·-]/g, '')
}

/** 与该角色近期回复(窗口内)重复判定 */
export function isDuplicateReply(recentNormalized: string[], text: string): boolean {
  const t = normalizeForDuplicate(text)
  if (!t) return true
  return recentNormalized.slice(-DUPLICATE_WINDOW).includes(t)
}

// ---------- 失败退避 ----------

export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_MAX_MS = 30_000
export const ACTOR_MAX_CONSECUTIVE_FAILURES = 4

/** 第 n 次连续失败的退避时长(1s→2s→4s→…封顶 30s) */
export function backoffDelayMs(consecutiveFailures: number): number {
  const exp = BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1)
  return Math.min(BACKOFF_MAX_MS, exp)
}

// ---------- 批次与队列参数 ----------

export const BATCH_MAX_MESSAGES = 12
export const BATCH_MAX_CHARS = 4_000
/** 并发消息合并等待窗:用户消息到达跳过等待立即抢占 */
export const MERGE_WAIT_MS = 200
/** 未读超过该值暂停该角色自动调用(等 catch-up 摘要),UI 显示「正在追赶」 */
export const INBOX_PAUSE_THRESHOLD = 100
