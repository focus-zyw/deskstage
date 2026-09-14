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
  /** 模型档案 id(仅 kind='llm';缺省/'main' = 全局主端点):Rust 按档案解析
   *  地址与 Key,前端不传地址与 key。校验在 Rust 侧再兜一道 */
  profile?: string
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
  finish(status: number | Error, okStatus?: boolean): void
}

/** invoke 的 Channel 事件 ↔ ReadableStream 的双向粘合。
 *  完成语义:Rust 发完 body 后在同一条 Channel 里追加"空字节哨兵"(Channel 内部
 *  保序,哨兵到 = body 必然完整);流的正常关闭要求 哨兵已到 且 invoke 已成功结算。
 *  两者属于不同 IPC 通路,到达顺序无保证——任何一者先行都必须等齐,
 *  否则会像旧版那样提前关闭拿到空 body("响应不是合法 JSON"事故的根因)。 */
function wireChannel(): { channel: Channel<unknown>; wire: Wire } {
  const channel = new Channel<unknown>()
  const queue: Uint8Array[] = []
  const diagnosticChunks: Uint8Array[] = []
  let diagnosticBytes = 0
  let upstreamDone = false // 哨兵已到
  let error: Error | null = null
  let settledOk: boolean | null = null // invoke 结算结果;null = 未结算
  let notify: (() => void) | null = null
  channel.onmessage = (raw) => {
    const bytes = toBytes(raw)
    if (bytes.length === 0) upstreamDone = true
    else {
      queue.push(bytes)
      // 消费方可能在 invoke 返回状态码之前已经取走 queue;单独保留一个很小的
      // 响应前缀,确保非 2xx 错误仍能展示厂商返回的诊断信息。
      if (diagnosticBytes < 300) {
        const prefix = bytes.slice(0, 300 - diagnosticBytes)
        diagnosticChunks.push(prefix)
        diagnosticBytes += prefix.length
      }
    }
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
          if (upstreamDone && settledOk !== null) {
            if (settledOk) controller.close()
            else controller.error(error ?? new Error('端点请求失败'))
            return
          }
          await new Promise<void>((r) => {
            notify = r
          })
        }
      },
    }),
    finish: (status, okStatus = true) => {
      if (status instanceof Error) {
        error = status
      } else if (!okStatus) {
        const detail = new TextDecoder().decode(concat(diagnosticChunks)).trim()
        const err = new Error(`HTTP ${status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
        ;(err as Error & { status?: number }).status = status
        ;(err as Error & { serverMsg?: string }).serverMsg = detail
        error = err
      }
      settledOk = !(status instanceof Error) && okStatus
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
): Promise<number> {
  const onAbort = () => {
    void invoke('endpoint_cancel', { requestId }).catch(() => {})
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await invoke<number>('endpoint_request', {
      requestId,
      kind,
      pathAndQuery,
      body: opts.body ?? '',
      timeoutMs: opts.timeoutMs,
      profile: opts.profile,
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
    (status) => wire.finish(status, status >= 200 && status < 300),
    (e) => wire.finish(e instanceof Error ? e : new Error(String(e))),
  )
  // 流消费方只认 stream;done 的拒绝已经过 finish 进了流,吞掉避免 unhandled rejection
  invokePromise.catch(() => {})
  return { stream: wire.stream }
}
