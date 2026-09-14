// API Actor Adapter:群聊角色经模型档案(或全局主模型)调用 OpenAI 兼容端点。
// API 通道无状态:每次 react 都是完整 prompt(fullContext 恒真);
// 解析统一走 actorSchema.parseValidReaction,协议非法抛 ActorProtocolError → Worker 退避。
import { complete } from '../../engine/llmGateway'
import { parseValidReaction } from '../actorSchema'
import type { ActorModelAdapter } from './types'

export interface ApiActorAdapterOpts {
  /** 模型档案 id;缺省/'main' = 全局主模型 */
  profileId?: string
  /** 单次调用超时(缺省 40s:群聊一句口语不需要长思考) */
  timeoutMs?: number
}

export function createApiActorAdapter(opts: ApiActorAdapterOpts = {}): ActorModelAdapter {
  return {
    prefersFullContext: () => true,
    async react(req, signal) {
      const raw = await complete({
        messages: req.messages,
        profile: opts.profileId,
        jsonMode: true,
        temperature: 1.0,
        timeoutMs: opts.timeoutMs ?? 40_000,
        signal,
      })
      return parseValidReaction(raw, req.batch)
    },
  }
}
