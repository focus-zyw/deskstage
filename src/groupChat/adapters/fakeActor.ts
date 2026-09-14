// 测试/开发用假 Actor Adapter:脚本化每一步响应,零网络(对应 relayDirector.test.mjs
// 的"假 ask + 注入时钟"范式)。
// step 形态:
// · string                      → 模型原始输出原样返回(通常 JSON.stringify 的协议体)
// · {speak, replyTo?, action?}  → 自动生成 speak(正确回显 batchId/ackThrough)
// · {listen: true}              → 自动生成 listen
// · {fail}                      → 抛错(计入失败退避;error 可自定义)
// · {defer}                     → 返回未决议 promise,测试用 resolve 手动编排并发时序
// · (req, index) => step        → 自定义(可异步)
// 每次 react 的请求与信号都记录在 calls 里供断言;defer 的手柄在 deferred 里。

import { parseValidReaction } from '../actorSchema'
import type { ActorModelAdapter } from './types'
import type { ActorBatch, ActorReactionRequest } from '../types'

export type FakeStep =
  | string
  | { speak: string; replyTo?: string[]; action?: string }
  | { listen: true }
  | { fail: true; error?: Error }
  | { defer: true }
  | ((req: ActorReactionRequest, index: number) => FakeStep | Promise<FakeStep>)

/** 可直接渲染为原始输出的 step(排除 defer 与函数形态) */
type FakeOutcome =
  | string
  | { speak: string; replyTo?: string[]; action?: string }
  | { listen: true }
  | { fail: true; error?: Error }

export interface FakeAdapter extends ActorModelAdapter {
  calls: Array<{ req: ActorReactionRequest; index: number }>
  deferred: Array<{
    batch: ActorBatch
    resolve(raw: string): void
    reject(err: unknown): void
    signal: AbortSignal
  }>
  /** 手动编排:决议第 n 个(0 起)挂起的请求 */
  resolveAt(index: number, step: Exclude<FakeStep, { defer: true }>): void
  rejectAt(index: number, err: unknown): void
  signalsOf(index: number): AbortSignal | undefined
}

function rawFor(batch: ActorBatch, step: FakeOutcome): string {
  if (typeof step === 'string') return step
  const s = step as {
    listen?: boolean
    speak?: string
    replyTo?: string[]
    action?: string
    error?: Error
  }
  if (s.listen) {
    return JSON.stringify({ protocolVersion: 1, batchId: batch.id, ackThrough: batch.throughSeq, decision: 'listen' })
  }
  if (typeof s.speak === 'string') {
    return JSON.stringify({
      protocolVersion: 1,
      batchId: batch.id,
      ackThrough: batch.throughSeq,
      decision: 'speak',
      reply: { text: s.speak, replyTo: s.replyTo ?? [], action: s.action ?? 'talk' },
    })
  }
  throw s.error ?? new Error('网页失败')
}

export function createFakeActorAdapter(script: FakeStep[]): FakeAdapter {
  const calls: FakeAdapter['calls'] = []
  const deferred: FakeAdapter['deferred'] = []
  let resets = 0

  const adapter: FakeAdapter = {
    calls,
    deferred,
    resolveAt(index, step: FakeOutcome) {
      const d = deferred[index]
      if (!d) throw new Error(`deferred[${index}] 不存在`)
      d.resolve(rawFor(d.batch, step))
    },
    rejectAt(index, err) {
      const d = deferred[index]
      if (!d) throw new Error(`deferred[${index}] 不存在`)
      d.reject(err)
    },
    signalsOf(index) {
      return deferred[index]?.signal
    },

    async react(req, signal) {
      const index = calls.length
      calls.push({ req, index })
      const raw = script[index]
      const step = typeof raw === 'function' ? await raw(req, index) : raw
      if (step === undefined) {
        // 脚本耗尽:按 listen 收场(保持队列前进,测试断言调用次数即可发现异常)
        return parseValidReaction(
          JSON.stringify({ protocolVersion: 1, batchId: req.batch.id, ackThrough: req.batch.throughSeq, decision: 'listen' }),
          req.batch,
        )
      }
      if (typeof step === 'object' && 'defer' in step) {
        return new Promise<string>((resolve, reject) => {
          const onAbort = () => reject(new DOMException('已中止', 'AbortError'))
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
          deferred.push({
            batch: req.batch,
            resolve: (value) => {
              signal.removeEventListener('abort', onAbort)
              resolve(value)
            },
            reject: (err) => {
              signal.removeEventListener('abort', onAbort)
              reject(err)
            },
            signal,
          })
        }).then((value) => parseValidReaction(value, req.batch))
      }
      // 函数形态已在顶部 await 消解,此处必为可直接渲染的 step
      return parseValidReaction(rawFor(req.batch, step as FakeOutcome), req.batch)
    },

    async reset() {
      resets += 1
    },
    prefersFullContext: () => resets === 0,
  }
  return adapter
}
