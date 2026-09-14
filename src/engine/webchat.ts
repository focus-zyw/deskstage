// 网页版生成通道 · 前端薄封装。
// CDP 全链路(拉起 Edge、随机调试端口、标签页管理、发送与抓取、完成判定)
// 已移入 src-tauri/src/webchat.rs,站点选择器在 webchat/sites.rs。
// 本文件只剩:invoke 参数组装、取消(abort → webchat_cancel)、取消语义还原
// (Rust 的「已取消」在这里转回 AbortError,llmClient 的回退逻辑照旧识别)。
import { invoke } from '@tauri-apps/api/core'
import { getConfig, inTauri, type WebchatSiteId } from '../storage/configStore'
import { diag, type LlmCallKind } from '../diag/store'

/** 站点 id 白名单的唯一事实源在 configStore(与 Rust 侧 adapter 注册表对齐),这里只别名 */
export type WebchatSite = WebchatSiteId

/** 设置页下拉用的显示名。顺序 = 设置页呈现顺序(先境内后境外) */
export const WEBCHAT_SITES: { id: WebchatSite; label: string }[] = [
  { id: 'deepseek', label: 'DeepSeek 网页版' },
  { id: 'doubao', label: '豆包网页版' },
  { id: 'qianwen', label: '千问(通义)网页版' },
  { id: 'chatgpt', label: 'ChatGPT 网页版' },
  { id: 'gemini', label: 'Gemini 网页版' },
]

/** 网页聊天没有 system role:合并成单条文本注入(与手动验证测试包同款拼法) */
export function mergeMessages(messages: { role: string; content: string }[]): string {
  return messages.map((m) => m.content).join('\n\n')
}

let askSeq = 0

/** 一轮网页生成:整段 prompt 进,网页模型原始回复出。
 *  完成判定(见过生成中 → 不忙 → 稳定 2.5 秒)在 Rust 侧,见 webchat.rs run_ask。
 *  diagRef(可选):传入后本请求进诊断环——耗时、错误与 CDP 阶段轨迹
 *  (webchat_last_trace:拉起/发送/首忙/首文/稳定),回答"网络 or CDP or 模型" */
export async function webchatAsk(
  prompt: string,
  signal?: AbortSignal,
  timeoutMs = 180_000,
  diagRef?: { turnId: string; call: LlmCallKind },
): Promise<string> {
  if (!inTauri) throw new Error('网页版生成仅桌面端可用')
  if (signal?.aborted) throw new DOMException('已中止', 'AbortError')
  const cfg = await getConfig()
  const requestId = `ask-${Date.now()}-${++askSeq}`
  const onAbort = () => {
    void invoke('webchat_cancel', { requestId }).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const t0 = Date.now()
  const pullTrace = () => {
    if (!diagRef) return
    void invoke<{
      request_id: string
      stages: { stage: string; ms: number }[]
      total_ms: number
      error?: string
    } | null>('webchat_last_trace')
      .then((trace) => {
        if (!trace || trace.request_id !== requestId) return
        diag.webchatStages(diagRef.turnId, {
          requestId,
          stages: trace.stages,
          totalMs: trace.total_ms,
          error: trace.error,
        })
      })
      .catch(() => {})
  }
  try {
    const out = await invoke<string>('webchat_ask', {
      requestId,
      prompt,
      site: cfg.webchatSite,
      timeoutMs,
    })
    if (diagRef) {
      diag.llmFinished(diagRef.turnId, {
        call: diagRef.call,
        transport: 'webchat',
        ok: true,
        elapsedMs: Date.now() - t0,
        outputChars: out.length,
      })
    }
    pullTrace()
    return out
  } catch (e) {
    if (String(e) === '已取消') {
      if (diagRef) {
        diag.llmFinished(diagRef.turnId, {
          call: diagRef.call,
          transport: 'webchat',
          ok: false,
          cancelled: true,
          elapsedMs: Date.now() - t0,
          outputChars: 0,
        })
      }
      pullTrace()
      throw new DOMException('已中止', 'AbortError')
    }
    if (diagRef) {
      const msg = String((e as Error)?.message ?? e)
      diag.llmFinished(diagRef.turnId, {
        call: diagRef.call,
        transport: 'webchat',
        ok: false,
        elapsedMs: Date.now() - t0,
        outputChars: 0,
        // CDP 链路错误统一归 cdp 类;阶段轨迹会带更细的分段
        errorKind: /超时|timeout/i.test(msg) ? 'timeout' : 'cdp',
        serverMsg: msg.slice(0, 160),
      })
    }
    pullTrace()
    throw e
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 打开可见的 Edge 窗口给用户登录(隐藏主覆盖层让路);就绪轮询由设置面板负责 */
export async function webchatLogin(site: WebchatSite): Promise<void> {
  await invoke('webchat_login', { site })
}

/** probe 阶段状态:沿状态机逐级只读走查,断在哪一级诊断指向哪一级 */
export interface ProbeStage {
  stage: 'connected' | 'page' | 'input'
  ok: boolean
  detail: string
}

export interface ProbeResult {
  ready: boolean
  detail: string
  stages: ProbeStage[]
}

/** 逐级探测目标站点可否发消息,detail 说明断点位置(未就绪时展示给用户/排查用)。
 *  site 可指定(AI 剧场按甲乙站点分别探测);缺省 = 当前配置站点 */
export async function webchatProbe(site?: WebchatSite): Promise<ProbeResult> {
  if (!inTauri) return { ready: false, detail: '非桌面端', stages: [] }
  const cfg = await getConfig()
  return invoke('webchat_probe', { site: site ?? cfg.webchatSite })
}

/** 手动恢复主覆盖层(角色回屏) */
export async function webchatRestoreMain(): Promise<void> {
  await invoke('webchat_main_visible', { show: true })
}
