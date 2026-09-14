// 动态话题系统的领域模型(V2 方案 §4/§9)。
// 本文件只有类型与封闭枚举常量:TopicCard 是可判断/可追踪的话题卡(不再是裸字符串),
// TopicPlan 是不可变纯数据(可直接进 prefetch.json),TopicEvent 是可逆幂等的反馈事件。
// 全部结构都可能持久化到 data/topic-state.json 或 prefetch.json,字段增删必须同步 store 的 sanitize。

import type { ActorSlot } from '../engine/persona'
import type { Mode } from '../performer/modes'

// ---------- 封闭枚举(const 数组供 sanitize/白名单校验复用) ----------

export const TOPIC_CATEGORIES = [
  'consumption',
  'work',
  'life',
  'social',
  'emotion',
  'technology',
  'health',
  'imagination',
  'character-history',
] as const
export type TopicCategory = (typeof TOPIC_CATEGORIES)[number]

export const TOPIC_SOURCES = [
  'manual',
  'curated',
  'interest',
  'character-history',
  'environment',
  'generated',
] as const
export type TopicSource = (typeof TOPIC_SOURCES)[number]

export const TOPIC_LANES = ['manual', 'session', 'story', 'dynamic'] as const
/** 内容通道:manual/session/story/dynamic 两层决策的第一层结论(见 director) */
export type TopicLane = (typeof TOPIC_LANES)[number]

export const TOPIC_INTENTS = ['new', 'continue', 'change-angle', 'pivot', 'surprise'] as const
export type TopicIntent = (typeof TOPIC_INTENTS)[number]

export const TOPIC_POLICIES = ['strict', 'guided', 'exploratory'] as const
export type TopicPolicy = (typeof TOPIC_POLICIES)[number]

export const TOPIC_STAGES = ['open', 'deepen', 'escalate', 'payoff', 'pivot'] as const
export type TopicStage = (typeof TOPIC_STAGES)[number]

export const TOPIC_DURATIONS = ['once', 'three-episodes', 'until-cleared'] as const
export type TopicDuration = (typeof TOPIC_DURATIONS)[number]

export const TOPIC_DISTANCES = ['near', 'medium', 'far'] as const
export type TopicDistance = (typeof TOPIC_DISTANCES)[number]

// ---------- TopicCard:候选话题 ----------

export interface TopicCard {
  id: string
  title: string
  /** 本轮真正要聊的具体矛盾或问题(可演出的局面,不是名词) */
  hook: string
  category: TopicCategory
  tags: string[]
  source: TopicSource
  /** 语义去重键(规范化标题的稳定 hash,比展示标题稳定) */
  fingerprint: string
  /** 为什么能从上个话题转到这里(AI 卡可带,本地转场由 transition 模板生成) */
  bridge?: string
  /** 适配的模式 id(自定义模式话题池的卡带自己的 id) */
  modeAffinity?: string[]
  /** 卡专属演出切口;缺省回落分类角度池 */
  angles?: string[]
  /** 行为骨架:本话题里谁推进、谁阻挡——只描述行为,不绑定职业 */
  roles?: { initiator?: string; challenger?: string }
  /** 适用条件:所列槽位的人设来源须等于给定值(如 {A:'default',B:'default'})。
   *  职业/世界观专属卡才带;多数固定卡不带(始终可见) */
  applicability?: { actors?: Partial<Record<ActorSlot, 'default' | 'custom'>> }
  sensitivity: 'normal' | 'personal' | 'sensitive'
  generatedAt: number
  /** AI 候选过期时间(14 天 TTL);精选/本地卡不过期 */
  expiresAt?: number
}

// ---------- TopicSuggestion:目录查询的轻量投影(面板展示用) ----------

export interface TopicSuggestion {
  id: string
  title: string
  /** 场景预告:面板直接展示的一句话(与实际演出 hook 同源) */
  hook: string
  category: TopicCategory
  tags: string[]
  source: TopicSource
  sensitivity: 'normal' | 'personal' | 'sensitive'
  /** 命中方式:分类点选 / 关键词搜索 */
  matchedBy: 'category' | 'keyword'
}

// ---------- TopicPlan:交给对话生成模块的结果 ----------

/** 缓存兼容令牌:预生成条目据此判断旧剧本还能不能播(见 prefetchStore) */
export interface PlanCompatibility {
  /** 规划时的话题全局 revision,与 baseRevision 同值(plan 时快照) */
  sessionRevision: number
  /** 雷区指纹:雷区变了旧缓存作废 */
  banHash: string
  /** 模式内容指纹:自定义模式编辑后旧剧本不误用 */
  modeHash: string
  /** 演员阵容指纹(人设/名字/性别):阵容变了,带旧名字/旧世界的剧本不误用 */
  castHash: string
  /** 规划器版本:评分/prompt 口径升级时 +1,一次性作废旧缓存 */
  plannerVersion: number
}

