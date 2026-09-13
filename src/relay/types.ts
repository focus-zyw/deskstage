// 多 AI 即兴剧场 · 协议与接口的唯一事实源。
//
// 设计裁决(设计方案的落定项):
// · 网页 AI 只负责"扮演当前角色,说下一句"——谁发言、何时结束、最多几轮,
//   全部由本地 RelayDirector 决定;模型输出的 speaker 字段一律忽略;
// · 已播放台词由应用保存(transcript),网页会话上下文不是唯一事实源;
// · 工具调用永不进入剧本的同款纪律在这里同样成立:relay 台词是普通 DialogLine,
//   但不携带任何持久副作用字段。

import type { DialogLine, Speaker } from '../performer/player'
import type { WebchatSite } from '../engine/webchat'

/** 一位演员:一个角色绑定一个长期网页会话 */
export interface RelayActor {
  speaker: Speaker
  site: WebchatSite
  /** 网页会话键:relay:<eid>:<speaker>,同 key 串行、专属标签页 */
  conversationKey: string
  /** 角色名(舞台称呼,prompt 的"现在轮到X"用) */
  name: string
  /** 角色人设(soloShortPersona 已含用户覆盖,勿重复拼接) */
  persona: string
}

/** 场景设定(TopicPlan 映射 + 本地确定的 relationship/goals,不调导演 AI) */
export interface RelayScene {
  topic: string
  hook: string
  focus: string
  stage: string
  allowedBranches: string[]
  avoid: string[]
  relationship: string
  goalA: string
  goalB: string
}

export interface RelayRequest {
  eid: string
  scene: RelayScene
  /** MVP 固定双角色固定交替;类型放行任意数量,执行期强制 ===2 */
  actors: RelayActor[]
  /** 达到 minTurns 后模型的 intent:end 才生效 */
  minTurns: number
  /** 硬上限(收尾提示从 maxTurns-1 轮开始注入) */
  maxTurns: number
  /** 整场时间预算(ms);超时按中止收场 */
  timeBudgetMs: number
  /** 单轮网页生成超时(ms) */
  perTurnTimeoutMs: number
  signal: AbortSignal
}

/** transcript 行:全局单调序号(演员阅读游标的依据) */
export interface RelayTranscriptLine extends DialogLine {
  seq: number
}

export type RelayEndReason =
  | 'model-ended' // 模型 intent:end(≥minTurns)
  | 'max-turns' // 轮次硬上限(已提前注入收尾指令,算自然完)
  | 'timeout' // 整场时间预算耗尽
  | 'repetitive' // 连续两轮明显重复
  | 'cancelled' // 用户停止(不再产出新台词)
  | 'failed' // 单演员连续两次失败(已播本地收尾句)

export interface RelayResult {
  lines: DialogLine[]
  natural: boolean
  reason: RelayEndReason
}

/** 演出源:yield 台词,return 最终结果(播放器经 onSourceEnd 取走) */
export type RelaySource = AsyncGenerator<DialogLine, RelayResult, void>

/** 预备好的演出源:第一句已产出(下一角色请求已预发),
 *  供上层在 first 与 rest 之间完成 TopicDirector 的 adopt 提交点 */
export interface PreparedRelaySource {
  first: DialogLine
  rest: RelaySource
}

/** 单轮网页请求(适配到 WebchatHub) */
export interface RelayActorAsk {
  actor: RelayActor
  prompt: string
  timeoutMs: number
  /** true = 重建会话标签页(恢复/上下文卫生),配合恢复型 prompt */
  reset?: boolean
  signal: AbortSignal
}

export type RelayAsk = (req: RelayActorAsk) => Promise<string>

export interface RelayDirectorDeps {
  ask: RelayAsk
  /** 会话释放(generator finally 保证调用,含 stop 的 return 路径) */
  release: (conversationKey: string) => void
  /** 确定性注入口(测试);缺省 Date.now */
  now?: () => number
}

export interface RelayDirector {
  /** 首句产出前允许抛错(调用方回退兜底剧本);之后不再抛错——
   *  二次失败先 yield 本地收尾句,再 return {natural:false, reason:'failed'} */
  prepareRelay(req: RelayRequest): Promise<PreparedRelaySource>
}
