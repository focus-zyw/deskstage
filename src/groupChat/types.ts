// 群聊 Actor 系统 · 领域类型(纯声明,无运行时依赖)。
//
// 语义要点(docs/自由群聊Actor系统.md):
// · RoomMessage.roomSeq 在一个群聊内严格递增——UI、落盘、队列扇出、播放顺序一律以它为准;
// · 角色不接收自己发送的消息(FIFO 过滤 author !== actor),各角色 ACK 游标完全独立;
// · ActorReaction 是模型输出协议:batchId/ackThrough 必须与批次一致才可能提交——
//   错误 ACK 永不删队列(FIFO 只进不退),这是提交临界区的第一道校验。
// 持久化定位是「会话内可靠队列」:journal 为内存事实源,重启后从日志尾部开始,
// 历史仅作上下文,不恢复待处理消息。
import type { Speaker } from '../performer/dialogSchema'
import type { GroupAutonomy, GroupModelBinding } from '../storage/configStore'

export type ActorId = Speaker

/** 绑定与自主档位的规范定义在 configStore(持久 schema 单源);这里别名对齐 */
export type ModelBinding = GroupModelBinding
export type AutonomyLevel = GroupAutonomy

/** 消息作者:用户或某个角色 */
export type RoomAuthor = 'user' | ActorId

/** 群聊消息(journal 内存事实源;落盘到 chatlog 时携带 roomSeq/epoch/causalRootId/replyTo) */
export interface RoomMessage {
  id: string
  roomSeq: number
  /** 用户转向代次:换方向/停止后恢复时递增;旧 epoch 迟到回复在提交区降级丢弃 */
  epoch: number
  author: RoomAuthor
  kind: 'chat' | 'control'
  text: string
  createdAt: number
  /** 因果链根消息 id(用户消息 = 自身 id;角色回复 = 触发链的用户消息 id) */
  causalRootId: string
  /** 因果深度:用户消息 0;回复 = 所回应批次的最高深度 + 1 */
  depth: number
  /** 明确回应的消息 id(可多条;必须是本批次真实包含的 id) */
  replyTo: string[]
}

/** 单角色投递批次:该角色未读 FIFO 的连续前缀(不跳过中间消息) */
export interface ActorBatch {
  id: string
  actor: ActorId
  fromSeq: number
  throughSeq: number
  messages: RoomMessage[]
  /** 本批最需要关注的用户消息(@点名或最新一条用户消息) */
  primaryUserMessageId?: string
  epoch: number
  /** 批次内容指纹(诊断/去重辅助) */
  inputHash: string
}

/** 模型输出协议(protocolVersion 固定 1):decision=speak 时必须携带合法 reply */
export interface ActorReaction {
  protocolVersion: 1
  batchId: string
  ackThrough: number
  decision: 'speak' | 'listen'
  reply?: {
    text: string
    replyTo: string[]
    action: string
  }
}

/** 角色模型绑定已改为 configStore 别名(见文件头) */

export interface ActorRuntimeConfig {
  binding: ModelBinding
  autonomy: AutonomyLevel
}

/** 单角色运行态(worker 状态机 + 游标),快照与诊断共用 */
export type ActorStatus =
  | 'idle'
  | 'collecting'
  | 'invoking'
  | 'backoff'
  | 'paused'
  | 'disabled'

export interface ActorRuntimeState {
  actor: ActorId
  status: ActorStatus
  /** 未读消息数(> 阈值触发 catch-up 暂停,UI 显示「正在追赶」) */
  queueDepth: number
  inFlight: boolean
  ackedThrough: number
  sessionGeneration: number
  consecutiveFailures: number
}

/** 可注入时钟:worker 的合并等待/退避与因果链过期都走它(测试用手动时钟) */
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): () => void
}

/** 一次模型调用的完整请求:prompt 为单文本(网页),messages 为 system/user 形(API) */
export interface ActorReactionRequest {
  actor: ActorId
  batch: ActorBatch
  maySpeak: boolean
  prompt: string
  messages: Array<{ role: 'system' | 'user'; content: string }>
  /** true = 会话首叫/恢复重建:prompt 含完整人设与用户权威规则 */
  fullContext: boolean
  /** 因果链根消息 id(重建会话时注入正式日志摘要用) */
  chainRootId: string
  /**
   * 网页恢复专用:按需以另一形态重建 prompt(全量上下文/断线恢复语)。
   * API Adapter 无状态不需要;网页 Adapter 两段式恢复时用它重发全量进度。
   */
  rebuildPrompt?(mode: { fullContext: boolean; recovery: boolean }): {
    prompt: string
    messages: ActorReactionRequest['messages']
  }
  /** 诊断载荷(可选):诊断轮 id 由宿主注入;attempt/queueDepth 由 Worker 填 */
  diag?: { turnId?: string; attempt?: number; queueDepth?: number }
}

export interface ActorReactionResponse {
  reaction: ActorReaction
}

export type SendUserResult = 'accepted' | 'empty' | 'backpressure'

/** 群聊运行时快照(busy = 尚未静止;send 在 busy 时照常受理) */
export interface GroupChatSnapshot {
  busy: boolean
  /** 任一角色未读超过追赶阈值(>100)被暂停自动调用 */
  catchingUp: boolean
  actors: Record<ActorId, ActorRuntimeState>
}

/** 提交临界区的裁定结果:invalid = 协议非法不 ACK;stale = 旧 epoch 回复已降级丢弃 */
export interface CommitResult {
  outcome: 'committed-speak' | 'committed-listen' | 'invalid'
  reply?: RoomMessage
  stale?: boolean
}
