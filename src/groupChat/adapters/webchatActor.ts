// 网页 Actor Adapter:群聊角色绑定网页模型站点,经 Rust WebchatHub 的独立会话调用。
//
// 会话键四段式(评审):`group:<roomId>:<actorId>:<bindingRevision>:<generation>`——
// 绑定切换(指纹变)/显式作废(转向、停止时在飞废弃、清空、上下文卫生)都让键变化,
// 旧键页面被释放,旧内容绝不污染新批次(幽灵回复防护)。
//
// 复用已有窗口(重启/刷新不换窗):前端刷新会重建 Adapter,但 Rust Hub 的会话槽与
// 标签页仍存活。新建实例的首叫(fresh)不 reset——同键命中旧槽即复用标签页,站点
// 会话原样续聊,全量上下文随本轮 prompt 兜底(槽丢失/页面被清时也能自愈)。
// 只有显式 invalidate(换代语义)才 release 旧页 + reset 重建。
//
// 两段式失败恢复(复用 RelayDirector 验证过的协议):
// · 首叫失败 → generation+1(换新键重建标签页)+ rebuildPrompt 全量上下文重发一次;
// · 二次失败才上抛 → Worker 计失败退避,批次保持未 ACK。
// · 上下文卫生:同会话连续 15 轮自动换代重建(Rust 端 reset 由本轮承担)。
import type { WebchatSiteId } from '../../storage/configStore'
import { askConversation, releaseConversation } from '../../engine/webchatHub'
import { parseValidReaction, plainSpeakReaction } from '../actorSchema'
import type { ActorId } from '../types'
import type { ActorModelAdapter } from './types'

/** 同会话上下文卫生阈值:连续 N 轮后自动换代重建(relay 同款经验值) */
const CONTEXT_RESET_TURNS = 15

export interface WebchatActorAdapterOpts {
  actor: ActorId
  site: WebchatSiteId
  /** 房间标识(群聊 'main';单聊 'direct:<slot>')——网页会话键四段式的一段 */
  roomId(): string
  /** 绑定指纹:绑定内容变化即换新会话键(如 `api→web:deepseek`) */
  bindingRevision(): string
  /** 单次调用超时(缺省 150s:网页生成含排队与稳定窗) */
  timeoutMs?: number
  /** 'schema'(默认,群聊)= 决策协议 JSON;'plain'(单聊)= 原始文本直答 */
  protocol?: 'schema' | 'plain'
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

export function createWebchatActorAdapter(opts: WebchatActorAdapterOpts): ActorModelAdapter {
  let generation = 1
  let invalidated = false // 显式作废(转向/停止/清空):换代重建标签页
  let fresh = true // 尚未成功用过:首叫复用已有会话(见头部说明),全量上下文兜底
  let turnCount = 0
  let lastKey: string | null = null
  /** 换代 release 的落定句柄:下一代 ask 必须等它,否则旧页 claim 未解除会新建孤儿页 */
  let pendingRelease: Promise<void> | null = null

  const keyOf = () => `group:${opts.roomId()}:${opts.actor}:${opts.bindingRevision()}:${generation}`

  const releaseForReplacement = (key: string | null): void => {
    if (!key) return
    pendingRelease = releaseConversation(key)
  }

  const settleRelease = async (): Promise<void> => {
    const wait = pendingRelease
    pendingRelease = null
    if (wait) await wait
  }

  return {
    prefersFullContext: () => fresh || invalidated || turnCount === 0,

    invalidate() {
      releaseForReplacement(lastKey)
      generation += 1
      invalidated = true
      turnCount = 0
      lastKey = null
    },

    async react(req, signal) {
      await settleRelease()
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
        releaseForReplacement(lastKey)
        generation += 1
        const recovery = req.rebuildPrompt?.({ fullContext: true, recovery: true })
        await settleRelease()
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
      fresh = false
      turnCount += 1
      return opts.protocol === 'plain'
        ? plainSpeakReaction(raw, req.batch)
        : parseValidReaction(raw, req.batch)
    },

    async dispose() {
      await settleRelease()
      if (lastKey) await releaseConversation(lastKey)
      lastKey = null
    },
  }
}
