// TopicDirector:动态话题系统的命令侧唯一入口(plan/adopt/release/record)。
// 生命周期:plan 只规划零持久副作用(故事通道在此建 lease)→ 剧本有效且即将开播时
// adopt(以 baseRevision 对话题域 revision 做 CAS,推进 session/recent)→ record 记
// 幂等反馈事件。生成失败 release(lease)+内置兜底,绝不留"系统认为聊过、实际没播"
// 的幽灵话题。AI 不在本文件的关键路径上(候选发现是 discovery 的后台职责)。
//
// 两层内容通道(V2 §5):
//   第一层 manual(手动话题/pin) → session(活跃会话) → story(30% 连续剧情拍) → dynamic
//   第二层 dynamic 多源先验采样(兴趣/角色历史/环境/AI候选/精选)后统一评分。
// 连续剧情不进评分层:它有预约/占用/自然完播推进的特殊生命周期, lease 规则见 planStory。

import { getConfig, saveConfig, type AppConfig } from '../storage/configStore'
import { getTopicWeights } from '../storage/memoryStore'
import { getStory, type StoryArc, type StoryThread } from '../storage/storyStore'
import { listPrefetchedArcIds } from '../storage/prefetchStore'
import { reserveArcBeat } from '../engine/arcReservation'
import { actorWorldOf, castHash } from '../engine/persona'
import { envForegroundCategory } from '../engine/envAware'
import { modeOf, type DialogMode, type Mode } from '../performer/modes'
import { migrateLegacyTopicOverride } from './migration'
import {
  banHashOf,
  buildBridge,
  cardHitsBan,
  environmentCards,
  modeHashOf,
  parseBanWords,
  pickWeightedTopK,
  scoreCard,
  timeBucketOf,
  verdictScores,
  PLANNER_VERSION,
  type RecentLike,
  type ScoreContext,
} from './planner'
import { cardsFromSeeds, createTopicCatalog, focusForCard, manualCardFromText, pickAngle } from './catalog'
import { getTopicState, mutateTopicState, peekTopicState, warmTopicState, MAX_RECENT } from './store'
import type {
  AdoptResult,
  PlanCompatibility,
  RecentTopic,
  TopicCard,
  TopicEvent,
  TopicPlan,
  TopicRequest,
  TopicSession,
  TopicStateV1,
  TopicDistance,
  TopicStage,
} from './types'

/** 计划有效期:过期预生成条目不消费 */
export const PLAN_TTL_MS = 10 * 60_000

/** 候选采样目标总量(各源按先验取 ceil,评分层裁决;先验不可用的源自动归一) */
const CANDIDATE_TARGET = 16
const PRIOR_THREADS = 0.2
const PRIOR_ENVIRONMENT = 0.15
const PRIOR_GENERATED = 0.25
const PRIOR_CURATED = 0.15

export interface ArcBeat {
  id: string
  title: string
  hook: string
  stage: number
}

export interface StoryLease {
  beat: ArcBeat
  release: () => void
}

/** 结构化子集:测试只需提供这些字段( AppConfig 可直接赋给本类型;personaSource 缺省按全默认世界) */
export type TopicConfigSlice = Pick<
  AppConfig,
  'userProfile' | 'topicPrefs' | 'envSense' | 'personaSource'
> & {
  topicOverride?: string | null
}

export interface TopicDirectorDeps {
  getConfig: () => Promise<TopicConfigSlice>
  getStory: () => Promise<{ arcs: StoryArc[]; threads: StoryThread[] }>
  reserveArc: (arcs: StoryArc[], occupied: Set<string>) => StoryLease | null
  listPrefetchedArcIds: () => Promise<Set<string>>
  /** 前台应用类别(editor/browser/terminal/media;null=不可用)。只取类别级标签 */
  envCategory: () => string | null
  /** 旧版 topicStats 种子权重(只读 legacy;测试注入空表) */
  getLegacyWeights: () => Promise<Record<string, number>>
  now: () => number
  rng: () => number
}

