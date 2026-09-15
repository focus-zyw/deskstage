// 招牌怪癖系统唯一出口(设计方案 docs/招牌怪癖系统设计方案.md)。
// 模型只增不删,用户独享清除与锁定;怪癖是常驻的背景重力,不是每集任务。
// 外部(演出/群聊/设置/宿主)只经此文件访问,内部结构不外泄。

export {
  ensureQuirksLoaded,
  getShape,
  getBookSync,
  getEpisodeSync,
  subscribeQuirks,
  mutateShape,
  bumpEpisode,
  insertQuirk,
  setQuirkLocked,
  removeQuirk,
  makeId,
  MAX_PER_VALENCE,
  LOCK_CAP_PER_VALENCE,
  sanitizeShape,
  defaultShape,
} from './store'
export { buildQuirkPrompt, type QuirkPromptInput } from './prompt'
export {
  parseQuirkJson,
  generateForSlot,
  ensureColdStarts,
  notePerformanceEpisode,
  setAnnounceSink,
  onQuirkAcquired,
  type GenOutcome,
  type ParsedQuirk,
} from './generate'
export { renderQuirkBlock, QUIRK_INJECTION_RULES } from './render'
export {
  QUIRK_SLOTS,
  QUIRK_TYPES,
  type QuirkEntry,
  type QuirkBook,
  type QuirkValence,
  type QuirkCauseType,
  type QuirkSource,
  type QuirkType,
  type ActorSlot,
} from './types'
