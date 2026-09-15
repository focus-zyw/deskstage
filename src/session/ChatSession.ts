// 聊天会话 · 唯一入口(主聊天框/群聊页/语音闭环共用)。内部按配置分派两代引擎:
//
// · actors(默认):GroupChatRuntime 多角色自由群聊——A/B/C 各自独立 FIFO、并行生成、
//   提交临界区统一排序;busy 退役(send 在回应期间照常受理),呈现/TTS 经
//   roomPresenter 按 roomSeq 串行消费。
// · legacy:旧单飞引擎(一次 LLM 调用生成整批台词),保一个版本的回退开关。
//
// 工具/记忆在用户入口只执行一次(评审④):openUserTurn 打开回合 → prepareMemory +
// 工具协调 → 普通结果 wake() 唤醒 Actor;clarify 由主回应人直接发一句,链挂起
// awaiting-user,不唤醒任何 Worker,用户补充后一次读完正常 ACK。
//
// 本文件不做发言决策、不碰队列与游标——那些都在 src/groupChat;呈现契约见 chatTypes。
import type { Speaker } from '../performer/player'
import { pushTurn } from '../dialogue/turnWindow'
import { appendChatTurns, type ChatMemoryRef, type ChatWho } from '../storage/chatLogStore'
import {
  emptyTurnMemory,
  prepareTurnMemory,
  type TurnMemoryContext,
} from '../storage/memoryStore'
import { memoryIngestor } from '../memory/ingestor'
import {
  DEFAULT_CONFIG,
  getConfig,
  getConfigSnapshot,
  type AppConfig,
  type GroupModelBinding,
} from '../storage/configStore'
import { peekStory, selectStoryItems } from '../storage/storyStore'
import { expressionDirector, type ExpressionTrace } from '../expression'
import { speakTracked, prefetchVoice } from '../engine/tts'
import { diag } from '../diag/store'
import { createApiActorAdapter } from '../groupChat/adapters/apiActor'
import { createWebchatActorAdapter } from '../groupChat/adapters/webchatActor'
import type { ActorModelAdapter } from '../groupChat/adapters/types'
import { createGroupChatRuntime, type GroupChatRuntime } from '../groupChat/runtime'
import { createRoomPresenter, type RoomPresenter } from '../groupChat/presenter'
import type { ActorId, ActorRuntimeState, Clock } from '../groupChat/types'
import { personaText } from '../engine/persona'
import { createLegacyChatSession, type LegacyChatSession } from './legacyChat'
import {
  GROUP_ASK_RE,
  newTurnId,
  type ChatEngineDeps,
  type ChatHostDeps,
  type SendOptions,
} from './chatTypes'

export type { SendOptions, ChatHostDeps, ChatEngineDeps } from './chatTypes'
export { chatLineHoldMs, GROUP_ASK_RE } from './chatTypes'

export type SendResult = 'accepted' | 'empty' | 'backpressure' | 'busy'

/** 快照(busy = 尚未静止,send 照常受理;catchingUp = 有角色在追赶消息) */
export interface ChatSnapshot {
  busy: boolean
  catchingUp: boolean
  actors: Record<ActorId, ActorRuntimeState>
}

export interface ChatSession {
  send(raw: string, opts?: SendOptions): Promise<SendResult>
  cancel(): void
  /** 统一清空:清 journal/队列/待播与网页会话代(legacy 模式为 no-op) */
  reset(): void
  /**
   * 启动引导:注入 chatlog 尾部历史,重启/刷新后角色接续同一会话(复用已有窗口),
   * 而不是拿空 journal 开新场(legacy 引擎为 no-op)。运行时已创建且有过消息时忽略
   * ——绝不乱序补史。
   */
  bootstrapHistory(entries: Array<{ who: ChatWho; text: string; ts: number }>): void
  getSnapshot(): ChatSnapshot
  subscribe(listener: () => void): () => void
  whenIdle(): Promise<void>
}

