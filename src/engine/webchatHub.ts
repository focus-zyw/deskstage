// 网页会话 Hub · 前端薄封装:一个角色绑定一个长期网页会话(多 AI 剧场底座)。
// 会话键 → Rust Hub 的专属标签页:同 key 串行、不同 key 并行、全局 2 生成槽。
// 取消语义与 webchatAsk 完全一致:signal abort → webchat_cancel(requestId),
// Rust 的「已取消」还原为 AbortError;「发送后页面丢失」原样上抛由调用方
// 按 typed error 恢复(reset + transcript 重发)。
import { invoke } from '@tauri-apps/api/core'
import { inTauri } from '../storage/configStore'
import type { WebchatSite } from './webchat'

export const HUB_LOST_AFTER_SEND = '发送后页面丢失'

export interface ConversationAsk {
  conversationKey: string
  site: WebchatSite
  prompt: string
  timeoutMs: number
  /** true = 重建会话标签页(恢复/上下文卫生) */
  reset?: boolean
  signal?: AbortSignal
}

let seq = 0

export async function askConversation(req: ConversationAsk): Promise<string> {
  if (!inTauri) throw new Error('网页会话仅桌面端可用')
  if (req.signal?.aborted) throw new DOMException('已中止', 'AbortError')
  const requestId = `conv-${Date.now()}-${++seq}`
  const onAbort = () => {
    void invoke('webchat_cancel', { requestId }).catch(() => {})
  }
  req.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await invoke<string>('webchat_ask_conversation', {
      requestId,
      conversationKey: req.conversationKey,
      prompt: req.prompt,
      site: req.site,
      timeoutMs: req.timeoutMs,
      reset: req.reset === true,
    })
  } catch (e) {
    if (String(e) === '已取消') throw new DOMException('已中止', 'AbortError')
    throw e
  } finally {
    req.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 释放会话(关专属标签页)。永不 reject(失败静默,标签页由 Rust 侧 sweeper 兜底)。
 * fire-and-forget 调用依旧合法;需要时序保证的调用方(换代后立刻发下一代 ask)
 * 应 await 它——否则 Rust 侧旧槽的 claim 未解除,认领不到旧页就会新建,旧页
 * 沦为永久孤儿标签页
 */
export function releaseConversation(conversationKey: string): Promise<void> {
  if (!inTauri) return Promise.resolve()
  return invoke('webchat_release_conversation', { conversationKey }).then(
    () => undefined,
    () => undefined,
  )
}
