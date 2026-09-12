// 视频生成 API 的共用请求通道:与 LLM 网关同一套绕 CORS 思路——
// Tauri 内走 Rust 侧 http(国内厂商不发 CORS 头),未放行的自定义端点回落原生 fetch。
// 错误对象带 status/serverMsg,供 describeVideoError 归类成用户可读文案。
import { fetch as rustFetch } from '@tauri-apps/plugin-http'
import { inTauri } from '../../storage/configStore'

export interface VideoApiError extends Error {
  status?: number
  serverMsg?: string
}

async function fetchRaw(url: string, init: RequestInit): Promise<Response> {
  if (!inTauri) return fetch(url, init)
  try {
    return await rustFetch(url, init)
  } catch (e) {
    if (/not allowed on the configured scope/i.test(String((e as Error)?.message ?? ''))) {
      return fetch(url, init)
    }
    throw e
  }
}

/** JSON 请求 → 解析响应;非 2xx 抛带 status/serverMsg 的错误,超时默认 30s(提交/查询都是快接口) */
export async function requestJson<T>(url: string, init: RequestInit, timeoutMs = 30_000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('超时', 'TimeoutError')), timeoutMs)
  try {
    const res = await fetchRaw(url, { ...init, signal: ctrl.signal })
    if (!res.ok) {
      // 服务端错误说明(如 "invalid api key")带到错误对象上,供分类展示
      const serverMsg = (await res.text().catch(() => '')).slice(0, 300)
      const err = new Error(`API HTTP ${res.status}`) as VideoApiError
      err.status = res.status
      err.serverMsg = serverMsg
      throw err
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}
