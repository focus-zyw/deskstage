// 预生成编排:后台静默生成"下一轮"对话并存入 prefetchStore。
// 失败一律静默(console.warn),绝不影响演出/交互状态;
// 与用户主动请求相互独立、可并行(90s 超时由 llmClient 兜底)。
import { addPerformanceCues, generateDialog } from './llmClient'
import { pickTopic } from './topicSeeds'
import { modeOf, type Mode } from '../performer/modes'
import { getStory, pickArcBeat } from '../storage/storyStore'
import { savePrefetchEntry } from '../storage/prefetchStore'
import type { DialogLine } from '../performer/player'

const inFlightModes = new Set<string>()

/** 后台预生成一轮并存盘;同模式同时在飞的最多一个。
 *  生成后追加一次轻量演出节奏标注(独立二遍调用,失败不影响入库)。
 *  约 30% 概率抽中连续剧情节拍(与点播同概率,维持 7:3 混合)。
 *  topic 可选:传入则是手动锁定的主题,用强约束 prompt 并绕过话题池与剧情线;
 *  不传则 30% 剧情线 / 70% 随机话题(池级防重复) */
export async function prefetchNext(mode: Mode, recentLines: DialogLine[], topic?: string): Promise<void> {
  if (inFlightModes.has(mode)) return
  inFlightModes.add(mode)
  const arcBeat = topic?.trim() ? undefined : pickArcBeat((await getStory()).arcs)
  const actualTopic =
    topic?.trim() ||
    (arcBeat ? `连续剧情《${arcBeat.title}》:${arcBeat.hook}` : pickTopic(modeOf(mode)))
  void generateDialog(mode, actualTopic, recentLines, undefined, !!topic?.trim(), arcBeat ?? undefined)
    .then((script) => addPerformanceCues(script.before))
    .then((lines) => savePrefetchEntry({ mode, topic: actualTopic, lines }))
    .catch((e) => console.warn('预生成失败(静默)', e))
    .finally(() => inFlightModes.delete(mode))
}