const defaultDeps: TopicDirectorDeps = {
  getConfig,
  getStory: async () => {
    const s = await getStory()
    return { arcs: s.arcs, threads: s.threads }
  },
  reserveArc: (arcs, occupied) => reserveArcBeat(arcs, occupied),
  listPrefetchedArcIds,
  envCategory: () => envForegroundCategory(),
  getLegacyWeights: getTopicWeights,
  now: () => Date.now(),
  rng: Math.random,
}

// ---------- 会话阶段推进 ----------

/** 一集的叙事阶段:1→open 2→deepen 3→escalate 4→payoff;持续会话从第 5 集起循环深化 */
function stageForEpisode(episodeIndex: number): TopicStage {
  if (episodeIndex <= 4) return (['open', 'deepen', 'escalate', 'payoff'] as const)[episodeIndex - 1]!
  return (['deepen', 'escalate', 'payoff'] as const)[(episodeIndex - 2) % 3]!
}

function stageFocus(root: TopicCard, stage: TopicStage, episodeIndex: number): string {
  switch (stage) {
    case 'open':
      return root.hook
    case 'deepen':
      return `把「${root.title}」的分歧推深一层:双方交换立场之后,哪边先动摇(第${episodeIndex}集,不得重复前集论点)`
    case 'escalate':
      return `把「${root.title}」推向一个极端案例,让矛盾升级到接近荒诞(第${episodeIndex}集,不得重复前集论点)`
    case 'payoff':
      return `给「${root.title}」一个反转收尾,顺手回收前几集埋的梗(第${episodeIndex}集,收束不给续集钩子)`
    default:
      return root.hook
  }
}

/** 故事拍叙事阶段映射(拍1开场、拍2深化、拍3升级、拍4收尾) */
function stageForBeat(stage: number): TopicStage {
  return stageForEpisode(Math.max(1, Math.min(4, stage)))
}

