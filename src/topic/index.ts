// 动态话题系统的唯一公共出口:外部只学习这里的 interface。
// 命令侧:topicDirector(plan/adopt/release/record)+ read model hook(useTopicSnapshot)。
// 内部实现(director/planner/catalog/discovery/store)不直接被外部 import,保持 seam 收口。

import { useSyncExternalStore } from 'react'
import { getTopicSnapshot, subscribeTopicState } from './store'
import type { TopicSnapshot } from './types'

export const TOPIC_PLANNER_VERSION = 1

export type {
  AdoptResult,
  DiscoveryState,
  EpisodeTopicSignal,
  PlanCompatibility,
  RecentTopic,
  TopicCard,
  TopicCategory,
  TopicDistance,
  TopicDuration,
  TopicEvent,
  TopicIntent,
  TopicLane,
  TopicPlan,
  TopicPolicy,
  TopicRequest,
  TopicSession,
  TopicSnapshot,
  TopicSource,
  TopicStage,
  TopicStateV1,
} from './types'
export { TOPIC_CATEGORIES } from './types'
export {
  getTopicSnapshot,
  subscribeTopicState,
  getTopicState,
  peekTopicState,
  warmTopicState,
  mutateTopicState,
  sanitizeTopicCard,
  sanitizeTopicState,
  MAX_RESERVOIR,
  MAX_RECENT,
  MAX_EPISODE_SIGNALS,
} from './store'
export {
  fingerprintOf,
  normalizeTitle,
  titleSimilarity,
  shortTitleDuplicate,
  parseBanWords,
  cardHitsBan,
  banHashOf,
  modeHashOf,
  scoreCard,
  pickWeightedTopK,
  verdictScores,
  buildBridge,
  environmentCards,
  timeBucketOf,
  PLANNER_VERSION,
} from './planner'
export {
  CURATED_CARDS,
  cardsFromSeeds,
  manualCardFromText,
  anglesFor,
  pickAngle,
  focusForCard,
  ANGLES_BY_CATEGORY,
} from './catalog'
export { createTopicDirector, topicDirector, PLAN_TTL_MS, type TopicDirector, type TopicDirectorDeps } from './director'
export { migrateLegacyTopicOverride, type LegacyOverrideDeps } from './migration'
export {
  maybeRestockTopicCandidates,
  cancelDiscovery,
  DISCOVERY_POLICY,
  type DiscoveryDeps,
} from './discovery'
export { buildDiscoveryMessages, parseDiscoveryCards, type DiscoveryInput } from './prompt'
export { sanitizeGeneratedCard } from './planner'

/** 话题读模型的 React 侧:面板渲染专用,纯查询(不耗随机数、不建预约、不改计划) */
export function useTopicSnapshot(): TopicSnapshot {
  return useSyncExternalStore(subscribeTopicState, getTopicSnapshot)
}
