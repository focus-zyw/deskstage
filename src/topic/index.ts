// 动态话题系统的唯一公共出口:外部只学习这里的 interface。
// 命令侧:topicDirector(plan/adopt/release/record)+ read model hook(useTopicSnapshot)。
// 内部实现(director/planner/catalog/discovery/store)不直接被外部 import,保持 seam 收口。

import { useSyncExternalStore } from 'react'
import { getTopicSnapshot, subscribeTopicState, peekTopicState } from './store'
import { peekStory } from '../storage/storyStore'
import { createTopicCatalog, type TopicCatalog } from './catalog'
import type { TopicSnapshot } from './types'

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
  TopicSuggestion,
} from './types'
export type {
  CategoryStat,
  HistoryPiece,
  TopicCatalog,
  TopicCatalogDeps,
  TopicQueryCtx,
  TopicQueryResult,
} from './catalog'
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
  cardsFromSeeds,
  manualCardFromText,
  anglesFor,
  pickAngle,
  focusForCard,
  ANGLES_BY_CATEGORY,
  createTopicCatalog,
} from './catalog'
export { createTopicDirector, topicDirector, PLAN_TTL_MS, type TopicDirector, type TopicDirectorDeps } from './director'

/** 话题目录应用单例:UI 面板与导演共用同一目录(AI 候选仓/真实往事在闭包内接入) */
export const topicCatalog: TopicCatalog = createTopicCatalog({
  getReservoir: () => peekTopicState()?.reservoir ?? [],
  getHistoryPieces: () => {
    const story = peekStory()
    return (story?.threads ?? []).map((t) => ({
      id: t.id,
      title: t.text.slice(0, 40),
      hook: `旧事没翻篇:${t.text.slice(0, 60)}`,
    }))
  },
})
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
