// RoomRouter · 机械规则中枢:排序、扇出、原子提交、epoch/停止。
// 没有发言者决策——谁说话由各角色模型自行判断(speak/listen),这里只做可靠消息机制:
//
// · nextBatchInfo:按各角色 ackedThrough 取未读 FIFO 连续前缀(≤12 条/4000 字符),
//   新到消息在合并等待窗内且批内无用户消息时返回 wait(用户消息立即抢占);
// · commitActorResult:提交临界区(互斥队列串行)。顺序:
//   ① validateActorReaction(batch, reaction)——协议/ACK/replyTo 任一非法 = invalid 不 ACK;
//   ② 停止态或旧 epoch → 降级 listen(ACK 推进,回复丢弃;网页角色由调用方排队重建会话);
//   ③ 重复文本 → 降级 listen;
//   ④ speak → tryConsumeReplyBudget 原子扣减(权威检查,输家降级 listen);
//   ⑤ 通过 → 分配 roomSeq 落 journal → 游标推进到 batch.throughSeq → 返回回复。
//   listen 与一切降级 listen 都 ACK(FIFO 只进不退);仅 invalid 不 ACK。
//
// 预算语义:每条用户消息开一条链(档位取主回应角色的 autonomy);并发争抢最后一点预算
// 在互斥区内 check-then-consume,最多一条公开回复成功。

import {
  BATCH_MAX_CHARS,
  BATCH_MAX_MESSAGES,
  INBOX_PAUSE_THRESHOLD,
  MERGE_WAIT_MS,
  closeChain,
  consumeChainReply,
  createConversationChain,
  createInvocationLimiter,
  isDuplicateReply,
  chainMaySpeak,
  normalizeForDuplicate,
  type ConversationChainState,
  type InvocationLimiter,
} from './autonomyPolicy'
import { validateActorReaction } from './actorSchema'
import type {
  ActorBatch,
  ActorId,
  ActorReaction,
  ActorRuntimeConfig,
  AutonomyLevel,
  Clock,
  CommitResult,
  ModelBinding,
  RoomMessage,
} from './types'
import type { RoomJournal } from './roomJournal'

export interface ActorCursors {
  ackedThrough: number
  deliveredThrough: number
  sessionGeneration: number
}

export type NextBatchInfo =
  | { status: 'ready'; batch: ActorBatch }
  | { status: 'wait'; waitMs: number }
  | { status: 'empty' }

export interface RoomRouter {
  /** 启动/重置后调用:游标对齐日志尾部(重启绝不重答旧批次) */
  alignCursorsToTail(): void
  /** disabled 角色游标跟尾:不参与期间的消息视为已读,重新启用后不洪水式补答 */
  trackDisabled(): void
  reset(): void

  /** 用户消息入列:关旧链、开新链(档位=主回应角色),返回消息与链 */
  appendUser(input: {
    text: string
    epoch: number
    primaryActor: ActorId
    primaryAutonomy: AutonomyLevel
  }): { message: RoomMessage; chain: ConversationChainState }
  /**
   * 追赶摘要(§13):未读超过阈值时调用。把积压折叠成一条 control 摘要消息——
   * 用户消息逐条原文进入摘要(绝不丢弃),角色消息只计条数;显式推游标越过历史,
   * 摘要本身保持未读,随下一批正常投递与 ACK。返回 false = 未达阈值。
   */
  catchUpDigest(actor: ActorId): boolean
  /** 角色回复在临界区内入列;仅 roomRouter.commitActorResult 可调 */
  appendReplyDirect(reply: RoomMessage): void

  nextBatchInfo(actor: ActorId, now: number): NextBatchInfo
  unreadCount(actor: ActorId): number
  unreadOverThreshold(actor: ActorId): boolean
  anyUnread(): boolean

  commitActorResult(actor: ActorId, batch: ActorBatch, reaction: ActorReaction): Promise<CommitResult>

  /** 当前活跃链(最新用户消息的因果链;供 maySpeak 提示与 clarify 语义) */
  activeChain(): ConversationChainState | null
  chainOf(rootMessageId: string): ConversationChainState | null
  markAwaitingUser(rootMessageId: string): void

  bumpEpoch(): number
  currentEpoch(): number
  pause(): void
  resume(): boolean
  isPaused(): boolean

  cursors(actor: ActorId): ActorCursors
  setSessionGeneration(actor: ActorId, gen: number): void
  invocationLimiter(): InvocationLimiter
  recentReplies(actor: ActorId): string[]
  /** 生效绑定(disabled 判定、诊断快照用) */
  bindingOf(actor: ActorId): ModelBinding
}

export interface RoomRouterOpts {
  journal: RoomJournal
  clock: Clock
  /** 各角色生效配置(binding.kind==='disabled' 的角色仍保持游标对齐,只是不生成) */
  configs(): Record<ActorId, ActorRuntimeConfig>
  /** 提交完成通知(临界区内串行触发;speak 携带 reply,listen 也通知游标推进) */
  onCommitted?(actor: ActorId, result: CommitResult): void
}

