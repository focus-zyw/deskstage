// 网页版生成通道 · 前端薄封装。
// CDP 全链路(拉起 Edge、随机调试端口、标签页管理、发送与抓取、完成判定)
// 已移入 src-tauri/src/webchat.rs,站点选择器在 webchat/sites.rs。
// 本文件只剩:invoke 参数组装、取消(abort → webchat_cancel)、取消语义还原
// (Rust 的「已取消」在这里转回 AbortError,llmClient 的回退逻辑照旧识别)。
import { invoke } from '@tauri-apps/api/core'
import { getConfig, inTauri } from '../storage/configStore'

export type WebchatSite = 'deepseek' | 'doubao'

export const WEBCHAT_SITES: { id: WebchatSite; label: string }[] = [
  { id: 'deepseek', label: 'DeepSeek 网页版' },
  { id: 'doubao', label: '豆包网页版' },
]

/** 网页聊天没有 system role:合并成单条文本注入(与手动验证测试包同款拼法) */
export function mergeMessages(messages: { role: string; content: string }[]): string {
  return messages.map((m) => m.content).join('\n\n')
}

let askSeq = 0

/** 一轮网页生成:整段 prompt 进,网页模型原始回复出。
 *  完成判定(见过生成中 → 不忙 → 稳定 2.5 秒)在 Rust 侧,见 webchat.rs run_ask */
export async function webchatAsk(
  prompt: string,
  signal?: AbortSignal,
  timeoutMs = 180_000,
): Promise<string> {
  if (!inTauri) throw new Error('网页版生成仅桌面端可用')
  if (signal?.aborted) throw new DOMException('已中止', 'AbortError')
  const cfg = await getConfig()
  const requestId = `ask-${Date.now()}-${++askSeq}`
  const onAbort = () => {
    void invoke('webchat_cancel', { requestId }).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await invoke<string>('webchat_ask', {
      requestId,
      prompt,
      site: cfg.webchatSite,
      timeoutMs,
    })
  } catch (e) {
    if (String(e) === '已取消') throw new DOMException('已中止', 'AbortError')
    throw e
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 打开可见的 Edge 窗口给用户登录(隐藏主覆盖层让路);就绪轮询由设置面板负责 */
export async function webchatLogin(site: WebchatSite): Promise<void> {
  await invoke('webchat_login', { site })
}

/** 逐级探测目标站点可否发消息,detail 说明断点位置(未就绪时展示给用户/排查用) */
export async function webchatProbe(): Promise<{ ready: boolean; detail: string }> {
  if (!inTauri) return { ready: false, detail: '非桌面端' }
  const cfg = await getConfig()
  return invoke('webchat_probe', { site: cfg.webchatSite })
}

/** 手动恢复主覆盖层(角色回屏) */
export async function webchatRestoreMain(): Promise<void> {
  await invoke('webchat_main_visible', { show: true })
}
