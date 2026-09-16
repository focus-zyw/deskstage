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
//
// 表达导演(可选):构建请求时经 deps.expression() 取当轮开关,对 maySpeak 批次
// 规划"怎么说"并注入 prompt;提交前跑质量闸(至多一次轻修复);提交成功后
// noteSpoken 记账。开关关闭/未注入时以上全部跳过,行为与旧版逐字节一致。

import {
  ACTOR_MAX_CONSECUTIVE_FAILURES,
  INBOX_PAUSE_THRESHOLD,
  backoffDelayMs,
  chainMaySpeak,
} from './autonomyPolicy'
import { buildReactionMessages, buildReactionPrompt, type PromptBuildInput, type PromptIdentity } from './actorPrompt'
import { REACTION_TEXT_MAX } from './actorSchema'
import { runQualityGate, type ExpressionDirector, type ExpressionPlan, type GateIssue } from '../expression'
import type { ActorModelAdapter } from './adapters/types'
import type { RoomJournal } from './roomJournal'
import type { RoomRouter } from './roomRouter'
import type { ActorBatch, ActorId, ActorStatus, Clock, RoomAuthor, RoomMessage } from './types'

export interface ActorWorkerDeps {
  actor: ActorId
  router: RoomRouter
  journal: RoomJournal
  adapter: ActorModelAdapter
  /** 语音回合的强制 API 适配器(batch.channel=voice 时取代绑定适配器;宿主按角色提供) */
  voiceAdapter?: (actor: ActorId) => ActorModelAdapter
  clock: Clock
  /** 身份与人设(运行时按当前配置组装;每次取最新,改名/换人设即生效) */
  identity(): PromptIdentity
  /** 可选附加上下文(记忆事实/用户简报/工具观察块/旧梗候选/诊断轮 id);失败不得阻塞收发 */
  prepareExtras?(batch: ActorBatch): Promise<{
    factsLine?: string
    briefLine?: string
    /** 世界注记(每用户回合一次;世界模型渲染好的情境事实) */
    worldLine?: string
    toolNotes?: Record<string, string>
    /** 只读预选的真实旧梗候选(story.json;表达导演回收旧梗的唯一来源) */
    gags?: Array<{ id: string; text: string }>
    diagTurnId?: string
  }>
  /** 表达导演(可选 provider):每次调用取最新开关;返回 undefined = 关闭,
   *  本轮行为与旧版完全一致(不规划、不注入、不过闸、不记账) */
  expression?(): ExpressionDirector | undefined
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
  // 当前批次实际生效的适配器:语音回合(batch.channel=voice)由 buildRequest 切到 voiceAdapter
  let reactAdapter = adapter
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
    // 单聊房间:1对1直答没有"额度/听权"概念,恒可说(权威裁决仍在 router 预算)
    if (deps.identity().direct) return { maySpeak: true, remaining: null }
    const rootId = batch.primaryUserMessageId ?? batch.messages[0].causalRootId
    const chain = router.chainOf(rootId) ?? router.activeChain()
    if (!chain) return { maySpeak: false, remaining: null }
    const maxDepth = Math.max(...batch.messages.map((m) => m.depth))
    return {
      maySpeak: chainMaySpeak(chain, maxDepth + 1, now),
      remaining: chain.remainingPublicReplies,
    }
  }

  /** 本轮刺激:批次主消息文本(无主消息取最新一条) */
  function stimulusOf(batch: ActorBatch): string {
    const primary = batch.primaryUserMessageId
      ? batch.messages.find((m) => m.id === batch.primaryUserMessageId)
      : undefined
    return (primary ?? batch.messages[batch.messages.length - 1])?.text ?? ''
  }

  /** 最近对话(已读尾 + 未读批次,时间序,截尾 12 条) */
  function recentFeedFor(batch: ActorBatch, readTail: RoomMessage[]): Array<{ author: RoomAuthor; text: string }> {
    return [...readTail, ...batch.messages].slice(-12).map((m) => ({ author: m.author, text: m.text }))
  }

  /** 上一条已提交回复是否在反问(连续反问禁令的输入) */
  function lastOwnReplyWasQuestion(): boolean {
    const list = journal.list()
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]!
      if (m.author === actor && m.kind === 'chat') return /[?？][\s~]*$/.test(m.text)
    }
    return false
  }

  async function buildRequest(batch: ActorBatch) {
    const now = clock.now()
    const identity = deps.identity()
    // 语音回合(batch.channel=voice)强制 API 适配器:网页链路秒级~分钟级延迟不适合语音交互
    reactAdapter = batch.channel === "voice" && deps.voiceAdapter ? deps.voiceAdapter(actor) : adapter
    const fullContext = reactAdapter.prefersFullContext?.() ?? true
    let extras: {
      factsLine?: string
      briefLine?: string
      worldLine?: string
      warmLine?: string
      experienceLine?: string
      moodLine?: string
      toolNotes?: Record<string, string>
      gags?: Array<{ id: string; text: string }>
      diagTurnId?: string
    } = {}
    if (deps.prepareExtras) {
      try {
        extras = (await deps.prepareExtras(batch)) ?? {}
      } catch {
        extras = {}
      }
    }
    const { maySpeak, remaining } = maySpeakHintFor(batch, now)
    const readTail = journal.list().filter((m) => m.roomSeq < batch.fromSeq)
    // 表达导演:仅 maySpeak 批次规划(不能越过预算强迫发言);异常由 director 内部兜底
    const director = deps.expression?.()
    let expressionPlan: ExpressionPlan | undefined
    if (director && maySpeak) {
      expressionPlan = director.plan({
        actor,
        channel: 'group-chat',
        stimulus: stimulusOf(batch),
        recent: recentFeedFor(batch, readTail),
        context: { gags: extras.gags },
        limits: {
          maySpeak,
          maxChars: REACTION_TEXT_MAX,
          mayAskQuestion: !lastOwnReplyWasQuestion(),
        },
        personaText: identity.persona,
      })
    }
    const input: PromptBuildInput = {
      actor,
      batch,
      recentContext: readTail,
      primaryUserMessageId: batch.primaryUserMessageId,
      maySpeak,
      remainingReplies: remaining,
      factsLine: extras.factsLine,
      briefLine: extras.briefLine,
      worldLine: extras.worldLine,
      warmLine: extras.warmLine,
      experienceLine: extras.experienceLine,
      moodLine: extras.moodLine,
      toolNotes: extras.toolNotes,
      expressionLine: expressionPlan?.instruction,
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
      diag: {
        turnId: extras.diagTurnId,
        attempt: failures + 1,
        queueDepth: batch.messages.length,
      },
      // 表达计划(可选):cycle 在提交前跑质量闸,提交时随 meta 穿出 trace
      ...(expressionPlan ? { expression: expressionPlan } : {}),
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
        // 追赶阈值:折叠摘要 + 显式推游标(用户消息原文进摘要,绝不丢),随后照常消费
        if (router.unreadCount(actor) > INBOX_PAUSE_THRESHOLD) {
          router.catchUpDigest(actor)
          setStatus('collecting')
          schedule(300)
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
          reaction = await reactAdapter.react(request, currentAbort.signal)
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
        // 质量闸(表达导演开启且 decision=speak 时):至多一次轻量修复,只动
        // reply.text;不可修复的问题记录后照常提交,绝不重新生成、绝不阻断
        let finalReaction = reaction
        let gateIssues: GateIssue[] = []
        const plan = request.expression
        if (plan && reaction.decision === 'speak' && reaction.reply) {
          const gate = runQualityGate(reaction.reply.text, {
            plan,
            ownRecent: journal
              .list()
              .filter((m) => m.author === actor && m.kind === 'chat')
              .slice(-6)
              .reverse()
              .map((m) => m.text),
            stimulus: stimulusOf(batch),
            bannedCatchphrase: plan.bannedCatchphrase,
          })
          gateIssues = gate.issues
          if (gate.repaired) {
            finalReaction = { ...reaction, reply: { ...reaction.reply, text: gate.text } }
          }
        }
        const result = await router.commitActorResult(
          actor,
          batch,
          finalReaction,
          plan ? { expression: plan.trace, gateIssues } : undefined,
        )
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
        // 提交成功才记账:推进回合、动作连发、旧梗/口头禅冷却(规划/重试不虚增)
        if (result.outcome === 'committed-speak' && result.reply && request.expression) {
          deps
            .expression?.()
            ?.noteSpoken({
              trace: request.expression.trace,
              text: result.reply.text,
              personaText: deps.identity().persona,
            })
        }
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
