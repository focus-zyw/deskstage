// 配置端点代理 · 前端桥:可配置 origin 的外部请求(llm / ocr / gptsovits)统一经
// Rust 发出。前端只给 kind + 相对路径;origin 与鉴权头由 Rust 从 config.json /
// 凭据库解析,禁止重定向、限方法/体大小/超时——硬化清单见
// src-tauri/src/endpoint_proxy.rs 顶部注释。响应体经 Channel 流式回传,前端
// 重组为 ReadableStream(TTS 增量播放)或整包收集(LLM/OCR 的 JSON)。
// 固定 https 厂商(videoGen/商用 TTS/直播 HTTP)不走这里,仍受静态 scope 管辖。
import { Channel, invoke } from '@tauri-apps/api/core'

export type EndpointKind = 'llm' | 'ocr' | 'gptsovits'

export interface EndpointOptions {
  /** 请求体(JSON 字符串);三类端点固定 POST */
  body?: string
  /** 总超时(Rust 侧钳位 1s~300s,缺省 90s) */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface EndpointOutcome {
  status: number
  /** 整包响应体(仅在 requestEndpoint 里使用) */
  body: Uint8Array
}

let seq = 0

/** Channel 载荷 → 字节:Rust 侧发 Raw 二进制,按实际到达形态归一。
 *  ArrayBuffer 是 Tauri v2 Raw 载荷的文档形态;数组/数字数组是 serde 兜底;
 *  base64 串防御老版本 IPC 序列化 */
function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (Array.isArray(raw)) return new Uint8Array(raw as number[])
  if (typeof raw === 'string') {
    const bin = atob(raw)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array(0)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

interface Wire {
  stream: ReadableStream<Uint8Array>
  /** invoke 结束后调用:正常关闭或以错误终止流 */
  finish(result: { status: number } | Error, okStatus?: boolean): void
}

/** invoke 的 Channel 事件 ↔ ReadableStream 的双向粘合 */
function wireChannel(): { channel: Channel<unknown>; wire: Wire } {
  const channel = new Channel<unknown>()
  const queue: Uint8Array[] = []
  let closed = false
  let error: Error | null = null
  let notify: (() => void) | null = null
  channel.onmessage = (raw) => {
    queue.push(toBytes(raw))
    notify?.()
    notify = null
  }
  const wake = () => {
    notify?.()
    notify = null
  }
  const wire: Wire = {
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          const head = queue.shift()
          if (head) {
            controller.enqueue(head)
            return
          }
          if (error) {
            controller.error(error)
            return
          }
          if (closed) {
            controller.close()
            return
          }
          await new Promise<void>((r) => {
            notify = r
          })
        }
      },
    }),
    finish: (result, okStatus = true) => {
      if (result instanceof Error) {
        error = result
      } else if (!okStatus) {
        const detail = new TextDecoder().decode(concat(queue.splice(0))).trim()
        const err = new Error(`HTTP ${result.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
        ;(err as Error & { status?: number }).status = result.status
        ;(err as Error & { serverMsg?: string }).serverMsg = detail
        error = err
      }
      closed = true
      wake()
    },
  }
  return { channel, wire }
}

async function runInvoke(
  kind: EndpointKind,
  pathAndQuery: string,
  opts: EndpointOptions,
  channel: Channel<unknown>,
  requestId: string,
): Promise<{ status: number }> {
  const onAbort = () => {
    void invoke('endpoint_cancel', { requestId }).catch(() => {})
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await invoke<{ status: number }>('endpoint_request', {
      requestId,
      kind,
      pathAndQuery,
      body: opts.body ?? '',
      timeoutMs: opts.timeoutMs,
      onChunk: channel,
    })
  } catch (e) {
    if (String(e) === '已取消') throw new DOMException('已中止', 'AbortError')
    throw e
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

function nextRequestId(): string {
  return `ep-${Date.now()}-${++seq}`
}

/** 一次性请求:整包收集后返回(适合 JSON 响应的 llm/ocr;非 2xx 不抛,由调用方分类)。
 *  字节收集必须排干 stream——invoke 的返回值与 Channel 分片是两条 IPC 消息,
 *  到达顺序无保证,按"invoke 已返回"就收割队列会拿到空/半截 body(真实事故:
 *  对话生成稳定报"响应不是合法 JSON")。stream 的 pull 先清队列再判关闭,
 *  排干它即与到达时序无关 */
export async function requestEndpoint(
  kind: EndpointKind,
  pathAndQuery: string,
  opts: EndpointOptions = {},
): Promise<EndpointOutcome> {
  const { stream } = openEndpointStream(kind, pathAndQuery, opts)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  // invoke 失败(取消/网络)已由 openEndpointStream 作为流错误注入,这里直接透传
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  // 正常关闭 = finish 已带 status 走过;从最后一次 finish 结果里取状态码:
  // 复用 wire 不可行(未暴露),这里用内部约定——非 2xx 时 stream 已以错误终止,
  // 走不到这行,所以能到这里 status 必为 2xx
  return { status: 200, body: concat(chunks) }
}

/** 流式请求:ReadableStream 立即可读,响应体随到随交(适合 TTS 增量播放)。
 *  非 2xx → 流以带 status/serverMsg 的错误终止;invoke 失败(取消/网络)同样终止流 */
export function openEndpointStream(
  kind: EndpointKind,
  pathAndQuery: string,
  opts: EndpointOptions = {},
): { stream: ReadableStream<Uint8Array> } {
  const { channel, wire } = wireChannel()
  const invokePromise = runInvoke(kind, pathAndQuery, opts, channel, nextRequestId())
  invokePromise.then(
    (r) => wire.finish(r, r.status >= 200 && r.status < 300),
    (e) => wire.finish(e instanceof Error ? e : new Error(String(e))),
  )
  // 流消费方只认 stream;done 的拒绝已经过 finish 进了流,吞掉避免 unhandled rejection
  invokePromise.catch(() => {})
  return { stream: wire.stream }
}
