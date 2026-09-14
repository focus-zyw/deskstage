// Actor 模型适配层 · 唯一 seam:三种绑定(api/web/disabled)对 Worker 呈现同一形状。
// · react:一次"读批次→给回复"的完整调用;实现内部把原始输出解析为 ActorReaction
//   (统一走 actorSchema.parseValidReaction,非法抛 ActorProtocolError → Worker 退避);
// · reset:网页会话重建(恢复/抢占废弃/上下文卫生/绑定切换)后,下次 react 注入全量上下文;
// · dispose:释放会话标签页等底层资源(运行时 dispose 时调用)。
// Adapter 不做发言决策、不知道队列与游标——那些都是 Router/Worker 的事。

import type { ActorReaction, ActorReactionRequest } from '../types'

export interface ActorModelAdapter {
  react(request: ActorReactionRequest, signal: AbortSignal): Promise<ActorReaction>
  /** 请求下次 react 携带全量上下文(网页会话首叫/重建后);缺省 = 恒全量(API 无状态) */
  prefersFullContext?(): boolean
  /** 作废当前网页会话(转向/停止时在飞废弃/绑定切换/清空):下次 react 重建会话。
   *  会话键带 generation,旧键的页面被释放——旧内容绝不污染新批次 */
  invalidate?(): void
  reset?(): Promise<void>
  dispose?(): Promise<void>
}
