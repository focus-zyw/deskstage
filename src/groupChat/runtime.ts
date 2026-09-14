// GroupChatRuntime · 唯一外部接口(深模块):队列、ACK、并发、恢复、预算全部隐藏在内部。
//
// 对外只有:sendUser / cancel / reset / getSnapshot / subscribe / whenQuiescent /
// presentationHold / dispose。没有导演:谁说话由各角色模型自行判断,运行时只维护
// 机械规则(排序/广播/原子提交/预算/停止)与安全不变量。
//
// 一致性语义(与 docs/自由群聊Actor系统.md 对齐):
// · busy = 尚未静止(任一 worker 仍会动作,或宿主播放闸未释放);send 在 busy 时照常受理;
// · sendUser 只有在用户消息无法进入 journal(如正在销毁)时才返回 'backpressure';
// · 停止词/ cancel() = 全员暂停 + 作废在飞;恢复永远由用户新消息开启(新 epoch);
// · 持久化定位「会话内可靠队列」:journal 是内存事实源,历史上下文经 bootstrapHistory
//   引导,重启绝不重答旧批次(游标对齐尾部)。
//
// 宿主(ChatSession 兼容壳)通过 deps 注入:配置、人设身份、模型 Adapter、
// 上下文附加(记忆/工具)、提交回调(落盘+呈现入队)。本模块不 import 任何重物。

import { createActorWorker, type ActorWorker } from './actorWorker'
import type { ActorModelAdapter } from './adapters/types'
import type { PromptIdentity } from './actorPrompt'
import {
  INBOX_PAUSE_THRESHOLD,
  closeChain,
} from './autonomyPolicy'
import { createRoomJournal, type RoomJournal } from './roomJournal'
import { createRoomRouter, type RoomRouter } from './roomRouter'
import { isDirectionChange, isStopCommand, resolvePrimary } from './userAuthority'
import type {
  ActorId,
  ActorRuntimeConfig,
  ActorRuntimeState,
  Clock,
  CommitResult,
  GroupChatSnapshot,
  RoomAuthor,
  RoomMessage,
  SendUserResult,
} from './types'

export interface GroupChatDeps {
  clock?: Clock
  config(): {
    names: Record<ActorId, string>
    userName: string
    personaOf(actor: ActorId): string
    /** 生效配置(C 关闭等在组装层算好 effectiveBinding,不回写持久配置) */
    actors: Record<ActorId, ActorRuntimeConfig>
  }
  /** 各角色模型适配;enabled 绑定但缺 Adapter 的角色不参与(等同 disabled) */
  adapters: Partial<Record<ActorId, ActorModelAdapter>>
  /** 可选:附加 prompt 上下文(记忆事实/用户简报/工具观察块) */
  prepareExtras?(batch: ActorBatchLike): Promise<{
    factsLine?: string
    briefLine?: string
    toolNotes?: Record<string, string>
  }>
  /** 提交回调:committed-speak 携带回复(宿主负责落盘+呈现入队);listen 也通知(游标推进) */
  onCommit?(msg: RoomMessage | null, meta: { actor: ActorId; result: CommitResult }): void
  /** 用户消息入列通知(宿主负责落盘+短期窗口;工具/记忆在 openUserTurn 间隙执行)。
   *  primary 为 null = 停止词分支(消息照常入列留痕,但全员暂停) */
  onUserMessage?(msg: RoomMessage, primary: ActorId | null): void
  /** 运行事件(停止/epoch/状态)诊断钩子 */
  onEvent?(e: { type: 'paused' | 'resumed' | 'epoch' | 'status' | 'stale-drop'; actor?: ActorId; detail?: string }): void
}

/** 避免把 ActorBatch 类型泄漏到宿主 deps 的别名 */
export type ActorBatchLike = import('./types').ActorBatch

export interface GroupChatRuntime {
  sendUser(text: string): Promise<SendUserResult>
  /**
   * 打开用户回合但不唤醒任何 Worker:消息入列、链建立,工具/记忆由宿主在此间隙
   * 执行一次(评审④)。普通结果调 handle.wake();工具 clarify 调 handle.awaitUser。
   */
  openUserTurn(text: string): Promise<
    | { kind: 'empty' }
    | { kind: 'backpressure' }
    | { kind: 'stop' }
    | {
        kind: 'open'
        chainId: string
        message: RoomMessage
        /** 主回应角色(@点名或甲乙轮换;宿主呈现/诊断用) */
        primary: ActorId
        /** 普通结果:唤醒全部 Actor 开始消费 */
        wake(): void
        /** 工具 clarify 短路:主回应人直接发一句反问,链挂起 awaiting-user,不唤醒 Worker */
        awaitUser(actor: ActorId, text: string): void
      }
  >
  cancel(): void
  reset(): void
  /** 启动引导:历史消息按时间序占位(context-only;各角色游标随后对齐尾部) */
  bootstrapHistory(entries: Array<{ author: RoomAuthor; text: string; ts: number }>): void
  getSnapshot(): GroupChatSnapshot
  subscribe(listener: () => void): () => void
  whenQuiescent(): Promise<void>
  /** 宿主播放管线占用闸(TTS 队列非空时持有)——静止谓词包含它 */
  presentationHold(): () => void
  journal(): RoomJournal
  dispose(): Promise<void>
}

