// 网页 Actor Adapter:群聊角色绑定网页模型站点,经 Rust WebchatHub 的独立会话调用。
//
// 会话键四段式(评审):`group:<roomId>:<actorId>:<bindingRevision>:<generation>`——
// 绑定切换(指纹变)/会话作废(转向、停止时在飞废弃、清空、上下文卫生)都让键变化,
// 旧键页面被释放,旧内容绝不污染新批次(幽灵回复防护)。
//
// 两段式失败恢复(复用 RelayDirector 验证过的协议):
// · 首叫失败 → generation+1(换新键重建标签页)+ rebuildPrompt 全量上下文重发一次;
// · 二次失败才上抛 → Worker 计失败退避,批次保持未 ACK。
// · 上下文卫生:同会话连续 15 轮自动换代重建(Rust 端 reset 由本轮承担)。
import type { WebchatSiteId } from '../../storage/configStore'
import { askConversation, releaseConversation } from '../../engine/webchatHub'
import { parseValidReaction } from '../actorSchema'
import type { ActorId } from '../types'
import type { ActorModelAdapter } from './types'

/** 同会话上下文卫生阈值:连续 N 轮后自动换代重建(relay 同款经验值) */
const CONTEXT_RESET_TURNS = 15

export interface WebchatActorAdapterOpts {
  actor: ActorId
  site: WebchatSiteId
  /** 群标识(当前恒 'main';多房间预留) */
  roomId(): string
  /** 绑定指纹:绑定内容变化即换新会话键(如 `api→web:deepseek`) */
  bindingRevision(): string
  /** 单次调用超时(缺省 150s:网页生成含排队与稳定窗) */
  timeoutMs?: number
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

export function createWebchatActorAdapter(opts: WebchatActorAdapterOpts): ActorModelAdapter {
  let generation = 1
  let invalidated = true // 首叫必须建会话
  let turnCount = 0
  let lastKey: string | null = null

  const keyOf = () => `group:${opts.roomId()}:${opts.actor}:${opts.bindingRevision()}:${generation}`

  return {
    prefersFullContext: () => invalidated || turnCount === 0,

    invalidate() {
      if (lastKey) releaseConversation(lastKey)
      generation += 1
      invalidated = true
      turnCount = 0
      lastKey = null
    },

    async react(req, signal) {
      const timeoutMs = opts.timeoutMs ?? 150_000
      const reset = invalidated || turnCount >= CONTEXT_RESET_TURNS
      const useKey = keyOf()
      const prompt = reset && req.rebuildPrompt ? req.rebuildPrompt({ fullContext: true, recovery: false }).prompt : req.prompt
      let raw: string
      try {
        raw = await askConversation({
          conversationKey: useKey,
          site: opts.site,
          prompt,
          timeoutMs,
          reset,
          signal,
        })
      } catch (e) {
        if (isAbort(e)) throw e
        // 两段式恢复:重建会话 + 全量进度重发,恰一次(再失败交给 Worker 退避)
        if (lastKey) releaseConversation(lastKey)
        generation += 1
        const recovery = req.rebuildPrompt?.({ fullContext: true, recovery: true })
        raw = await askConversation({
          conversationKey: keyOf(),
          site: opts.site,
          prompt: recovery?.prompt ?? req.prompt,
          timeoutMs,
          reset: true,
          signal,
        })
      }
      lastKey = keyOf()
      invalidated = false
      turnCount += 1
      return parseValidReaction(raw, req.batch)
    },

    async dispose() {
      if (lastKey) releaseConversation(lastKey)
      lastKey = null
    },
  }
}
