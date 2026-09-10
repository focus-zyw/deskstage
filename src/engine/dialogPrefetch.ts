// 预生成编排:后台静默生成"下一轮"对话并存入 prefetchStore。
// 失败一律静默(console.warn),绝不影响演出/交互状态;
// 与用户主动请求相互独立、可并行(90s 超时由 llmClient 兜底)。
import { addPerformanceCues, generateDialog } from './llmClient'
import { pickTopic } from './topicSeeds'
import { modeOf, type Mode } from '../performer/modes'
import { getStory } from '../storage/storyStore'
import { listPrefetchedArcIds, savePrefetchEntry } from '../storage/prefetchStore'
import type { DialogLine } from '../performer/player'
import { reserveArcBeat } from './arcReservation'

const inFlightModes = new Set<string>()

/** 后台预生成一轮并存盘;同模式同时在飞的最多一个。
 *  生成后追加一次轻量演出节奏标注(独立二遍调用,失败不影响入库)。
 *  约 30% 概率抽中连续剧情节拍(与点播同概率,维持 7:3 混合)。
 *  topic 可选:传入则是手动锁定的主题,用强约束 prompt 并绕过话题池与剧情线;
 *  不传则 30% 剧情线 / 70% 随机话题(池级防重复) */
export async function prefetchNext(
  mode: Mode,
  recentLines: DialogLine[],
  topic?: string,
  /** 当前正在播放、尚未完成推进的剧情不能被下一轮预生成再次选中 */
  excludeArcIds: readonly string[] = [],
): Promise<void> {
  if (inFlightModes.has(mode)) return
  inFlightModes.add(mode)
  const occupiedArcIds = await listPrefetchedArcIds()
  for (const id of excludeArcIds) occupiedArcIds.add(id)
  const arcReservation = topic?.trim()
    ? null
    : reserveArcBeat((await getStory()).arcs, occupiedArcIds)
  const arcBeat = arcReservation?.beat
  const actualTopic =
    topic?.trim() ||
    (arcBeat ? `连续剧情《${arcBeat.title}》:${arcBeat.hook}` : pickTopic(modeOf(mode)))
  void generateDialog(mode, actualTopic, recentLines, undefined, !!topic?.trim(), arcBeat ?? undefined)
    .then(async (script) => ({
      ...script,
      before: await addPerformanceCues(script.before),
    }))
    .then((script) =>
      savePrefetchEntry({
        mode,
        topic: actualTopic,
        script,
        arc: arcBeat ? { id: arcBeat.id, stage: arcBeat.stage } : undefined,
      }),
    )
    .catch((e) => console.warn('预生成失败(静默)', e))
    .finally(() => {
      arcReservation?.release()
      inFlightModes.delete(mode)
    })
}