export function createTopicDirector(depsInput: Partial<TopicDirectorDeps> = {}) {
  const deps: TopicDirectorDeps = { ...defaultDeps, ...depsInput }
  /** 故事 lease:planId → release(进程内;adopt/release 幂等收束) */
  const leases = new Map<string, () => void>()
  /** 已加载的角色世界(目录往事卡的数据源;pin 点播与故事通道都会先取一次) */
  let storyCache: { arcs: StoryArc[]; threads: StoryThread[] } | null = null
  /** 话题目录实例:UI 面板与应用单例同构;这里注入导演自己的候选仓/往事取数 */
  const catalog = createTopicCatalog({
    getReservoir: () => peekTopicState()?.reservoir ?? [],
    getHistoryPieces: () =>
      (storyCache?.threads ?? []).map((t) => ({
        id: t.id,
        title: t.text.slice(0, 40),
        hook: `旧事没翻篇:${t.text.slice(0, 60)}`,
      })),
  })

  function newId(prefix: string, now: number): string {
    return `${prefix}-${now.toString(36)}-${Math.floor(deps.rng() * 0xffffffff).toString(36)}`
  }

  /** 释放计划持有的故事预约(幂等);adopt 与生成失败两条路都会走到 */
  function release(planId: string): void {
    const leaseRelease = leases.get(planId)
    if (!leaseRelease) return
    leases.delete(planId)
    try {
      leaseRelease()
    } catch {
      // 预约释放失败不影响主流程(占用最坏多留一轮)
    }
  }

  // ---------- 小工具 ----------

  function basePlan(
    now: number,
    mode: Mode,
    compat: PlanCompatibility,
    over: Omit<TopicPlan, 'planId' | 'createdAt' | 'expiresAt' | 'baseRevision' | 'compatibility' | 'mode'>,
  ): TopicPlan {
    return {
      planId: newId('tp', now),
      createdAt: now,
      expiresAt: now + PLAN_TTL_MS,
      baseRevision: compat.sessionRevision,
      compatibility: compat,
      mode,
      ...over,
    }
  }

  function recentLike(state: TopicStateV1): RecentLike[] {
    return state.recent.map((r) => ({
      fingerprint: r.fingerprint,
      title: r.title,
      category: r.category,
      source: r.source,
    }))
  }

  function avoidTitles(state: TopicStateV1, cap = 8): string[] {
    return state.recent.slice(-cap).map((r) => r.title)
  }

  function lastTitle(state: TopicStateV1): string {
    return state.recent[state.recent.length - 1]?.title ?? ''
  }

  function splitKeywords(text: string): string[] {
    return text
      .split(/[,，、;；\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  // ---------- 通道一:manual(手动话题 / 推荐区 pin) ----------

  function planPinnedOrManual(
    req: TopicRequest,
    cfg: TopicConfigSlice,
    state: TopicStateV1,
    mode: DialogMode,
    compat: PlanCompatibility,
    now: number,
  ): TopicPlan {
    const card = req.pinCardId
      ? (findPinnedCard(req.pinCardId, state, mode, cfg) ??
        manualCardFromText(req.manualTopic?.trim() ?? '随便聊聊'))
      : manualCardFromText(req.manualTopic?.trim() ?? '')
    const duration = req.duration ?? cfg.topicPrefs.duration
    const distance = req.distance ?? cfg.topicPrefs.distance
    const { focus } = focusForCard(card, [], deps.rng)
    const sessionId = duration === 'once' ? undefined : newId('tse', now)
    return basePlan(now, mode.id, compat, {
      lane: 'manual',
      intent: 'new',
      card: { ...card, bridge: buildBridge(lastTitle(state), card, distance, deps.rng) },
      policy: req.strict === true ? 'strict' : 'guided',
      stage: 'open',
      episodeFocus: focus,
      allowedBranches: [card.category, ...card.tags],
      avoid: avoidTitles(state),
      duration,
      ...(sessionId ? { sessionId } : {}),
    })
  }

  /** 点播找卡:候选仓 → 精选+专属包+模式池+真实往事(目录深模块内封装);
   *  世界门控不过(如人设刚改)返回 null,由调用方回落 manualTopic 文本 */
  function findPinnedCard(
    pinCardId: string,
    state: TopicStateV1,
    mode: DialogMode,
    cfg: TopicConfigSlice,
  ): TopicCard | null {
    const inState = state.reservoir.find((c) => c.id === pinCardId)
    if (inState) return inState
    return catalog.resolve(pinCardId, { mode, actorWorld: actorWorldOf(cfg) })
  }

  // ---------- 通道二:session(活跃会话推进) ----------

  function planSessionEpisode(
    req: TopicRequest,
    session: TopicSession,
    compat: PlanCompatibility,
    mode: DialogMode,
    now: number,
    state: TopicStateV1,
  ): TopicPlan {
    const root = session.rootCard
    const episodeIndex = session.usedFingerprints.length + 1
    // 三集会话压缩为 open→deepen→payoff(第3集必须收尾);持续会话用完整四段循环
    const stage =
      session.duration === 'three-episodes'
        ? episodeIndex >= 3
          ? 'payoff'
          : ((['open', 'deepen'] as const)[episodeIndex - 1] ?? 'open')
        : stageForEpisode(episodeIndex)
    let focus: string
    if (req.intent === 'change-angle') {
      const angle = pickAngle(root, session.usedAngles, deps.rng)
      focus = angle
        ? `换个切口再聊「${root.title}」:${angle}(${root.hook})`
        : `换个切口再聊「${root.title}」:${root.hook}`
    } else {
      focus = stageFocus(root, stage, episodeIndex)
    }
    // 会话集卡:同一根话题,每集指纹带集号(既保持根域,又不撞最近20集硬去重)
    const card: TopicCard = {
      ...root,
      id: `${root.id}-ep${episodeIndex}`,
      fingerprint: `${root.fingerprint}#${episodeIndex}`,
    }
    return basePlan(now, mode.id, compat, {
      lane: 'session',
      intent: req.intent === 'change-angle' ? 'change-angle' : 'continue',
      card,
      policy: session.policy,
      stage,
      episodeFocus: focus,
      allowedBranches: [root.category, ...root.tags],
      avoid: avoidTitles(state),
      duration: session.duration,
      sessionId: session.id,
    })
  }

  // ---------- 通道三:story(连续剧情拍,不进评分层) ----------

  async function planStory(
    req: TopicRequest,
    compat: PlanCompatibility,
    mode: DialogMode,
    now: number,
  ): Promise<TopicPlan | null> {
    const { arcs } = await deps.getStory()
    const occupied = new Set(await deps.listPrefetchedArcIds())
    for (const id of req.excludeArcIds ?? []) occupied.add(id)
    const lease = deps.reserveArc(arcs, occupied)
    if (!lease) return null
    const beat = lease.beat
    const card: TopicCard = {
      id: `arc-${beat.id}`,
      title: beat.title,
      hook: beat.hook,
      category: 'character-history',
      tags: ['连续剧情'],
      source: 'character-history',
      fingerprint: `arc-${beat.id}#${beat.stage}`,
      sensitivity: 'normal',
      generatedAt: now,
    }
    const plan = basePlan(now, mode.id, compat, {
      lane: 'story',
      intent: 'new',
      card,
      policy: 'guided',
      stage: stageForBeat(beat.stage),
      episodeFocus: beat.hook,
      allowedBranches: ['character-history'],
      avoid: [],
      duration: 'once',
      story: { arcId: beat.id, stage: beat.stage, leaseId: '' },
    })
    // leaseId 需要 planId,而 planId 由 basePlan 生成——创建后回填
    plan.story!.leaseId = plan.planId
    leases.set(plan.planId, lease.release)
    return plan
  }

  // ---------- 通道四:dynamic(多源采样 + 统一评分) ----------

  function interestCards(likes: string[], now: number): TopicCard[] {
    return likes.map((k) => {
      const card = manualCardFromText(k)
      return { ...card, id: `int-${card.fingerprint}`, source: 'interest' as const, generatedAt: now }
    })
  }

  function threadCards(threads: StoryThread[]): TopicCard[] {
    return threads.map((t) => ({
      id: `th-${t.id}`,
      title: t.text.slice(0, 40),
      hook: `旧事没翻篇:${t.text.slice(0, 60)}`,
      category: 'character-history' as const,
      tags: ['旧事'],
      source: 'character-history' as const,
      fingerprint: `th-${t.id}`,
      sensitivity: 'normal' as const,
      generatedAt: 0,
    }))
  }

  /** 池内随机抽样(rng 注入),池小则全取 */
  function sample<T>(pool: T[], count: number): T[] {
    if (pool.length <= count) return [...pool]
    const copy = [...pool]
    const out: T[] = []
    while (out.length < count && copy.length > 0) {
      out.push(copy.splice(Math.floor(deps.rng() * copy.length), 1)[0]!)
    }
    return out
  }

  async function planDynamic(
    req: TopicRequest,
    cfg: TopicConfigSlice,
    state: TopicStateV1,
    mode: DialogMode,
    compat: PlanCompatibility,
    now: number,
    envCat: string | null,
  ): Promise<TopicPlan> {
    const banWords = parseBanWords(cfg.userProfile.banTopics)
    const actorWorld = actorWorldOf(cfg)
    const recentFps = state.recent.map((r) => r.fingerprint)
    // 模式专属池 = 硬领域(V2 §6):有专属池时精选源只收池卡,其他源按领域类别过滤
    const modePool = mode.topics ? cardsFromSeeds(mode.topics, mode.id) : []
    const domainCategories = new Set(modePool.map((c) => c.category))
    const inDomain = (c: TopicCard): boolean =>
      modePool.length === 0 || domainCategories.has(c.category) || (c.modeAffinity?.includes(mode.id) ?? false)

    const likes = splitKeywords(cfg.userProfile.likes)
    // 精选源走目录深模块:角色 applicability 门控/雷区/近期 20 集排除/sensitive 过滤都在 catalog 内
    const curatedPool = catalog.candidates({ mode, actorWorld, banWords, excludeFingerprints: recentFps })
    const reservoir = state.reservoir.filter((c) => (!c.expiresAt || c.expiresAt > now) && !cardHitsBan(c, banWords))
    const bucket = timeBucketOf(now)

    let threads: TopicCard[] = []
    try {
      const story = await deps.getStory()
      threads = threadCards(story.threads)
        .filter((c) => !cardHitsBan(c, banWords))
        .filter(inDomain)
        .filter((c) => !recentFps.includes(c.fingerprint))
    } catch {
      threads = []
    }

    // 兴趣概率语义:命中即从兴趣卡中直接择优,不与其他源竞争——
    // interestTopicChance(0.35/0.12)≈ 动态通道最终抽中兴趣主题的命中率
    const interestPool =
      likes.length > 0
        ? interestCards(likes, now).filter(inDomain).filter((c) => !recentFps.includes(c.fingerprint))
        : []
    const interestHit = interestPool.length > 0 && deps.rng() < (mode.interestTopicChance ?? 0)
    const pools: { cards: TopicCard[]; count: number }[] = interestHit
      ? [{ cards: interestPool, count: CANDIDATE_TARGET }]
      : [
          { cards: threads, count: Math.ceil(CANDIDATE_TARGET * PRIOR_THREADS) },
          { cards: environmentCards(envCat, bucket, now).filter(inDomain), count: Math.ceil(CANDIDATE_TARGET * PRIOR_ENVIRONMENT) },
          { cards: reservoir.filter(inDomain), count: Math.ceil(CANDIDATE_TARGET * PRIOR_GENERATED) },
          { cards: modePool.length > 0 ? modePool : curatedPool, count: Math.ceil(CANDIDATE_TARGET * PRIOR_CURATED) },
        ]
    const candidates = pools.flatMap((p) => sample(p.cards, p.count))

    const ctx: ScoreContext = {
      recent: recentLike(state),
      verdicts: verdictScores(state.episodeSignals),
      legacyWeights: await deps.getLegacyWeights(),
      interests: likes,
      modeId: mode.id,
      modeTopicIds: new Set(modePool.map((c) => c.id)),
    }
    const scored = candidates
      .map((c) => scoreCard(c, ctx))
      .filter((s): s is NonNullable<typeof s> => s !== null)
    const chosen = pickWeightedTopK(scored, deps.rng)
    // 兜底:全被过滤/池空 → 目录候选(角色门控+雷区过滤)随机;极端到候选也空 → 手动兜底卡
    const card =
      chosen?.card ??
      (() => {
        const fallback = catalog.candidates({ mode, actorWorld, banWords })
        const pool = fallback.length > 0 ? fallback : [manualCardFromText('今天到底聊点什么')]
        return pool[Math.floor(deps.rng() * pool.length)] ?? manualCardFromText('今天到底聊点什么')
      })()

    const planIntent: TopicPlan['intent'] =
      req.intent === 'surprise' ? 'surprise' : req.intent === 'pivot' ? 'pivot' : 'new'
    // 完全换台/顺着联想/天马行空才有转场线索;普通 new 直接开新场面
    const wantsBridge = planIntent === 'pivot' || planIntent === 'surprise'
    const distance: TopicDistance = planIntent === 'surprise' ? 'far' : (req.distance ?? cfg.topicPrefs.distance)
    const { focus } = focusForCard(card, [], deps.rng)
    return basePlan(now, mode.id, compat, {
      lane: 'dynamic',
      intent: planIntent,
      card: { ...card, bridge: wantsBridge ? buildBridge(lastTitle(state), card, distance, deps.rng) : undefined },
      policy: distance === 'far' ? 'exploratory' : 'guided',
      stage: 'pivot',
      episodeFocus: focus,
      allowedBranches: [card.category, ...card.tags],
      avoid: avoidTitles(state),
      duration: 'once',
    })
  }

  // ---------- plan:两层通道决策 ----------

  async function plan(req: TopicRequest): Promise<TopicPlan> {
    const cfg = await deps.getConfig()
    const state = await getTopicState()
    const now = deps.now()
    const mode = modeOf(req.mode)
    const compat: PlanCompatibility = {
      sessionRevision: state.revision,
      banHash: banHashOf(cfg.userProfile.banTopics),
      modeHash: modeHashOf(mode),
      castHash: castHash(),
      plannerVersion: PLANNER_VERSION,
    }
    const intent = req.intent ?? 'new'
    const envCat = cfg.envSense ? deps.envCategory() : null

    // 通道一:手动话题 / 推荐区 pin(先取角色世界,往事卡才能被 resolve)
    if (req.pinCardId || req.manualTopic?.trim()) {
      if (req.pinCardId && !storyCache) {
        try {
          storyCache = await deps.getStory()
        } catch {
          storyCache = null
        }
      }
      return planPinnedOrManual(req, cfg, state, mode, compat, now)
    }

    const session =
      state.session && (state.session.duration === 'until-cleared' || (state.session.remainingEpisodes ?? 0) > 0)
        ? state.session
        : null

    // 通道二:会话(活跃会话上的普通点播/继续/换角度;pivot/surprise 落到动态换台)
    if (session && (intent === 'new' || intent === 'continue' || intent === 'change-angle')) {
      return planSessionEpisode(req, session, compat, mode, now, state)
    }

    // 通道三:连续剧情拍(仅无会话的 new;30% 命中骰在 reserveArc 内部)
    if (!session && intent === 'new') {
      const story = await planStory(req, compat, mode, now)
      if (story) return story
    }

    // 通道四:动态候选(pivot/surprise,或无会话 new 未命中故事)
    return planDynamic(req, cfg, state, mode, compat, now, envCat)
  }

  // ---------- adopt:CAS 采纳(剧本有效且即将开播时调用) ----------

  async function adopt(plan: TopicPlan): Promise<AdoptResult> {
    // lease 幂等收束:无论采纳与否,进程内预约都不再需要(缓存中的 arcId 接管持久占用)
    release(plan.planId)
    if (plan.expiresAt < deps.now()) {
      const fresh = await getTopicState()
      return { status: 'stale', currentRevision: fresh.revision }
    }
    return mutateTopicState<AdoptResult>((state) => {
      // CAS:话题域 revision 与规划时不符 = 并发已推进,本计划作废(缓存至多消费一次)
      if (state.revision !== plan.baseRevision) {
        return { state, result: { status: 'stale' as const, currentRevision: state.revision } }
      }
      const now = deps.now()

      if (plan.lane === 'story') {
        // 剧情拍不入话题账/不推 revision(与旧"剧情线拍不入话题账"对齐);
        // 剧情阶段只由自然完播后的故事蒸馏链推进
        return { state, result: { status: 'adopted' as const, revision: state.revision } }
      }

      state.revision += 1

      if (plan.lane === 'session' && state.session && plan.sessionId === state.session.id) {
        // 会话推进:阶段/当前卡/已用切口/剩余集数;三集拍满自动收官回动态
        const s = state.session
        s.currentCard = plan.card
        s.stage = plan.stage === 'pivot' ? 'escalate' : plan.stage
        s.usedFingerprints = [...s.usedFingerprints, plan.card.fingerprint].slice(-40)
        s.usedAngles = [...s.usedAngles, plan.episodeFocus].slice(-40)
        s.remainingEpisodes = s.duration === 'until-cleared' ? null : Math.max(0, (s.remainingEpisodes ?? 1) - 1)
        s.revision += 1
        s.updatedAt = now
        if (s.duration === 'three-episodes' && s.remainingEpisodes === 0) state.session = null
      } else if (plan.sessionId) {
        // 手动多集话题:建新会话(取代旧会话——手动定题是显式用户意志)
        const card = plan.card
        state.session = {
          id: plan.sessionId,
          rootCard: card,
          currentCard: card,
          policy: plan.policy === 'strict' ? 'strict' : 'guided',
          duration: plan.duration === 'until-cleared' ? 'until-cleared' : 'three-episodes',
          remainingEpisodes: plan.duration === 'until-cleared' ? null : 2, // 首集已演,三集余 2
          stage: 'open',
          usedFingerprints: [card.fingerprint],
          usedAngles: [plan.episodeFocus],
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }
      } else {
        // once / 完全换台:结束会话,回到动态
        state.session = null
      }

      // recent 推进(硬去重与 avoid 的依据)
      const entry: RecentTopic = {
        fingerprint: plan.card.fingerprint,
        title: plan.card.title,
        category: plan.card.category,
        source: plan.card.source,
        ts: now,
      }
      state.recent = [...state.recent, entry].slice(-MAX_RECENT)
      // 候选消费计数(发现补货触发依据)
      if (plan.card.source === 'generated') state.discovery.consumedSinceRestock += 1
      return { state, result: { status: 'adopted' as const, revision: state.revision } }
    })
  }

  // ---------- record:幂等话题事件(唯一反馈写入口) ----------

  async function record(event: TopicEvent): Promise<void> {
    try {
      await mutateTopicState((state) => {
        const now = deps.now()
        const existing = state.episodeSignals[event.eid]
        switch (event.type) {
          case 'started': {
            // 重复 started 幂等:保留已有评价字段,只刷新归属与时间
            state.episodeSignals[event.eid] = {
              fingerprint: event.plan.card.fingerprint,
              category: event.plan.card.category,
              source: event.plan.card.source,
              started: true,
              completed: false,
              ...(existing?.skippedProgress !== undefined ? { skippedProgress: existing.skippedProgress } : {}),
              rating: existing?.rating ?? null,
              favored: existing?.favored ?? false,
              updatedAt: now,
            }
            return { state, result: undefined }
          }
          case 'completed': {
            if (!existing) return { state, result: undefined }
            state.episodeSignals[event.eid] = { ...existing, completed: true, updatedAt: now }
            return { state, result: undefined }
          }
          case 'skipped': {
            if (!existing) return { state, result: undefined }
            // 播过 80% 视为看完(与旧口径一致),不罚
            state.episodeSignals[event.eid] =
              event.progress >= 0.8
                ? { ...existing, completed: true, updatedAt: now }
                : { ...existing, skippedProgress: event.progress, updatedAt: now }
            return { state, result: undefined }
          }
          case 'rating-changed': {
            if (!existing) return { state, result: undefined }
            state.episodeSignals[event.eid] = { ...existing, rating: event.value, updatedAt: now }
            return { state, result: undefined }
          }
          case 'favorite-changed': {
            if (!existing) return { state, result: undefined }
            state.episodeSignals[event.eid] = { ...existing, favored: event.favored, updatedAt: now }
            return { state, result: undefined }
          }
        }
      })
    } catch (e) {
      console.warn('话题事件记账失败(静默)', e)
    }
  }

  // ---------- init:预热 + 旧数据迁移 ----------

  /** 手动清除当前话题会话(面板"清除当前话题");revision+1 使旧预生成缓存全部作废 */
  async function clearSession(): Promise<void> {
    try {
      await mutateTopicState((state) => {
        if (!state.session) return { state, result: undefined }
        state.session = null
        state.revision += 1
        return { state, result: undefined }
      })
    } catch (e) {
      console.warn('话题会话清除失败(静默)', e)
    }
  }

  async function init(): Promise<void> {
    await warmTopicState()
    await migrateLegacyTopicOverride({
      getOverride: async () => (await deps.getConfig()).topicOverride ?? null,
      clearOverride: async () => {
        await saveConfig({ topicOverride: null })
      },
    }).catch(() => {})
  }

  return { plan, adopt, release, record, clearSession, init }
}

export type TopicDirector = ReturnType<typeof createTopicDirector>

/** 应用默认实例(测试用 createTopicDirector 注入 fake) */
export const topicDirector = createTopicDirector()