const ids: ActorId[] = ['A', 'B', 'C']

const defaultClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  },
}

export function createGroupChatRuntime(deps: GroupChatDeps): GroupChatRuntime {
  const clock = deps.clock ?? defaultClock
  const journal = createRoomJournal(clock)
  const router: RoomRouter = createRoomRouter({
    journal,
    clock,
    configs: () => deps.config().actors,
    onCommitted: (actor, result) => {
      deps.onCommit?.(result.reply ?? null, { actor, result })
      router.trackDisabled()
      if (result.outcome === 'committed-speak') wakeAll()
      emit()
    },
  })

  const identityOf = (actor: ActorId): PromptIdentity => {
    const cfg = deps.config()
    const others = ids.filter((id) => id !== actor)
    return {
      actor,
      names: cfg.names,
      persona: cfg.personaOf(actor),
      rosterLine: others.map((id) => `${cfg.names[id]}(speaker "${id}")`).join('、'),
      userName: cfg.userName,
    }
  }

  const adapterOf = (actor: ActorId): ActorModelAdapter | undefined => {
    if (deps.config().actors[actor]?.binding.kind === 'disabled') return undefined
    return deps.adapters[actor]
  }

  /** 动态分发:worker 持有稳定引用,实际调用落到当前配置的 Adapter(绑定热切换即生效) */
  const dynamicAdapter = (actor: ActorId): ActorModelAdapter => ({
    async react(req, signal) {
      const adapter = adapterOf(actor)
      if (!adapter) throw new Error(`角色 ${actor} 当前没有可用模型适配(绑定缺失或已关闭)`)
      return adapter.react(req, signal)
    },
    prefersFullContext: () => adapterOf(actor)?.prefersFullContext?.() ?? true,
    async reset() {
      await adapterOf(actor)?.reset?.()
    },
    async dispose() {
      await adapterOf(actor)?.dispose?.()
    },
  })

  const workers = {} as Record<ActorId, ActorWorker>
  for (const id of ids) {
    workers[id] = createActorWorker({
      actor: id,
      router,
      journal,
      // 动态分发:绑定切换后无需重建 worker;disabled/缺适配的角色不会被唤醒,
      // 万一被唤醒,react 抛错走退避,不会产生任何副作用
      adapter: dynamicAdapter(id),
      clock,
      identity: () => identityOf(id),
      prepareExtras: deps.prepareExtras ? (batch) => deps.prepareExtras!(batch) : undefined,
      onEvent: (e) => {
        if (e.type === 'stale-drop') deps.onEvent?.({ type: 'stale-drop', actor: id })
        emit()
      },
    })
  }

  let rotation: Exclude<ActorId, 'C'> = 'A'
  let disposed = false
  let presentationHolds = 0
  const listeners = new Set<() => void>()
  const quiescenceWaiters: Array<() => void> = []
  /** 缓存上次 busy,避免重复通知 */
  let lastBusy: boolean | null = null

  function busy(): boolean {
    if (presentationHolds > 0) return true
    return ids.some((id) => adapterOf(id) && workers[id].busy())
  }

  function emit(): void {
    const b = busy()
    if (b !== lastBusy) {
      lastBusy = b
    }
    if (!b) {
      while (quiescenceWaiters.length) quiescenceWaiters.shift()!()
    }
    listeners.forEach((l) => l())
  }

  function wakeAll(): void {
    for (const id of ids) {
      if (adapterOf(id) && !router.isPaused()) workers[id].wake()
    }
  }

  function stopAll(reason: 'stop' | 'cancel'): void {
    router.pause()
    for (const id of ids) workers[id].abortActive()
    deps.onEvent?.({ type: 'paused', detail: reason })
    emit()
  }

  return {
    async sendUser(text: string): Promise<SendUserResult> {
      const turn = await this.openUserTurn(text)
      // stop = 停止词已受理并暂停全员:消息已入列,对调用方即 accepted
      if (turn.kind === 'stop') return 'accepted'
      if (turn.kind !== 'open') return turn.kind
      turn.wake()
      return 'accepted'
    },

    async openUserTurn(text: string) {
      const trimmed = text.trim()
      if (!trimmed) return { kind: 'empty' as const }
      if (disposed) return { kind: 'backpressure' as const }
      const cfg = deps.config()
      // 用户最高优先级 · 停止:消息照常入列留痕,但立即暂停且不唤醒任何 Worker;
      // 该消息的因果链直接关闭——恢复永远由下一条用户消息开启
      if (isStopCommand(trimmed)) {
        const { chain, message } = router.appendUser({
          text: trimmed,
          epoch: router.currentEpoch(),
          primaryActor: 'A',
          primaryAutonomy: 'quiet',
        })
        closeChain(chain)
        deps.onUserMessage?.(message, null)
        stopAll('stop')
        return { kind: 'stop' as const }
      }
      if (router.resume()) {
        // 从暂停恢复:新 epoch(失败复位对所有用户消息生效,见下)
        router.bumpEpoch()
        deps.onEvent?.({ type: 'resumed' })
      }
      // 失败复位(§13):连续失败达阈值 paused 的角色,在每条用户消息时都获得
      // 重试机会——否则一次网络抖动就让该角色沉默到下一次"停止→恢复"
      for (const id of ids) workers[id].resetFailures()
      if (isDirectionChange(trimmed)) {
        router.bumpEpoch()
        deps.onEvent?.({ type: 'epoch', detail: 'direction-change' })
      }
      const primary = resolvePrimary(trimmed, cfg.names, rotation)
      rotation = primary.rotation
      const { message, chain } = router.appendUser({
        text: trimmed,
        epoch: router.currentEpoch(),
        primaryActor: primary.actor,
        primaryAutonomy: cfg.actors[primary.actor]?.autonomy ?? 'natural',
      })
      deps.onUserMessage?.(message, primary.actor)
      emit()
      return {
        kind: 'open' as const,
        chainId: chain.rootMessageId,
        message,
        primary: primary.actor,
        wake() {
          // 用户抢占:取消所有基于旧 revision、尚未提交的角色请求(§11.1);
          // 批次保持未 ACK,重新收集的批次自然包含这条新消息,绝不重复回答
          for (const id of ids) workers[id].abortActive()
          router.trackDisabled()
          wakeAll()
          emit()
        },
        awaitUser(actor: ActorId, clarifyText: string) {
          // clarify 短路(评审④):主回应人直接发一句,链挂起 awaiting-user,
          // 不唤醒任何 Worker——不伪造"模型已收到";用户补充后新批次一次读完
          const clarify = journal.append({
            author: actor,
            kind: 'chat',
            text: clarifyText,
            epoch: router.currentEpoch(),
            causalRootId: chain.rootMessageId,
            depth: 1,
            replyTo: [message.id],
          })
          router.markAwaitingUser(chain.rootMessageId)
          deps.onCommit?.(clarify, { actor, result: { outcome: 'committed-speak', reply: clarify } })
          emit()
        },
      }
    },

    cancel(): void {
      if (disposed) return
      stopAll('cancel')
    },

    reset(): void {
      if (disposed) return
      journal.clear()
      router.reset()
      for (const id of ids) {
        workers[id].abortActive()
        workers[id].resetFailures()
      }
      emit()
    },

    bootstrapHistory(entries) {
      journal.bootstrap(entries)
      router.alignCursorsToTail()
      router.trackDisabled()
      emit()
    },

    getSnapshot(): GroupChatSnapshot {
      const actors = {} as Record<ActorId, ActorRuntimeState>
      let catchingUp = false
      for (const id of ids) {
        const w = workers[id]
        const c = router.cursors(id)
        const depth = router.unreadCount(id)
        if (depth > INBOX_PAUSE_THRESHOLD && adapterOf(id)) catchingUp = true
        actors[id] = {
          actor: id,
          status: adapterOf(id) ? w.status() : 'disabled',
          queueDepth: depth,
          inFlight: w.inFlight(),
          ackedThrough: c.ackedThrough,
          sessionGeneration: c.sessionGeneration,
          consecutiveFailures: w.consecutiveFailures(),
        }
      }
      return { busy: busy(), catchingUp, actors }
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    whenQuiescent(): Promise<void> {
      if (!busy()) return Promise.resolve()
      return new Promise((resolve) => {
        quiescenceWaiters.push(resolve)
      })
    },

    presentationHold() {
      presentationHolds += 1
      emit()
      let released = false
      return () => {
        if (released) return
        released = true
        presentationHolds -= 1
        emit()
      }
    },

    journal: () => journal,

    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      router.pause()
      for (const id of ids) {
        await workers[id].dispose().catch(() => undefined)
      }
      while (quiescenceWaiters.length) quiescenceWaiters.shift()!()
    },
  }
}
