// 本地嵌入服务(LocalEmbeddingService):对手动启动的 llama-server(llama.cpp)发
// OpenAI 兼容 /embeddings 请求,给冷记忆当本地嵌入来源(方案见
// docs/经历记忆本地嵌入设计方案.md)。llama-server 启动示例:
//   llama-server -m embedding.gguf --embedding --port 8080
//
// 地址永远由 Rust 端点代理从 config.json 解析(kind='coldLocal' → /coldMemory/localUrl,
// 配置为空回退缺省 http://127.0.0.1:8080/v1),前端不拼完整 URL;浏览器预览降级原生
// fetch(开发调试用)。失败一律抛错,由上游 mem0Memory 的 fail-open 兜底——本地服务
// 没起时经历记忆整体停用,Warm 摘要与聊天链路不受影响。
import { COLD_LOCAL_URL_DEFAULT, inTauri } from '../storage/configStore'
import { invoke } from '@tauri-apps/api/core'
import { requestEndpoint } from './endpointProxy'

/** 本地嵌入所需设置(是 ColdMemoryConfig 的子集,便于测试注入) */
export interface LocalEmbeddingSettings {
  /** 嵌入模型名;local 模式选填——llama-server 单模型不校验名字,填了就带上 */
  embedModel?: string
  /** llama-server 服务地址(含 /v1);空则用 COLD_LOCAL_URL_DEFAULT */
  localUrl?: string
}

/** 解析本地服务地址:配置值优先,空/白则回退缺省 */
export function resolveLocalUrl(localUrl?: string): string {
  return localUrl?.trim() || COLD_LOCAL_URL_DEFAULT
}

export interface LocalEmbeddingDeps {
  /** POST {服务地址}{path} 并返回响应原文;默认桌面走 Rust 端点代理、浏览器预览原生 fetch */
  request?: (path: string, body: string, settings: LocalEmbeddingSettings) => Promise<string>
}

/** 默认请求通道:与云端 endpointEmbedBatch 同款双路(代理/原生 fetch) */
async function defaultRequest(path: string, body: string, settings: LocalEmbeddingSettings): Promise<string> {
  if (!inTauri) {
    const res = await fetch(`${resolveLocalUrl(settings.localUrl)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(`本地嵌入 HTTP ${res.status}`)
    return raw
  }
  const { status, body: bytes } = await requestEndpoint('coldLocal', path, { body, timeoutMs: 30_000 })
  if (status < 200 || status >= 300) throw new Error(`本地嵌入 HTTP ${status}`)
  return new TextDecoder().decode(bytes)
}

/** 解析 OpenAI 兼容响应:data[].embedding 按 index 排序(与云端路径同一约定) */
function parseEmbeddings(raw: string): number[][] {
  const data = (JSON.parse(raw) as { data?: { index?: number; embedding?: number[] }[] })?.data
  if (!Array.isArray(data) || data.length === 0) throw new Error('本地嵌入响应不合法')
  return [...data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding ?? [])
}

export interface LocalEmbedding {
  /** 批量嵌入;空输入直接返回空;失败抛错(上游 fail-open 兜底) */
  embedBatch(texts: string[], settings: LocalEmbeddingSettings): Promise<number[][]>
}

export function createLocalEmbedding(deps: LocalEmbeddingDeps = {}): LocalEmbedding {
  const request = deps.request ?? defaultRequest
  return {
    async embedBatch(texts, settings) {
      if (texts.length === 0) return []
      const payload: Record<string, unknown> = { input: texts }
      const model = settings.embedModel?.trim()
      if (model) payload.model = model
      const raw = await request('/embeddings', JSON.stringify(payload), settings)
      return parseEmbeddings(raw)
    },
  }
}

/** 生产单例:冷记忆接线使用 */
export const localEmbedding = createLocalEmbedding()

// ---------- 托管 llama-server(Rust local_embed_server)控制 ----------

/** 与 Rust EmbedServerStatus 对齐 */
export interface EmbedServerState {
  /** stopped / starting / ready / failed */
  status: 'stopped' | 'starting' | 'ready' | 'failed'
  /** 托管实例端口(临时空闲端口;未拉起为 null) */
  port?: number | null
  /** 最近一次失败的 stderr 截尾(llama-server 原始报错) */
  lastError?: string | null
}

/** 托管服务状态;非桌面环境返回 null(浏览器预览无托管) */
export async function localEmbedServerStatus(): Promise<EmbedServerState | null> {
  if (!inTauri) return null
  return await invoke<EmbedServerState>('local_embed_status')
}

/** 手动拉起(重启语义:先停旧实例);失败抛错,文案带 llama-server 的 stderr 截尾 */
export async function localEmbedServerStart(): Promise<EmbedServerState> {
  if (!inTauri) throw new Error('托管启动仅桌面端可用')
  return await invoke<EmbedServerState>('local_embed_start')
}

/** 停止托管实例(应用退出时 Rust 侧也会兜底清理) */
export async function localEmbedServerStop(): Promise<void> {
  if (!inTauri) return
  await invoke('local_embed_stop')
}
