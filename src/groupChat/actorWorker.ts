// 单角色 Worker · FIFO 消费循环(每角色一个实例,A/B/C 并行互不阻塞)。
//
// 状态机:idle → collecting(形成连续批次,必要时等合并窗)→ invoking(至多一个在飞请求)
// → committing(router 互斥提交)→ idle;失败 → backoff(指数退避)→ 重试;连续失败达
// 阈值 → paused(等用户新消息复位);绑定 disabled → disabled。
//
// 关键约束(验收 §16 对应):
// · 每 Worker 最多一个在飞请求;A/B/C 之间完全并行;
// · 每批最多一条公开回复(提交在 Router 临界区裁定);listen 也 ACK;
// · 用户新消息到达 → 运行时 abortActive():在飞请求作废,批次保持未 ACK,
//   下一轮 collect 的新批次自然包含那条用户消息(不破坏 FIFO);
// · 未读超过追赶阈值 → 暂停自动调用(等 catch-up),不静默丢消息;
// · 调用限流统计所有 invocation(在 Router 的 limiter 里,含 listen/失败/重试)。

import {
  ACTOR_MAX_CONSECUTIVE_FAILURES,
  INBOX_PAUSE_THRESHOLD,
  backoffDelayMs,
  chainMaySpeak,
} from './autonomyPolicy'
import { buildReactionMessages, buildReactionPrompt, type PromptBuildInput, type PromptIdentity } from './actorPrompt'
import type { ActorModelAdapter } from './adapters/types'
import type { RoomJournal } from './roomJournal'
import type { RoomRouter } from './roomRouter'
import type { ActorBatch, ActorId, ActorStatus, Clock } from './types'

const CATCHUP_RETRY_MS = 5_000

export interface ActorWorkerDeps {
  actor: ActorId
  router: RoomRouter
  journal: RoomJournal
  adapter: ActorModelAdapter
  clock: Clock
  /** 身份与人设(运行时按当前配置组装;每次取最新,改名/换人设即生效) */
  identity(): PromptIdentity
  /** 可选附加上下文(记忆事实/用户简报/工具观察块);失败不得阻塞收发 */
  prepareExtras?(batch: ActorBatch): Promise<{
    factsLine?: string
    briefLine?: string
    toolNotes?: Record<string, string>
  }>
  /** 状态/事件通知(运行时据此 emit 与诊断) */
  onEvent?(e: { type: 'status' | 'stale-drop'; actor: ActorId; status?: ActorStatus }): void
}

export interface ActorWorker {
  actor: ActorId
  wake(): void
  status(): ActorStatus
  inFlight(): boolean
  consecutiveFailures(): number
  /** 是否处于"还会动作"的状态(collecting/invoking/backoff 等待中)——静止谓词的 worker 侧 */
  busy(): boolean
  abortActive(): void
  resetFailures(): void
  dispose(): Promise<void>
}