export interface TopicPlan {
  planId: string
  createdAt: number
  /** 计划有效期(默认几分钟):过期缓存不消费 */
  expiresAt: number
  /** 采纳的 CAS 令牌:adopt() 时全局 revision 必须仍等于此值 */
  baseRevision: number
  lane: TopicLane
  mode: Mode
  intent: TopicIntent
  card: TopicCard
  policy: TopicPolicy
  stage: TopicStage
  /** 本集只处理这个切口,避免一次把主题说完 */
  episodeFocus: string
  /** 可自然延伸,但不能越过的范围 */
  allowedBranches: string[]
  /** 最近已经聊过、本轮不要重复的内容 */
  avoid: string[]
  duration: TopicDuration
  /** 会话通道才有;once/manual 不建会话 */
  sessionId?: string
  /** 故事通道才有:连续剧情拍(lease 由 director 进程内持有) */
  story?: { arcId: string; stage: number; leaseId: string }
  compatibility: PlanCompatibility
}

// ---------- TopicSession:话题会话 ----------

export interface TopicSession {
  id: string
  rootCard: TopicCard
  currentCard: TopicCard
  policy: 'strict' | 'guided'
  /** once 不建会话,所以这里只有两档 */
  duration: 'three-episodes' | 'until-cleared'
  /** null = until-cleared */
  remainingEpisodes: number | null
  stage: 'open' | 'deepen' | 'escalate' | 'payoff'
  usedFingerprints: string[]
  usedAngles: string[]
  /** 会话内阶段计数(展示用);全局单调 revision 在 TopicStateV1 上 */
  revision: number
  createdAt: number
  updatedAt: number
  /** 旧 config.topicOverride 迁移标记:存原话题的 fingerprint,幂等迁移/续跑用 */
  migratedFromOverride?: string
}

// ---------- 请求与结果 ----------

export interface TopicRequest {
  mode: Mode
  /** 行动意图;缺省 'new'(导演自动决策:推进活跃会话或动态选卡) */
  intent?: TopicIntent
  /** 手动话题文本(命令面板一次性点播/面板自定义输入);非空时 lane=manual */
  manualTopic?: string
  /** 指定已有候选卡(推荐区点卡);优先于 manualTopic */
  pinCardId?: string
  /** 跳跃距离;缺省取 config.topicPrefs.distance */
  distance?: TopicDistance
  /** 手动话题持续时间;缺省取 config.topicPrefs.duration */
  duration?: TopicDuration
  /** 手动话题是否严格围绕(面板勾选;缺省 guided) */
  strict?: boolean
  /** 预生成:只规划,不产生任何持久副作用(不建会话、不记 recent、不动统计) */
  speculative?: boolean
  /** 预生成排除:这些剧情 arc 正在播出/待入库,规划故事拍时视为占用 */
  excludeArcIds?: readonly string[]
}

export type AdoptResult =
  | { status: 'adopted'; revision: number }
  | { status: 'stale'; currentRevision: number }

/** 可逆、幂等的话题反馈事件(eid + type 去重;改评/撤评/取消收藏直接覆盖) */
export type TopicEvent =
  | { type: 'started'; eid: string; plan: TopicPlan }
  | { type: 'completed'; eid: string }
  | { type: 'skipped'; eid: string; progress: number }
  | { type: 'rating-changed'; eid: string; value: 'up' | 'down' | null }
  | { type: 'favorite-changed'; eid: string; favored: boolean }

// ---------- 持久状态(TopicStateV1)与读模型 ----------

export interface RecentTopic {
  fingerprint: string
  title: string
  category: TopicCategory
  source: TopicSource
  ts: number
}

/** 以 eid 为键的一集话题信号投影(可重建:可从最近历史/评价/收藏补齐) */
export interface EpisodeTopicSignal {
  fingerprint: string
  category: TopicCategory
  source: TopicCard['source']
  started: boolean
  completed: boolean
  skippedProgress?: number
  rating: 'up' | 'down' | null
  favored: boolean
  updatedAt: number
}

/** AI 后台发现的调度账本(触发/冷却/日限的持久侧;在飞标记只在进程内) */
export interface DiscoveryState {
  lastAttemptAt: number
  consumedSinceRestock: number
  /** 当日尝试计数与归属日(本地时区 YYYY-MM-DD) */
  attemptDay: string
  attemptCount: number
}

export interface TopicStateV1 {
  version: 1
  /** 话题域全局单调 revision:只在 adopt() 推进;与 Rust 文件 revision 无关 */
  revision: number
  session: TopicSession | null
  /** AI 生成的候选仓(精选/本地卡不入仓) */
  reservoir: TopicCard[]
  /** 最近聊过的话题(adopt 时推进;硬去重与 avoid 的依据) */
  recent: RecentTopic[]
  episodeSignals: Record<string, EpisodeTopicSignal>
  discovery: DiscoveryState
}

/** 读模型快照(同步):面板用 useTopicSnapshot 渲染,不触发 plan/随机/预约 */
export interface TopicSnapshot {
  revision: number
  session: TopicSession | null
  /** 面板"当前话题":会话卡优先,无会话回退最近一条 recent 的标题 */
  currentTitle: string
  currentHook: string
  recent: RecentTopic[]
  reservoirCount: number
}
