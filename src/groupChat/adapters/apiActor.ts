// API Actor Adapter:群聊角色经模型档案(或全局主模型)调用 OpenAI 兼容端点。
// API 通道无状态:每次 react 都是完整 prompt(fullContext 恒真);
// 解析统一走 actorSchema.parseValidReaction,协议非法抛 ActorProtocolError → Worker 退避。
// protocol='plain'(单聊直答):模型原始文本直接包成 speak reaction,不走 decision 协议。
import { complete } from '../../engine/llmGateway'
import { parseValidReaction, plainSpeakReaction } from '../actorSchema'
import type { ActorModelAdapter } from './types'

export interface ApiActorAdapterOpts {
  /** 模型档案 id;缺省/'main' = 全局主模型 */
  profileId?: string
  /** 单次调用超时(缺省 40s:群聊一句口语不需要长思考) */
  timeoutMs?: number
  /** 'schema'(默认,群聊)= 决策协议 JSON;'plain'(单聊)= 原始文本直答 */
  protocol?: 'schema' | 'plain'
  /** 聊天联网搜索(每次调用取最新;宿主按"主模型档案 + 配置开关 + 端点支持"
   *  门控后注入,缺省不传 = 永不联网)。开启时超时自动抬底 75s(检索加秒级延迟) */
  webSearch?: () => boolean
}

/** 联网档超时抬底:检索加数秒到十几秒,40s 默认预算会被吃穿 */
const WEB_TIMEOUT_MS = 75_000

export function createApiActorAdapter(opts: ApiActorAdapterOpts = {}): ActorModelAdapter {
  return {
    prefersFullContext: () => true,
    async react(req, signal) {
      const web = opts.webSearch?.() === true
      const raw = await complete({
        messages: req.messages,
        profile: opts.profileId,
        // 单聊直答(plain)必须关 JSON 模式:response_format 会逼模型编出
        // {"type":"json_object",...} 之类的自造 JSON,而不是自然语言回复
        jsonMode: opts.protocol !== 'plain',
        temperature: 1.0,
        webSearch: web,
        timeoutMs: web ? Math.max(opts.timeoutMs ?? 0, WEB_TIMEOUT_MS) : (opts.timeoutMs ?? 40_000),
        signal,
        diag: req.diag?.turnId
          ? {
              turnId: req.diag.turnId,
              call: 'groupActor',
              actor: req.actor,
              batchId: req.batch.id,
              attempt: req.diag.attempt,
              queueDepth: req.diag.queueDepth,
            }
          : undefined,
      })
      return opts.protocol === 'plain'
        ? plainSpeakReaction(raw, req.batch)
        : parseValidReaction(raw, req.batch)
    },
  }
}