export function createRoomRouter(opts: RoomRouterOpts): RoomRouter {
  const { journal, clock } = opts
  const ids: ActorId[] = ['A', 'B', 'C']

  const cursorsBy: Record<ActorId, ActorCursors> = {
    A: { ackedThrough: 0, deliveredThrough: 0, sessionGeneration: 1 },
    B: { ackedThrough: 0, deliveredThrough: 0, sessionGeneration: 1 },
    C: { ackedThrough: 0, deliveredThrough: 0, sessionGeneration: 1 },
  }
  let chains = new Map<string, ConversationChainState>()
  let epoch = 0
  let paused = false
  const recentBy: Record<ActorId, string[]> = { A: [], B: [], C: [] }
  const limiter = createInvocationLimiter()
  // 提交互斥:并发完成的回复在此串行,roomSeq 唯一且全员可见顺序一致(评审⑤)
  let commitTail: Promise<unknown> = Promise.resolve()

  const effectiveBindingOf = (actor: ActorId): ModelBinding => opts.configs()[actor].binding

  function visibleFor(actor: ActorId, seq: number): RoomMessage[] {
    return journal
      .after(seq)
      .filter((m) => m.author !== actor)
  }

  function unreadCountOf(actor: ActorId): number {
    return visibleFor(actor, cursorsBy[actor].ackedThrough).length
  }

  function nextBatchInfo(actor: ActorId, now: number): NextBatchInfo {
    const cursor = cursorsBy[actor]
    const unread = visibleFor(actor, cursor.ackedThrough)
    if (unread.length === 0) return { status: 'empty' }
    const hasUser = unread.some((m) => m.author === 'user')
    if (!hasUser) {
      const newestAge = now - unread[unread.length - 1].createdAt
      if (newestAge < MERGE_WAIT_MS) {
        return { status: 'wait', waitMs: Math.max(1, MERGE_WAIT_MS - newestAge) }
      }
    }
    // 连续前缀 + 上限截断(条数/字符双限,永不跳过中间消息)
    const picked: RoomMessage[] = []
    let chars = 0
    for (const m of unread) {
      if (picked.length >= BATCH_MAX_MESSAGES) break
      if (picked.length > 0 && chars + m.text.length > BATCH_MAX_CHARS) break
      picked.push(m)
      chars += m.text.length
    }
    if (picked.length === 0) return { status: 'empty' }
    const fromSeq = picked[0].roomSeq
    const throughSeq = picked[picked.length - 1].roomSeq
    const primary = [...picked].reverse().find((m) => m.author === 'user')
    const batch: ActorBatch = {
      id: `${actor}-${fromSeq}-${throughSeq}`,
      actor,
      fromSeq,
      throughSeq,
      messages: picked,
      primaryUserMessageId: primary?.id,
      epoch,
      inputHash: hashOf(picked.map((m) => `${m.id}:${m.author}:${m.text}`).join('\n')),
    }
    cursor.deliveredThrough = throughSeq
    return { status: 'ready', batch }
  }

  function commitOne(actor: ActorId, batch: ActorBatch, reaction: ActorReaction): CommitResult {
    const now = clock.now()
    if (!validateActorReaction(batch, reaction)) {
      return { outcome: 'invalid' }
    }
    const finishListen = (stale: boolean): CommitResult => {
      cursorsBy[actor].ackedThrough = batch.throughSeq
      return { outcome: 'committed-listen', stale }
    }
    // 停止态:在飞结果一律按 listen 收尾(不阻塞游标,也不再发声)
    if (paused) return finishListen(false)
    // 旧 epoch:迟到回复降级丢弃(I6);调用方据此排队重建网页会话
    if (batch.epoch !== epoch) return finishListen(true)
    // 深度与预算(权威检查):链缺失/关闭/过期/超深/抢空 → listen
    let rootId = batch.primaryUserMessageId
    if (!rootId) {
      const withRoot = batch.messages.find((m) => chains.has(m.causalRootId))
      rootId = withRoot ? withRoot.causalRootId : batch.messages[0].causalRootId
    }
    const chain = chains.get(rootId)
    if (reaction.decision === 'speak' && reaction.reply) {
      if (isDuplicateReply(recentBy[actor], reaction.reply.text)) {
        return finishListen(false)
      }
      const maxBatchDepth = Math.max(...batch.messages.map((m) => m.depth))
      if (!chain || !chainMaySpeak(chain, maxBatchDepth + 1, now)) {
        return finishListen(false)
      }
      consumeChainReply(chain)
      const reply = journal.append({
        author: actor,
        kind: 'chat',
        text: reaction.reply.text,
        epoch,
        causalRootId: chain.rootMessageId,
        depth: maxBatchDepth + 1,
        replyTo: reaction.reply.replyTo,
      })
      recentBy[actor].push(normalizeForDuplicate(reaction.reply.text))
      if (recentBy[actor].length > 12) recentBy[actor].shift()
      cursorsBy[actor].ackedThrough = batch.throughSeq
      return { outcome: 'committed-speak', reply }
    }
    return finishListen(false)
  }

  return {
    alignCursorsToTail() {
      const tail = journal.maxSeq()
      for (const id of ids) {
        cursorsBy[id].ackedThrough = tail
        cursorsBy[id].deliveredThrough = tail
      }
    },

    trackDisabled() {
      const tail = journal.maxSeq()
      for (const id of ids) {
        if (opts.configs()[id].binding.kind !== 'disabled') continue
        cursorsBy[id].ackedThrough = tail
        cursorsBy[id].deliveredThrough = tail
      }
    },

    reset() {
      chains = new Map()
      epoch = 0
      paused = false
      recentBy.A = []
      recentBy.B = []
      recentBy.C = []
      limiter.clear()
      for (const id of ids) {
        cursorsBy[id].ackedThrough = 0
        cursorsBy[id].deliveredThrough = 0
        cursorsBy[id].sessionGeneration += 1
      }
    },

    appendUser(input) {
      // 新用户消息关闭所有未决链(旧因果链不跨越新用户转向)
      for (const c of chains.values()) {
        if (c.status === 'open' || c.status === 'awaiting-user') closeChain(c)
      }
      const message = journal.append({
        author: 'user',
        kind: 'chat',
        text: input.text,
        epoch: input.epoch,
        causalRootId: '',
        depth: 0,
        replyTo: [],
      })
      message.causalRootId = message.id
      const chain = createConversationChain(message.id, input.epoch, input.primaryAutonomy, clock.now())
      chains.set(message.id, chain)
      pruneChains(chains)
      return { message, chain }
    },

    catchUpDigest(actor: ActorId): boolean {
      const unread = visibleFor(actor, cursorsBy[actor].ackedThrough)
      if (unread.length <= INBOX_PAUSE_THRESHOLD) return false
      const userMsgs = unread.filter((m) => m.author === 'user' && m.kind === 'chat')
      const lines = userMsgs
        .slice(-10)
        .map((m) => `- ${m.text.slice(0, 60)}`)
      const digest = journal.append({
        author: 'user',
        kind: 'control',
        text: `【系统摘要】你离开期间群聊累计了 ${unread.length} 条消息(其中用户消息 ${userMsgs.length} 条,原文如下;其余为角色发言,只作背景):\n${lines.join('\n') || '(无)'}`,
        epoch,
        causalRootId: userMsgs[userMsgs.length - 1]?.id ?? '',
        depth: 0,
        replyTo: [],
      })
      // 显式 catch-up:推游标越过被摘要的历史;摘要本身仍未读,随下一批投递
      cursorsBy[actor].ackedThrough = digest.roomSeq - 1
      return true
    },

    appendReplyDirect(reply: RoomMessage) {
      journal.append({
        author: reply.author,
        kind: 'chat',
        text: reply.text,
        epoch: reply.epoch,
        causalRootId: reply.causalRootId,
        depth: reply.depth,
        replyTo: reply.replyTo,
      })
    },

    nextBatchInfo,
    unreadCount: unreadCountOf,
    unreadOverThreshold(actor) {
      return unreadCountOf(actor) > INBOX_PAUSE_THRESHOLD
    },
    anyUnread() {
      return ids.some((id) => effectiveBindingOf(id).kind !== 'disabled' && unreadCountOf(id) > 0)
    },

    async commitActorResult(actor, batch, reaction) {
      const run = commitTail.then(() => {
        const result = commitOne(actor, batch, reaction)
        if (result.outcome !== 'invalid') opts.onCommitted?.(actor, result)
        return result
      })
      commitTail = run.catch(() => undefined)
      return run
    },

    activeChain() {
      let latest: ConversationChainState | null = null
      for (const c of chains.values()) {
        if (c.status === 'open') latest = c
      }
      return latest
    },
    chainOf(rootMessageId) {
      return chains.get(rootMessageId) ?? null
    },
    markAwaitingUser(rootMessageId) {
      const c = chains.get(rootMessageId)
      if (c && c.status === 'open') c.status = 'awaiting-user'
    },

    bumpEpoch() {
      epoch += 1
      return epoch
    },
    currentEpoch: () => epoch,
    pause() {
      paused = true
    },
    resume() {
      const was = paused
      paused = false
      return was
    },
    isPaused: () => paused,

    cursors: (actor) => cursorsBy[actor],
    setSessionGeneration(actor, gen) {
      cursorsBy[actor].sessionGeneration = gen
    },
    invocationLimiter: () => limiter,
    recentReplies: (actor) => recentBy[actor],
    bindingOf: (actor) => effectiveBindingOf(actor),
  }
}

/** 链表修剪:超过 24 条时原地删最旧的,防长会话无限增长(closed/过期链无后续消费) */
function pruneChains(chains: Map<string, ConversationChainState>): void {
  if (chains.size <= 24) return
  const drop = chains.size - 12
  let removed = 0
  for (const key of chains.keys()) {
    if (removed >= drop) break
    chains.delete(key)
    removed += 1
  }
}

/** FNV-1a 内容指纹(批次 inputHash;诊断辅助,非安全用途) */
function hashOf(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
