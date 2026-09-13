// 预生成编排:后台静默生成"下一轮"对话并存入 prefetchStore。
// 失败一律静默(console.warn),绝不影响演出/交互状态;与用户主动请求相互独立。
// 话题来源:topicDirector.plan()(零副作用规划,约 30% 概率规划出连续剧情拍,
// 与点播同概率维持 7:3 混合);手动话题经 request.manualTopic 强约束。
// 生成后把话题计划连同剧本一起入库(缓存消费时按计划兼容令牌校验),并释放故事
// 进程内预约——缓存中的 arcId 接管持久占用,防止跨模式重复预生成同一拍。
import { addPerformanceCues } from './llmClient'
import { dialogue } from '../dialogue/director'
import type { Mode } from '../performer/modes'
import { savePrefetchEntry } from '../storage/prefetchStore'
import type { DialogLine } from '../performer/player'
import { topicDirector } from '../topic/director'
import type { TopicIntent, TopicRequest } from '../topic/types'

const inFlightModes = new Set<string>()

/** 后台预生成一轮并存盘;同模式同时在飞的最多一个。
 *  生成后追加一次轻量演出节奏标注(独立二遍调用,失败不影响入库)。
 *  request 缺省 = 普通动态下一集(intent new);传 manualTopic 则是手动锁定主题的强约束单 */
export async function prefetchNext(
  mode: Mode,
  recentLines: DialogLine[],
  request: { intent?: TopicIntent; manualTopic?: string; excludeArcIds?: readonly string[] } = {},
): Promise<void> {
  if (inFlightModes.has(mode)) return
  inFlightModes.add(mode)
  let planId: string | null = null
  try {
    // 规划零副作用:不建会话、不记 recent、不动统计(预生成不得改变话题阶段)
    const req: TopicRequest = { mode, intent: request.intent ?? 'new', speculative: true }
    if (request.manualTopic?.trim()) {
      req.manualTopic = request.manualTopic
      req.strict = true
      req.duration = 'until-cleared'
    }
    if (request.excludeArcIds?.length) req.excludeArcIds = request.excludeArcIds
    const plan = await topicDirector.plan(req)
    planId = plan.planId
    // 预生成零副作用:上下文只预览,注入冷却/recap 消费随 script.adoption 推迟到开播采纳
    const { script } = await dialogue.prepareEpisode({
      mode,
      topicPlan: plan,
      recentLines,
      deferContextAdoption: true,
    })
    const cued: typeof script = { ...script, before: await addPerformanceCues(script.before) }
    await savePrefetchEntry({
      mode,
      topic: plan.card.title,
      topicPlan: plan,
      script: cued,
      arc: plan.story ? { id: plan.story.arcId, stage: plan.story.stage } : undefined,
    })
  } catch (e) {
    console.warn('预生成失败(静默)', e)
  } finally {
    // 入库成功:缓存里的 arcId 接管持久占用,进程内 lease 即刻收束;失败同样收束
    if (planId) topicDirector.release(planId)
    inFlightModes.delete(mode)
  }
}