export function createActorWorker(deps: ActorWorkerDeps): ActorWorker {
  const { actor, router, journal, adapter, clock } = deps
  let status: ActorStatus = 'idle'
  let failures = 0
  let running = false
  let wakePending = false
  let currentAbort: AbortController | null = null
  let timer: (() => void) | null = null

  function setStatus(next: ActorStatus): void {
    if (status === next) return
    status = next
    deps.onEvent?.({ type: 'status', actor, status })
  }

  function clearTimer(): void {
    if (timer) {
      timer()
      timer = null
    }
  }

  function schedule(ms: number): void {
    clearTimer()
    timer = clock.setTimeout(() => {
      timer = null
      void cycle()
    }, ms)
  }

  function maySpeakHintFor(batch: ActorBatch, now: number): { maySpeak: boolean; remaining: number | null } {
    const rootId = batch.primaryUserMessageId ?? batch.messages[0].causalRootId
    const chain = router.chainOf(rootId) ?? router.activeChain()
    if (!chain) return { maySpeak: false, remaining: null }
    const maxDepth = Math.max(...batch.messages.map((m) => m.depth))
    return {
      maySpeak: chainMaySpeak(chain, maxDepth + 1, now),
      remaining: chain.remainingPublicReplies,
    }
  }

  async function buildRequest(batch: ActorBatch) {
    const now = clock.now()
    const identity = deps.identity()
    const fullContext = adapter.prefersFullContext?.() ?? true
    let extras: { factsLine?: string; briefLine?: string; toolNotes?: Record<string, string> } = {}
    if (deps.prepareExtras) {
      try {
        extras = (await deps.prepareExtras(batch)) ?? {}
      } catch {
        extras = {}
      }
    }
    const { maySpeak, remaining } = maySpeakHintFor(batch, now)
    const input: PromptBuildInput = {
      actor,
      batch,
      recentContext: journal.list().filter((m) => m.roomSeq < batch.fromSeq),
      primaryUserMessageId: batch.primaryUserMessageId,
      maySpeak,
      remainingReplies: remaining,
      factsLine: extras.factsLine,
      briefLine: extras.briefLine,
      toolNotes: extras.toolNotes,
      fullContext,
    }
    // 网页两段式恢复的按需重建:同一输入切 fullContext/recovery 形态
    const buildFor = (mode: { fullContext: boolean; recovery: boolean }) => {
      const variant: PromptBuildInput = { ...input, fullContext: mode.fullContext, recovery: mode.recovery }
      return {
        prompt: buildReactionPrompt(identity, variant),
        messages: buildReactionMessages(identity, variant),
      }
    }
    return {
      actor,
      batch,
      maySpeak,
      fullContext,
      ...buildFor({ fullContext, recovery: false }),
      chainRootId: batch.primaryUserMessageId ?? batch.messages[0].causalRootId,
      rebuildPrompt: buildFor,
    }
  }

  async function cycle(): Promise<void> {
    if (running) {
      wakePending = true
      return
    }
    running = true
    try {
      for (;;) {
        clearTimer()
        if (router.bindingOf(actor).kind === 'disabled') {
          setStatus('disabled')
          return
        }
        if (router.isPaused()) {
          setStatus('idle')
          return
        }
        const now = clock.now()
        // 追赶阈值:暂停自动调用,等 catch-up(消息绝不丢)
        if (router.unreadCount(actor) > INBOX_PAUSE_THRESHOLD) {
          setStatus('backoff')
          schedule(CATCHUP_RETRY_MS)
          return
        }
        // 限流:统计所有 invocation;窗口内超限就等最早一条滑出
        const limiter = router.invocationLimiter()
        if (!limiter.canInvoke(actor, now)) {
          setStatus('backoff')
          schedule(limiter.retryAt(actor, now))
          return
        }
        const info = router.nextBatchInfo(actor, now)
        if (info.status === 'empty') {
          setStatus('idle')
          return
        }
        if (info.status === 'wait') {
          setStatus('collecting')
          schedule(info.waitMs)
          return
        }
        const batch = info.batch
        setStatus('collecting')
        // 取消源在构建请求前就登记:用户抢占发生在 prepareExtras/构建期间也能被打断
        currentAbort = new AbortController()
        let request
        try {
          request = await buildRequest(batch)
        } catch {
          currentAbort = null
          setStatus('idle')
          return
        }
        if (currentAbort.signal.aborted) {
          // 抢占已到:批次保持未 ACK,随新批次重新收集
          currentAbort = null
          setStatus('idle')
          return
        }
        setStatus('invoking')
        limiter.count(actor, clock.now())
        let reaction
        try {
          reaction = await adapter.react(request, currentAbort.signal)
        } catch (e) {
          currentAbort = null
          if (isAbort(e)) {
            // 用户抢占/停止:批次保持未 ACK,内容随新批次重新投递
            setStatus('idle')
            return
          }
          failures += 1
          if (failures >= ACTOR_MAX_CONSECUTIVE_FAILURES) {
            setStatus('paused')
            return
          }
          setStatus('backoff')
          schedule(backoffDelayMs(failures))
          return
        }
        currentAbort = null
        const result = await router.commitActorResult(actor, batch, reaction)
        if (result.outcome === 'invalid') {
          failures += 1
          if (failures >= ACTOR_MAX_CONSECUTIVE_FAILURES) {
            setStatus('paused')
            return
          }
          setStatus('backoff')
          schedule(backoffDelayMs(failures))
          return
        }
        failures = 0
        setStatus('idle')
        if (result.stale) deps.onEvent?.({ type: 'stale-drop', actor })
        // 自己的回复已广播给他人;若又有可执行批次(新消息并发到达)继续消费
        const again = router.nextBatchInfo(actor, clock.now())
        if (again.status === 'ready') continue
        return
      }
    } finally {
      running = false
      if (wakePending) {
        wakePending = false
        void cycle()
      }
    }
  }

  return {
    actor,
    wake() {
      void cycle()
    },
    status: () => status,
    inFlight: () => currentAbort !== null,
    consecutiveFailures: () => failures,
    busy() {
      return status === 'collecting' || status === 'invoking' || status === 'backoff'
    },
    abortActive() {
      currentAbort?.abort()
    },
    resetFailures() {
      failures = 0
    },
    async dispose() {
      clearTimer()
      currentAbort?.abort()
      await adapter.dispose?.()
    },
  }
}

function isAbort(e: unknown): boolean {
  return (
    (e instanceof Error && e.name === 'AbortError') ||
    (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError')
  )
}