/** 测试/特殊宿主注入:配置来源、模型适配、时钟、现成旧会话 */
export interface ChatSessionOpts {
  clock?: Clock
  config?: () => Promise<AppConfig>
  /** 追加/覆盖角色适配(测试用假件;缺省按绑定构造 api/webchat 适配) */
  adapters?: Partial<Record<ActorId, ActorModelAdapter>>
  legacy?: LegacyChatSession
}

const emptyActors = (): Record<ActorId, ActorRuntimeState> => ({
  A: { actor: 'A', status: 'idle', queueDepth: 0, inFlight: false, ackedThrough: 0, sessionGeneration: 1, consecutiveFailures: 0 },
  B: { actor: 'B', status: 'idle', queueDepth: 0, inFlight: false, ackedThrough: 0, sessionGeneration: 1, consecutiveFailures: 0 },
  C: { actor: 'C', status: 'idle', queueDepth: 0, inFlight: false, ackedThrough: 0, sessionGeneration: 1, consecutiveFailures: 0 },
})

export function createChatSession(
  host: ChatHostDeps,
  engine: Partial<ChatEngineDeps> = {},
  opts: ChatSessionOpts = {},
): ChatSession {
  const clock: Clock = opts.clock ?? {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = window.setTimeout(fn, ms)
      return () => window.clearTimeout(id)
    },
  }
  const loadConfig = opts.config ?? getConfig

  // ---------- 共享状态 ----------
  const listeners = new Set<() => void>()
  const chainTurn = new Map<string, string>() // journal 根消息 id → chatlog turnId
  const chainReplied = new Set<string>() // 已有角色回复的因果链(整轮零回复时的兜底提示判定)
  const chainExtras = new Map<
    string,
    {
      factsLine?: string
      briefLine?: string
      toolNote?: string
      memoryRefs?: ChatMemoryRef[]
      /** 只读预选的真实旧梗候选(表达导演回收旧梗的唯一来源) */
      gags?: Array<{ id: string; text: string }>
    }
  >()
  let mode: 'actors' | 'legacy' | null = null
  let configCache: AppConfig | null = null
  let currentAbort: AbortController | null = null
  let currentTurnId: string | null = null
  let currentChannel: 'chat' | 'voice' = 'chat'
  let presenter: RoomPresenter | null = null
  let runtime: GroupChatRuntime | null = null
  let legacy: LegacyChatSession | null = null
  /** 启动引导暂存:运行时懒创建,首次创建时一次性注入(运行时已有消息则丢弃) */
  let pendingBootstrap: Array<{ author: 'user' | ActorId; text: string; ts: number }> | null = null

  function emit(): void {
    listeners.forEach((l) => l())
  }

  async function ensureConfig(): Promise<AppConfig> {
    if (!configCache) configCache = await loadConfig()
    return configCache
  }

  // ---------- 引擎分派 ----------
  function legacyOf(): LegacyChatSession {
    if (!legacy) legacy = opts.legacy ?? createLegacyChatSession(host, engine)
    return legacy
  }

  // ---------- 角色适配(绑定热切换;C 关闭只算 effective,不改写持久配置) ----------
  const effectiveBinding = (cfg: AppConfig, slot: ActorId): GroupModelBinding => {
    if (slot === 'C' && cfg.characters.C.enabled === false) return { kind: 'disabled' }
    return cfg.groupChatActors[slot].binding
  }
  const realAdapters = new Map<ActorId, { key: string; adapter: ActorModelAdapter }>()
  function resolveReal(slot: ActorId, cfg: AppConfig): ActorModelAdapter | undefined {
    const binding = effectiveBinding(cfg, slot)
    if (binding.kind === 'disabled') return undefined
    const key =
      binding.kind === 'api' ? `api:${binding.profileId ?? 'main'}` : `web:${binding.site}`
    const cur = realAdapters.get(slot)
    if (cur && cur.key === key) return cur.adapter
    const adapter =
      binding.kind === 'api'
        ? createApiActorAdapter({ profileId: binding.profileId })
        : createWebchatActorAdapter({
            actor: slot,
            site: binding.site,
            roomId: () => 'main',
            bindingRevision: () => {
              const b = configCache ? effectiveBinding(configCache, slot) : null
              return b && b.kind === 'web' ? `web:${b.site}` : 'off'
            },
          })
    realAdapters.set(slot, { key, adapter })
    return adapter
  }
  function slotAdapter(slot: ActorId): ActorModelAdapter {
    return {
      react: (req, signal) => {
        const adapter = configCache ? resolveReal(slot, configCache) : undefined
        if (!adapter) return Promise.reject(new Error(`角色 ${slot} 当前绑定不可用`))
        return adapter.react(req, signal)
      },
      prefersFullContext: () => realAdapters.get(slot)?.adapter.prefersFullContext?.() ?? true,
      invalidate: () => realAdapters.get(slot)?.adapter.invalidate?.(),
      dispose: async () => {
        await realAdapters.get(slot)?.adapter.dispose?.()
      },
    }
  }

  // ---------- 呈现管线(按 roomSeq 串行;详见 presenter.ts) ----------
  function presenterOf(): RoomPresenter {
    if (!presenter) {
      presenter = createRoomPresenter({
        clock,
        presentTurn: (item) =>
          host.presentTurn({
            speaker: item.speaker,
            text: item.text,
            holdMs: item.holdMs,
            memoryRefs: item.memoryRefs,
          }),
        speakTracked: (who, text) =>
          (engine.tts?.speakTracked ?? ((w, t) => speakTracked(w, t, undefined, currentChannel)))(who, text),
        prefetch: (who, text) => engine.tts?.prefetch?.(who, text) ?? prefetchVoice(who, text),
        onTurnSpeechStart: () => host.onTurnSpeechStart?.(),
        holdRuntime: () => runtimeOf().presentationHold(),
      })
    }
    return presenter
  }

  // ---------- 群聊运行时 ----------
  function runtimeOf(): GroupChatRuntime {
    if (runtime) return runtime
    runtime = createGroupChatRuntime({
      clock,
      config: () => {
        const cfg = configCache
        return {
          names: { A: cfg?.names.a || '甲', B: cfg?.names.b || '乙', C: cfg?.names.c || '丙' },
          userName: cfg?.userProfile.userName || '你',
          personaOf: (actor) => personaText(actor),
          actors: {
            A: cfg?.groupChatActors.A ?? DEFAULT_CONFIG.groupChatActors.A,
            B: cfg?.groupChatActors.B ?? DEFAULT_CONFIG.groupChatActors.B,
            C: cfg?.groupChatActors.C ?? DEFAULT_CONFIG.groupChatActors.C,
          },
        }
      },
      adapters: {
        A: opts.adapters?.A ?? slotAdapter('A'),
        B: opts.adapters?.B ?? slotAdapter('B'),
        C: opts.adapters?.C ?? slotAdapter('C'),
      },
      prepareExtras: async (batch) => {
        // 工具观察块/记忆事实只随"直接回应这条用户消息"的批次注入(一次执行,全员可见)
        const rootId = batch.primaryUserMessageId
        if (!rootId) return {}
        const extra = chainExtras.get(rootId)
        if (!extra) return { diagTurnId: chainTurn.get(rootId) }
        return {
          factsLine: extra.factsLine,
          briefLine: extra.briefLine,
          toolNotes: extra.toolNote ? { [rootId]: extra.toolNote } : undefined,
          gags: extra.gags,
          diagTurnId: chainTurn.get(rootId),
        }
      },
      // 表达导演(实验):每次调用取最新开关——关闭返回 undefined,worker 行为与旧版一致
      expression: () => (getConfigSnapshot().expressionV2 ? expressionDirector : undefined),
      onUserMessage: (msg, primary) => {
        // 用户消息:气泡上屏 + 短期窗口 + 落盘(entryId = 诊断轮 id)
        host.presentUser(msg.text, primary)
        pushTurn({ who: 'user', text: msg.text })
        chainTurn.set(msg.id, currentTurnId ?? newTurnId())
        void appendChatTurns([
          {
            who: 'user',
            text: msg.text,
            id: currentTurnId ?? undefined,
            ts: msg.createdAt,
            sessionId: 'group:main',
            roomSeq: msg.roomSeq,
            epoch: msg.epoch,
            causalRootId: msg.causalRootId,
          },
        ])
      },
      onCommit: (msg, meta) => {
        if (!msg) return
        // 角色回复:落盘 + 短期窗口 + 呈现队列(消费者按 roomSeq 逐项 present→TTS)
        chainReplied.add(msg.causalRootId)
        const rootTurnId = chainTurn.get(msg.causalRootId)
        pushTurn({ who: msg.author, text: msg.text })
        void appendChatTurns([
          {
            who: msg.author,
            text: msg.text,
            id: newTurnId(),
            parentTurnId: rootTurnId,
            ts: msg.createdAt,
            sessionId: 'group:main',
            roomSeq: msg.roomSeq,
            epoch: msg.epoch,
            causalRootId: msg.causalRootId,
            replyTo: msg.replyTo,
            trace: expressionTraceOf(meta),
          },
        ])
        if (currentTurnId) diag.detailText(currentTurnId, { textKind: 'reply', text: msg.text })
        presenterOf().enqueue({
          roomSeq: msg.roomSeq,
          speaker: msg.author as ActorId,
          text: msg.text,
          chainRootId: msg.causalRootId,
        })
      },
      onEvent: (e) => {
        // 转向/停止恢复 → 网页会话作废(旧页面内容不污染新批次)
        if (e.type === 'epoch' || e.type === 'paused' || e.type === 'resumed') {
          for (const slot of ['A', 'B', 'C'] as const) slotAdapter(slot).invalidate?.()
        }
      },
    })
    runtime.subscribe(emit)
    if (pendingBootstrap) {
      const entries = pendingBootstrap
      pendingBootstrap = null
      runtime.bootstrapHistory(entries)
    }
    return runtime
  }

  /** 用户画像简报行(注入角色 prompt;与主链路的 renderViewerBrief 同源信息,轻量版) */
  function briefLineOf(cfg: AppConfig): string | undefined {
    const p = cfg.userProfile
    const parts = [
      p.userName ? `使用者名字:${p.userName}` : '',
      p.occupation ? `职业:${p.occupation}` : '',
      p.likes ? `喜欢:${p.likes}` : '',
      p.dislikes ? `讨厌:${p.dislikes}` : '',
    ].filter(Boolean)
    return parts.length ? parts.join(';') : undefined
  }

  /** 旧梗候选:story.json 只读预选(selectStoryItems 同源),不写注入冷却、不烧主演出额度 */
  function gagCandidatesOf(topic: string): Array<{ id: string; text: string }> | undefined {
    try {
      const story = peekStory()
      if (!story || story.gags.length === 0) return undefined
      const picked = selectStoryItems(story, topic, 1).gags
      return picked.length > 0 ? picked.map((g) => ({ id: g.id, text: g.text })) : undefined
    } catch {
      return undefined
    }
  }

  /** 表达 trace 落盘:仅枚举与 id、无正文;调试档(memoryDisplay==='debug')才落,
   *  与 legacyChat 的 includeTrace 同款隐私闸 */
  function expressionTraceOf(meta: { expression?: ExpressionTrace } | undefined): unknown {
    const t = meta?.expression
    if (!t || getConfigSnapshot().memoryDisplay !== 'debug') return undefined
    return {
      expression: {
        id: t.id,
        move: t.move,
        stance: t.stance,
        length: t.length,
        surprise: t.surprise,
        ...(t.callbackId ? { callbackId: t.callbackId } : {}),
      },
    }
  }

  /** 后台事实提取(用户消息触发一次;所有入口共享摄取器的同一套可靠性规则:
   *  pending 账本 → 提取 → 证据校验 → 原子入库,失败记 failed 不影响聊天) */
  function backgroundFacts(text: string, turnId: string | null): void {
    void (engine.memoryIngestor ?? memoryIngestor)
      .ingestUserTurn({ turnId, text })
      .catch(() => {
        // 后台提取失败不影响聊天(摄取器内部已把账本记为 failed)
      })
  }

  return {
    async send(raw: string, opts2: SendOptions = {}): Promise<SendResult> {
      const text = raw.trim()
      if (!text) return 'empty'
      const cfg = await ensureConfig()
      // 演出中插话:与引擎无关,直走插话队列(句尾安全缝反应后接回剧情)
      if (host.isPerforming()) {
        const who = resolvePrimaryLight(text, cfg)
        host.queueInterjection(text, who)
        host.presentUser(text, null)
        host.onUserActive()
        pushTurn({ who: 'user', text })
        void appendChatTurns([{ who: 'user', text, ts: Date.now() }])
        clock.setTimeout(() => host.clearUser(text), 6000)
        return 'accepted'
      }
      if (cfg.groupChatActors.engine === 'legacy') {
        mode = 'legacy'
        return legacyOf().send(raw, opts2)
      }
      mode = 'actors'
      currentChannel = opts2.voice ? 'voice' : 'chat'
      currentAbort = new AbortController()
      const turnId = newTurnId()
      currentTurnId = turnId
      const turn = await runtimeOf().openUserTurn(text)
      if (turn.kind === 'stop') {
        // 停止词:消息已留痕并全员暂停;恢复由下一条用户消息开启
        diag.beginTurn({ id: turnId, source: opts2.voice ? 'voice' : 'chat', text, target: 'A', groupAsk: false, voice: !!opts2.voice, ts: Date.now() })
        diag.turnFinished(turnId, { outcome: 'cancelled', totalMs: 0, replyChars: 0, replySentences: 0 })
        diag.finish(turnId)
        currentTurnId = null
        clock.setTimeout(() => host.clearUser(text), 400)
        return 'accepted'
      }
      if (turn.kind !== 'open') return turn.kind
      const { primary, chainId } = turn
      diag.beginTurn({
        id: turnId,
        source: opts2.voice ? 'voice' : 'chat',
        text,
        target: primary,
        groupAsk: GROUP_ASK_RE.test(text),
        voice: !!opts2.voice,
        ts: Date.now(),
      })
      diag.detailText(turnId, { textKind: 'input', text })
      if (opts2.diagAsr) diag.asrResult(turnId, opts2.diagAsr)
      host.onUserActive()

      // —— 工具/记忆:用户入口只执行一次(评审④)——
      // 缺省走真实记忆检索(测试注入 engine.prepareMemory 覆盖)
      const memory: TurnMemoryContext =
        (await (engine.prepareMemory ?? prepareTurnMemory)({ query: text, n: 3 }).catch(() => emptyTurnMemory())) ??
        emptyTurnMemory()
      diag.memorySelection(turnId, {
        ms: 0,
        selected: memory.selected.map((s) => ({ id: s.id, score: s.score, source: s.source })),
        candidates: memory.candidates.map((c) => ({ id: c.id, score: c.score, outcome: c.outcome })),
      })
      presenterOf().setBadge(chainId, memory.refs)
      let toolNote: string | undefined
      let toolRefs: ChatMemoryRef[] = []
      if (engine.tools) {
        const prep = await engine.tools({ userText: text }, currentAbort.signal)
        if (currentAbort.signal.aborted) {
          diag.turnFinished(turnId, { outcome: 'cancelled', totalMs: Date.now(), replyChars: 0, replySentences: 0 })
          diag.finish(turnId)
          currentTurnId = null
          return 'accepted'
        }
        if (prep.clarify) {
          // clarify 短路:主回应人直接反问,链挂起等待补充,零模型调用
          // (呈现/落盘由 runtime awaitUser 的 onCommit 通道完成,这里不重复入队)
          turn.awaitUser(primary, prep.clarify)
          diag.turnFinished(turnId, { outcome: 'spoke', totalMs: Date.now(), replyChars: prep.clarify.length, replySentences: 1 })
          diag.finish(turnId)
          currentTurnId = null
          clock.setTimeout(() => host.clearUser(text), 400)
          return 'accepted'
        }
        toolNote = prep.note
        toolRefs = prep.memoryRefs ?? []
      }
      const combinedRefs = [...memory.refs, ...toolRefs.filter((r) => !memory.refs.some((x) => x.id === r.id))]
      presenterOf().setBadge(chainId, combinedRefs)
      chainExtras.set(chainId, {
        factsLine: memory.promptFacts.length ? memory.promptFacts.join(';') : undefined,
        briefLine: briefLineOf(cfg),
        toolNote,
        memoryRefs: combinedRefs,
        gags: gagCandidatesOf(text),
      })
      if (chainExtras.size > 8) {
        const oldest = chainExtras.keys().next().value
        if (oldest) chainExtras.delete(oldest)
      }
      backgroundFacts(text, turnId)
      turn.wake()
      clock.setTimeout(() => host.clearUser(text), 400)
      // 整轮零回复兜底(全员失败/全部 listen 且无 主回应人兜底):静止后给用户一句
      // 可见的失败提示,而不是无声无息——chainReplied 由 onCommit 登记
      const repliedChains = chainReplied
      void runtimeOf()
        .whenQuiescent()
        .catch(() => undefined)
        .then(() => {
          if (mode !== 'actors') return
          if (repliedChains.has(chainId)) {
            diag.turnFinished(turnId, { outcome: 'spoke', totalMs: Date.now(), replyChars: 0, replySentences: 0 })
          } else {
            host.presentFallback({ speaker: primary, text: '（这会儿信号不好,没接上…再说一遍?)' })
            diag.turnFinished(turnId, { outcome: 'failed', totalMs: Date.now(), replyChars: 0, replySentences: 0 })
          }
          diag.finish(turnId)
          if (currentTurnId === turnId) currentTurnId = null
          repliedChains.delete(chainId)
        })
      return 'accepted'
    },

    cancel(): void {
      if (mode === 'legacy') {
        legacyOf().cancel()
        return
      }
      if (mode !== 'actors') return
      currentAbort?.abort()
      if (currentTurnId) diag.cancelRequested(currentTurnId, { generation: 0, hadHandle: false, hadAbort: true })
      runtimeOf().cancel()
      presenterOf().cancel()
      currentTurnId = null
      emit()
    },

    reset(): void {
      chainTurn.clear()
      chainExtras.clear()
      currentTurnId = null
      pendingBootstrap = null
      if (mode === 'actors' && runtime) {
        presenterOf().cancel()
        runtime.reset()
      }
      emit()
    },

    bootstrapHistory(entries: Array<{ who: ChatWho; text: string; ts: number }>): void {
      const mapped = entries
        .filter((e) => e.text.trim())
        .map((e) => ({ author: e.who as 'user' | ActorId, text: e.text, ts: e.ts }))
      if (mapped.length === 0) return
      // 运行时已有消息(用户先发话说完一轮)→ 不乱序补史,本次引导放弃
      if (runtime) {
        if (runtime.journal().maxSeq() > 0) return
        runtime.bootstrapHistory(mapped)
        return
      }
      pendingBootstrap = mapped
    },

    getSnapshot(): ChatSnapshot {
      if (mode === 'legacy') {
        return { busy: legacyOf().getSnapshot().busy, catchingUp: false, actors: emptyActors() }
      }
      if (mode === 'actors' && runtime) {
        const s = runtime.getSnapshot()
        return { busy: s.busy, catchingUp: s.catchingUp, actors: s.actors }
      }
      return { busy: false, catchingUp: false, actors: emptyActors() }
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    whenIdle(): Promise<void> {
      if (mode === 'legacy') return legacyOf().whenIdle()
      if (mode === 'actors' && runtime) return runtime.whenQuiescent()
      return Promise.resolve()
    },
  }

  /** 演出插话路径的轻量 @解析(名字/甲乙丙/A B/C;无 @ 甲乙轮换语义由旧链路负责) */
  function resolvePrimaryLight(text: string, cfg: AppConfig): Speaker {
    const names = { A: cfg.names.a || '甲', B: cfg.names.b || '乙', C: cfg.names.c || '丙' }
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const targetOf: Record<string, Speaker> = { [names.A]: 'A', [names.B]: 'B', [names.C]: 'C', 甲: 'A', 乙: 'B', 丙: 'C', A: 'A', B: 'B', C: 'C' }
    const m = text.match(new RegExp(`^\\s*@?(${esc(names.A)}|${esc(names.B)}|${esc(names.C)}|甲|乙|丙|A|B|C)\\s*`))
    return m ? (targetOf[m[1]] ?? 'A') : 'A'
  }
}
