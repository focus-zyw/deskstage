// DialogueDirector(P1 收拢):对话生命周期的唯一入口。
// 准备(冻结上下文+生成,支持预生成零副作用) → 采纳(开播时提交暂缓副作用) →
// 提交(单次落盘 + 角色世界蒸馏/关系事件,自然完播与中止分路)。
// App/预取/播放导演只学这几个动作,不再各自直连 llmClient 与 storyCurator;
// LLM 与存储依赖全部可注入,行为测试不碰网络与磁盘。

import {
  generateDialog,
  adoptDeferredContext,
} from '../engine/llmClient'
import { appendHistory, newEpisodeId, type TopicRef } from '../storage/historyStore'
import { curateEpisode, type CurateReport } from '../engine/storyCurator'
import type { DialogLine, PerformanceScript, SceneCard } from '../performer/dialogSchema'
import type { Mode } from '../performer/modes'
import type { TopicPlan } from '../topic/types'

export { newEpisodeId }

export interface EpisodeRequest {
  mode: Mode
  /** 话题计划:中心话题/本集切口/阶段/延伸边界/转场/约束强度(动态话题系统产出) */
  topicPlan: TopicPlan
  recentLines: DialogLine[]
  signal?: AbortSignal
  continueFromPrevious?: boolean
  /** 预生成:上下文只预览,副作用推迟到开播采纳(adoptDeferred) */
  deferContextAdoption?: boolean
  /** 诊断会话 id(可选):本集生成进诊断环 */
  diagTurnId?: string
}

export interface PreparedEpisode {
  script: PerformanceScript
  /** 本集稳定 id:历史行与关系事件账本共用 */
  eid: string
}

export interface EpisodeCommit {
  eid: string
  mode: Mode
  topic?: string
  /** 话题引用(分类/来源/指纹):新历史写入,老历史按标题生成兼容指纹 */
  topicRef?: TopicRef
  card?: SceneCard
  /** 完整真实已播路径:自然完播=铺垫+分支(+反应回合);中止=已播前缀 */
  played: DialogLine[]
  /** true=自然完播(蒸馏角色世界);false=中止(只落历史,不蒸馏不推进剧情) */
  natural: boolean
}

export interface DialogueDirectorDeps {
  generate?: typeof generateDialog
  adopt?: typeof adoptDeferredContext
  append?: typeof appendHistory
  curate?: typeof curateEpisode
  newId?: () => string
}

export function createDialogueDirector(deps: DialogueDirectorDeps = {}) {
  const generate = deps.generate ?? generateDialog
  const adopt = deps.adopt ?? adoptDeferredContext
  const append = deps.append ?? appendHistory
  const curate = deps.curate ?? curateEpisode
  const newId = deps.newId ?? newEpisodeId

  /** 准备一集:冻结调用时上下文并生成剧本,同时分配本集稳定 eid */
  async function prepareEpisode(req: EpisodeRequest): Promise<PreparedEpisode> {
    const script = await generate({
      mode: req.mode,
      topicPlan: req.topicPlan,
      recentLines: req.recentLines,
      signal: req.signal,
      continueFromPrevious: req.continueFromPrevious ?? false,
      deferContextAdoption: req.deferContextAdoption,
      diagTurnId: req.diagTurnId,
    })
    return { script, eid: newId() }
  }

  /** 预生成的集真正开播:提交暂缓的上下文副作用(注入冷却补记/recap 消费) */
  function adoptDeferred(script: PerformanceScript): void {
    if (script.adoption) void adopt(script.adoption)
  }

  /** 提交一集:历史单次落盘;自然完播再蒸馏角色世界(含关系事件),中止只落历史 */
  async function commitEpisode(commit: EpisodeCommit): Promise<CurateReport | null> {
    await append(commit.played, commit.mode, {
      topic: commit.topic,
      topicRef: commit.topicRef,
      card: commit.card,
      eid: commit.eid,
    })
    if (!commit.natural) return null
    return curate(commit.played, { eid: commit.eid })
  }

  /** 短聊天(问候/自发/休息/备忘)落盘:一次性整段提交 */
  function commitShortChat(lines: DialogLine[]): void {
    void append(lines, 'daily')
  }

  return { prepareEpisode, adoptDeferred, commitEpisode, commitShortChat }
}

export type DialogueDirector = ReturnType<typeof createDialogueDirector>

/** 应用默认实例(测试用 createDialogueDirector 注入 fake) */
export const dialogue = createDialogueDirector()
