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
import {
  appendChatTurns,
  directSessionId,
  GROUP_SESSION_ID,
  type ChatMemoryRef,
  type ChatWho,
} from '../storage/chatLogStore'
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
import { expressionDirector, type ExpressionTrace } from '../expression'
import { speakTracked, prefetchVoice } from '../engine/tts'
import { diag, type DiagRef } from '../diag/store'
import { createApiActorAdapter } from '../groupChat/adapters/apiActor'
import type { ActorModelAdapter } from '../groupChat/adapters/types'
import { createGroupChatRuntime, type GroupChatRuntime } from '../groupChat/runtime'
import { createRoomPresenter, type RoomPresenter } from '../groupChat/presenter'
import type { ActorId, ActorRuntimeState, Clock } from '../groupChat/types'
import { personaText } from '../engine/persona'
import { moodHintLine } from '../engine/moodState'
import { moodDeltaOfAction } from '../engine/moodTag'
import { WEB_SEARCH_LINE, webSearchOnOf } from '../engine/webSearch'
import { applyMoodDeltas, getMoods } from '../storage/moodStore'
import { contextAssembler } from '../context/assembler'
import { contextLifecycle } from '../context/lifecycle'
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
  /** 房间:缺省 = 群聊唯一房间(group:main);direct = 单角色单聊房间(direct:<slot>) */
  room?: { kind: 'direct'; slot: ActorId }
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
  // 房间:group:main(唯一群聊)/ direct:<slot>(每角色一个单聊房间)。
  // 单聊 = 面板模式呈现(不弹舞台气泡/不 TTS)+ prompt 直答形态 + 仅该角色参与
  const room = opts.room
  const directMode = room?.kind === 'direct'
  const roomSessionId = room ? directSessionId(room.slot) : GROUP_SESSION_ID

  // ---------- 共享状态 ----------
  const listeners = new Set<() => void>()
  const chainTurn = new Map<string, string>() // journal 根消息 id → chatlog turnId
  const chainReplied = new Set<string>() // 已有角色回复的因果链(整轮零回复时的兜底提示判定)
  const chainExtras = new Map<
    string,
    {
      factsLine?: string
      briefLine?: string
      /** 世界注记(每用户回合算一次;世界模型渲染好的情境事实) */
      worldLine?: string
      /** Warm 滚动摘要+历史集摘要(上下文生命周期开启时) */
      warmLine?: string
      /** Mem0 经历检索行(上下文生命周期开启时) */
      experienceLine?: string
      /** 心情余波单行(上下文生命周期开启时;补齐群聊链路的 hot 心情注入) */
      moodLine?: string
      /** 联网使用规则行(联网开关开 + 主模型档案;与网关工具注入同谓词门控) */
      webLine?: string
      toolNote?: string
      memoryRefs?: ChatMemoryRef[]
      /** 只读预选的真实旧梗候选(表达导演回收旧梗的唯一来源) */
      gags?: Array<{ id: string; text: string }>
    }
  >()
  /** 当前回合的 TTS 诊断引用(presenter 逐句播报递增 seg;回合切换自动重置) */
  let ttsDiag: { turnId: string; seg: number } | null = null
  /** 每回合回复量统计(onCommit 逐条累加;静止收尾随 turnFinished 上报后清除) */
  const replyStats = new Map<string, { chars: number; sentences: number }>()
  /** TTS 诊断引用:同一回合内 seg 递增,跨回合重置;无在飞回合不发 */
  function ttsDiagRefOf(): DiagRef | undefined {
    if (!currentTurnId) return undefined
    if (!ttsDiag || ttsDiag.turnId !== currentTurnId) ttsDiag = { turnId: currentTurnId, seg: 0 }
    const ref: DiagRef = { turnId: ttsDiag.turnId, segIndex: ttsDiag.seg }
    ttsDiag.seg += 1
    return ref
  }
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
    // 每次 send 重读(不再长缓存):configStore 的 cache 是 Promise 且在
    // config-changed 时整体替换;这里若锁一份旧快照,resolveReal 的 key 比对
    // 与 bindingRevision 指纹将永远看不到设置页改过的绑定,热切换形同虚设。
    // 读取失败让本次 send 抛出(与原行为一致),configCache 保留上次好值供同步读
    const cfg = await loadConfig()
    configCache = cfg
    return cfg
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
  // 语音回复统一走 API(产品裁决):API 绑定沿用各自档案,网页绑定回落主档案
  const voiceAdapters = new Map<string, ActorModelAdapter>()
  const voiceAdapterFor = (slot: ActorId): ActorModelAdapter => {
    const cfg = configCache ?? getConfigSnapshot()
    const binding = effectiveBinding(cfg, slot)
    const profileId = binding.kind === 'api' ? binding.profileId : undefined
    const key = `api:${profileId ?? 'main'}`
    const hit = voiceAdapters.get(key)
    if (hit) return hit
    const adapter = createApiActorAdapter({ profileId })
    voiceAdapters.set(key, adapter)
    return adapter
  }
  function resolveReal(slot: ActorId, cfg: AppConfig): ActorModelAdapter | undefined {
    const binding = effectiveBinding(cfg, slot)
    if (binding.kind === 'disabled') return undefined
    const key =
      `api:${binding.profileId ?? 'main'}`
    const cur = realAdapters.get(slot)
    if (cur && cur.key === key) return cur.adapter
    // 换绑:立即释放旧适配器持有的网页会话(旧键标签页当场回收,
    // 不必等 Rust 侧 30 分钟闲置清扫);在飞 ask 由 release 的 key_lock 排队收尾
    void cur?.adapter.dispose?.()
    const adapter = createApiActorAdapter({
      profileId: binding.kind === 'api' ? binding.profileId : undefined,
      protocol: directMode ? 'plain' : 'schema',
      // 联网搜索仅主模型档案生效(自定义档案/中转端点按 host 判定不可靠,v1 不开);
      // getter 每次调用取最新配置,开关热生效,无需重建 adapter
      ...(binding.kind === 'api' && !binding.profileId
        ? { webSearch: () => webSearchOnOf(getConfigSnapshot()) }
        : {}),
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
        // 单聊房间 = 面板模式:回复只在聊天面板内渲染,不弹舞台气泡、不朗读;
        // 情绪动作仍要可见——presentMood 让角色做个表情一拍(无文字无声音,不抢戏)
        presentTurn: room
          ? (item) => {
              if (item.action && item.action !== 'talk') host.presentMood?.(item.speaker, item.action)
            }
          : (item) =>
              host.presentTurn({
                speaker: item.speaker,
                text: item.text,
                holdMs: item.holdMs,
                memoryRefs: item.memoryRefs,
                action: item.action,
              }),
        speakTracked: room
          ? () => ({ started: Promise.resolve('silent' as const), ended: Promise.resolve(), stop: () => {} })
          : (who, text) =>
              (engine.tts?.speakTracked ??
                ((w, t, d) => speakTracked(w, t, undefined, currentChannel, d)))(who, text, ttsDiagRefOf()),
        prefetch: room ? () => {} : (who, text) => engine.tts?.prefetch?.(who, text) ?? prefetchVoice(who, text),
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
        const actors = {
          A: cfg?.groupChatActors.A ?? DEFAULT_CONFIG.groupChatActors.A,
          B: cfg?.groupChatActors.B ?? DEFAULT_CONFIG.groupChatActors.B,
          C: cfg?.groupChatActors.C ?? DEFAULT_CONFIG.groupChatActors.C,
        }
        // 单聊房间:只有房主角色参与,其余一律 disabled(游标跟尾,不参与不补答)
        if (room) {
          for (const id of ['A', 'B', 'C'] as const) {
            if (id !== room.slot) actors[id] = { ...actors[id], binding: { kind: 'disabled' } }
          }
        }
        return {
          names: { A: cfg?.names.a || '甲', B: cfg?.names.b || '乙', C: cfg?.names.c || '丙' },
          userName: cfg?.userProfile.userName || '你',
          personaOf: (actor) => personaText(actor),
          actors,
        }
      },
      direct: directMode,
      adapters: {
        A: opts.adapters?.A ?? slotAdapter('A'),
        B: opts.adapters?.B ?? slotAdapter('B'),
        C: opts.adapters?.C ?? slotAdapter('C'),
      },
      voiceAdapter: (slot) => voiceAdapterFor(slot),
      prepareExtras: async (batch) => {
        // 工具观察块/记忆事实只随"直接回应这条用户消息"的批次注入(一次执行,全员可见)
        const rootId = batch.primaryUserMessageId
        if (!rootId) return {}
        const extra = chainExtras.get(rootId)
        if (!extra) return { diagTurnId: chainTurn.get(rootId) }
        return {
          factsLine: extra.factsLine,
          briefLine: extra.briefLine,
          worldLine: extra.worldLine,
          warmLine: extra.warmLine,
          experienceLine: extra.experienceLine,
          moodLine: extra.moodLine,
          webLine: extra.webLine,
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
            sessionId: roomSessionId,
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
        // 回复量统计:诊断回合的 replyChars/replySentences(静止收尾统一上报)
        if (rootTurnId) {
          const stat = replyStats.get(rootTurnId) ?? { chars: 0, sentences: 0 }
          stat.chars += msg.text.length
          stat.sentences += 1
          replyStats.set(rootTurnId, stat)
        }
        pushTurn({ who: msg.author, text: msg.text })
        void appendChatTurns([
          {
            who: msg.author,
            text: msg.text,
            id: newTurnId(),
            parentTurnId: rootTurnId,
            ts: msg.createdAt,
            sessionId: roomSessionId,
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
          action: meta?.action,
        })
        // 情绪余波闭环:带情绪动作的回复按词表小额入账 moodState(无标签不漂移;
        // 单笔钳 MAX_EVENT_DELTA,读时惰性衰减),待机染色与下轮心情提示自动接上
        const moodDelta = moodDeltaOfAction(meta?.action)
        if (moodDelta && (msg.author === 'A' || msg.author === 'B' || msg.author === 'C')) {
          void applyMoodDeltas([
            { who: msg.author, ...moodDelta, cause: '聊天中流露的情绪' },
          ]).catch(() => {})
        }
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
   *  pending 账本 → 提取 → 证据校验 → 原子入库,失败记 failed 不影响聊天)。
   *  诊断:摄取报告本就带 id 级决策,在这里落到会话(新管线不丢「为什么记错」的证据) */
  function backgroundFacts(text: string, turnId: string | null): void {
    const t0 = Date.now()
    void (engine.memoryIngestor ?? memoryIngestor)
      .ingestUserTurn({ turnId, text })
      .then((report) => {
        if (!turnId) return
        diag.memoryWrite(turnId, {
          candidates: report.candidateCount,
          changed: report.appliedFactIds.length,
          addedIds: report.appliedFactIds,
          supersededIds: report.supersededFactIds,
          rejected: report.rejected,
          ms: Date.now() - t0,
          ...(report.status === 'failed' ? { error: report.reason } : {}),
        })
      })
      .catch(() => {
        // 后台提取失败不影响聊天(摄取器内部已把账本记为 failed)
      })
  }

  /** 心情余波单行(hot 层;上下文生命周期开启时补齐群聊链路的心情注入) */
  async function moodLineOf(): Promise<string | undefined> {
    try {
      return moodHintLine(await getMoods(), ['A', 'B', 'C']) || undefined
    } catch {
      return undefined
    }
  }

  /** 上下文生命周期注入行(Warm 摘要/Mem0 经历/心情;开关关闭时全 undefined) */
  async function lifecycleLinesOf(text: string): Promise<{ warmLine?: string; experienceLine?: string; moodLine?: string }> {
    if (configCache?.contextLifecycle !== true) return {}
    const [warmLine, experienceLine, moodLine] = await Promise.all([
      contextAssembler.warmLine(text).catch(() => undefined),
      contextAssembler.experienceLine(text).catch(() => undefined),
      moodLineOf(),
    ])
    return { warmLine, experienceLine, moodLine }
  }

  /** 落盘后挂生命周期记账(观察 chatlog;失败不影响聊天;开关关闭 no-op) */
  function observeTurnSafe(turnId: string | null, text: string, ts: number): void {
    if (configCache?.contextLifecycle !== true) return
    void contextLifecycle.observeTurn({ id: turnId ?? '', who: 'user', text, ts }).catch(() => {})
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
        observeTurnSafe(null, text, Date.now())
        clock.setTimeout(() => host.clearUser(text), 6000)
        return 'accepted'
      }
      if (cfg.groupChatActors.engine === 'legacy' && !directMode) {
        mode = 'legacy'
        return legacyOf().send(raw, opts2)
      }
      mode = 'actors'
      currentChannel = opts2.voice ? 'voice' : 'chat'
      currentAbort = new AbortController()
      const turnId = newTurnId()
      // 诊断总耗时的起点(turnId 创建即受理;停止词/取消/兜底各出口统一减它)
      const turnStartedAt = Date.now()
      currentTurnId = turnId
      // 语音来源随 turn 标记进 room:含该消息的批次 channel=voice,回复强制走 API
      const turn = await runtimeOf().openUserTurn(text, { voice: opts2.voice === true })
      if (turn.kind === 'stop') {
        // 停止词:消息已留痕并全员暂停;恢复由下一条用户消息开启
        diag.beginTurn({ id: turnId, source: opts2.voice ? 'voice' : 'chat', text, target: 'A', groupAsk: false, voice: !!opts2.voice, ts: Date.now(), room: roomSessionId })
        diag.turnFinished(turnId, { outcome: 'cancelled', totalMs: Date.now() - turnStartedAt, replyChars: 0, replySentences: 0 })
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
        room: roomSessionId,
      })
      diag.detailText(turnId, { textKind: 'input', text })
      if (opts2.diagAsr) diag.asrResult(turnId, opts2.diagAsr)
      host.onUserActive()

      // —— 工具/记忆:用户入口只执行一次(评审④)——
      // 消息到这一步已经入 journal(输入框清空依赖本次 send 正常返回):
      // extras(记忆/工具/世界注记/旧梗)任何异常都不得让 send 抛错——
      // 否则消息留在 journal 不 wake,表现为"发出去了但输入框不清空、群里没反应",
      // 直到下一条用户消息才被连带投递
      let memory: TurnMemoryContext = emptyTurnMemory()
      let toolNote: string | undefined
      let toolRefs: ChatMemoryRef[] = []
      let clarifyText: string | null = null
      let cancelled = false
      try {
        const memoryT0 = Date.now()
        memory =
          (await (engine.prepareMemory ?? prepareTurnMemory)({ query: text, n: 3 }).catch(() => emptyTurnMemory())) ??
          emptyTurnMemory()
        diag.memorySelection(turnId, {
          ms: Date.now() - memoryT0,
          selected: memory.selected.map((s) => ({ id: s.id, score: s.score, source: s.source })),
          candidates: memory.candidates.map((c) => ({ id: c.id, score: c.score, outcome: c.outcome })),
        })
        presenterOf().setBadge(chainId, memory.refs)
        if (engine.tools) {
          const toolsT0 = Date.now()
          const prep = await engine.tools({ userText: text }, currentAbort.signal)
          diag.toolsPrepare(turnId, {
            ms: Date.now() - toolsT0,
            clarified: !!prep.clarify,
            hasNote: !!prep.note,
            memoryRefs: prep.memoryRefs?.length ?? 0,
          })
          if (currentAbort.signal.aborted) {
            cancelled = true
          } else if (prep.clarify) {
            // clarify 短路:主回应人直接反问,链挂起等待补充,零模型调用
            // (呈现/落盘由 runtime awaitUser 的 onCommit 通道完成,这里不重复入队)
            clarifyText = prep.clarify
          } else {
            toolNote = prep.note
            toolRefs = prep.memoryRefs ?? []
          }
        }
      } catch {
        // extras 失败不阻塞受理:按无附加上下文继续 wake
      }
      if (cancelled) {
        diag.turnFinished(turnId, { outcome: 'cancelled', totalMs: Date.now() - turnStartedAt, replyChars: 0, replySentences: 0 })
        diag.finish(turnId)
        currentTurnId = null
        return 'accepted'
      }
      if (clarifyText) {
        turn.awaitUser(primary, clarifyText)
        diag.turnFinished(turnId, { outcome: 'spoke', totalMs: Date.now() - turnStartedAt, replyChars: clarifyText.length, replySentences: 1 })
        diag.finish(turnId)
        currentTurnId = null
        clock.setTimeout(() => host.clearUser(text), 400)
        return 'accepted'
      }
      const combinedRefs = [...memory.refs, ...toolRefs.filter((r) => !memory.refs.some((x) => x.id === r.id))]
      presenterOf().setBadge(chainId, combinedRefs)
      // 电脑感知暂停注入提示词(2026-09 裁决):感知改走通知(runtime/worldNotify);
      // worldLine 接缝(chainExtras→prepareExtras→actorPrompt)保留,回归时接 worldNote
      const { warmLine, experienceLine, moodLine } = await lifecycleLinesOf(text)
      // 联网规则行:仅主模型档案生效(自定义档案不注入工具也不承诺能搜),
      // 门控谓词与网关工具注入同源(engine/webSearch)
      const primaryBinding = effectiveBinding(cfg, primary)
      const webLine =
        primaryBinding.kind === 'api' && !primaryBinding.profileId && webSearchOnOf(cfg)
          ? WEB_SEARCH_LINE
          : undefined
      chainExtras.set(chainId, {
        factsLine: memory.promptFacts.length ? memory.promptFacts.join(';') : undefined,
        briefLine: briefLineOf(cfg),
        warmLine,
        experienceLine,
        moodLine,
        webLine,
        toolNote,
        memoryRefs: combinedRefs,
      })
      if (chainExtras.size > 8) {
        const oldest = chainExtras.keys().next().value
        if (oldest) chainExtras.delete(oldest)
      }
      backgroundFacts(text, turnId)
      observeTurnSafe(turnId, text, Date.now())
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
          const stats = replyStats.get(turnId) ?? { chars: 0, sentences: 0 }
          replyStats.delete(turnId)
          if (repliedChains.has(chainId)) {
            diag.turnFinished(turnId, {
              outcome: 'spoke',
              totalMs: Date.now() - turnStartedAt,
              replyChars: stats.chars,
              replySentences: stats.sentences,
            })
          } else {
            host.presentFallback({ speaker: primary, text: '（这会儿信号不好,没接上…再说一遍?)' })
            diag.turnFinished(turnId, {
              outcome: 'failed',
              totalMs: Date.now() - turnStartedAt,
              replyChars: stats.chars,
              replySentences: stats.sentences,
            })
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
      if (currentTurnId) {
        replyStats.delete(currentTurnId)
        // actors 引擎无代次概念(generation 恒 0);hadHandle = 呈现管线有句柄在播
        diag.cancelRequested(currentTurnId, {
          generation: 0,
          hadHandle: presenterOf().playing(),
          hadAbort: !!currentAbort,
        })
      }
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
      // 网页会话换代(与注释承诺一致):release 旧键标签页 + generation+1,
      // 旧站点线程绝不污染清空后的新会话;下一轮按 rebuildPrompt 全量重建
      for (const slot of ['A', 'B', 'C'] as const) realAdapters.get(slot)?.adapter.invalidate?.()
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
