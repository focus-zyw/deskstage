// 预生成编排:后台静默生成"下一轮"对话并存入 prefetchStore。
// 失败一律静默(console.warn),绝不影响演出/交互状态;
// 与用户主动请求相互独立、可并行(90s 超时由 llmClient 兜底)。
import { generateDialog } from './llmClient'
import { pickTopic } from './topicSeeds'
import { modeOf, type Mode } from '../performer/modes'
import { savePrefetchEntry } from '../storage/prefetchStore'
import type { DialogLine } from '../performer/player'

const inFlightModes = new Set<string>()

/** 后台预生成一轮并存盘;同模式同时在飞的最多一个 */
export function prefetchNext(mode: Mode, recentLines: DialogLine[]): void {
  if (inFlightModes.has(mode)) return
  inFlightModes.add(mode)
  const topic = pickTopic(modeOf(mode)) // 池级防重复,自动避开刚用过的主题
  void generateDialog(mode, topic, recentLines)
    .then((lines) => savePrefetchEntry({ mode, topic, lines }))
    .catch((e) => console.warn('预生成失败(静默)', e))
    .finally(() => inFlightModes.delete(mode))
}
