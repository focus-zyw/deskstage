// ActorReaction 输出解析与 ACK 校验(纯函数)。
// 解析纪律(与 relaySchema 同款):容忍代码围栏与前后说明文字,只取第一个合法 JSON 对象。
// 校验纪律(提交临界区第一道闸,见 roomRouter.commitActorResult):
// · protocolVersion 必须 =1,batchId 必须与批次一致,ackThrough 必须 = 批次末尾——
//   任一不符 = invalid,不 ACK、游标不动,Worker 退避后原批次重试(错误 ACK 永不删队列);
// · decision=speak 必须携带非空文本,replyTo 只能指向本批次真实包含的消息 id;
// · decision=listen 时忽略任何附带 reply(降级安全)。

import type { ActorBatch, ActorReaction } from './types'
import { MOOD_TAG_TABLE, parseMoodTag, stripMoodTag } from '../engine/moodTag'

export const REACTION_TEXT_MAX = 80

export class ActorProtocolError extends Error {
  /** 稳定原因词:parse / batchId / ackThrough / empty-text / replyTo(诊断与测试断言用) */
  readonly reason: string
  readonly rawHead: string

  constructor(reason: string, rawHead: string) {
    super(`actor reaction 协议非法(${reason})`)
    this.name = 'ActorProtocolError'
    this.reason = reason
    this.rawHead = rawHead
  }
}

/** 容错解析:结构合法即返回;语义校验交给 validateActorReaction(需要批次上下文) */
export function parseActorReaction(raw: string): ActorReaction | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    try {
      obj = JSON.parse(m[0])
    } catch {
      return null
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  if (o.protocolVersion !== 1) return null
  if (typeof o.batchId !== 'string' || !o.batchId) return null
  const ackThrough = typeof o.ackThrough === 'number' ? Math.trunc(o.ackThrough) : NaN
  if (!Number.isFinite(ackThrough)) return null
  const decision = o.decision === 'speak' || o.decision === 'listen' ? o.decision : null
  if (!decision) return null
  if (decision === 'listen') {
    return { protocolVersion: 1, batchId: o.batchId, ackThrough, decision: 'listen' }
  }
  const r = (o.reply ?? {}) as Record<string, unknown>
  // 标签残渣先剥再截:群聊协议的情绪走 action 字段,text 里混入的 <mood:x>
  // 一律剥除(剥除先于截断——标签不占台词预算,不诱发 over-length 误报)
  const text =
    typeof r.text === 'string' ? stripMoodTag(r.text).trim().slice(0, REACTION_TEXT_MAX) : ''
  if (!text) return null
  const replyTo = Array.isArray(r.replyTo)
    ? r.replyTo.filter((x): x is string => typeof x === 'string').slice(0, 6)
    : []
  const action = typeof r.action === 'string' && r.action ? r.action.slice(0, 24) : 'talk'
  return {
    protocolVersion: 1,
    batchId: o.batchId,
    ackThrough,
    decision: 'speak',
    reply: { text, replyTo, action },
  }
}

/** 语义校验:ACK 必须精确命中批次(batchId + ackThrough=throughSeq),replyTo 不得越批 */
export function validateActorReaction(batch: ActorBatch, r: ActorReaction | null): boolean {
  if (!r) return false
  if (r.batchId !== batch.id) return false
  if (r.ackThrough !== batch.throughSeq) return false
  if (r.decision === 'listen') return true
  if (!r.reply || !r.reply.text) return false
  const ids = new Set(batch.messages.map((m) => m.id))
  return r.reply.replyTo.every((id) => ids.has(id))
}

/** 解析 + 校验一步到位(两个 Adapter 共用):非法抛 ActorProtocolError,由 Worker 按失败退避 */
export function parseValidReaction(raw: string, batch: ActorBatch): ActorReaction {
  const parsed = parseActorReaction(raw)
  if (!parsed) throw new ActorProtocolError('parse', raw.slice(0, 120))
  if (parsed.batchId !== batch.id) throw new ActorProtocolError('batchId', parsed.batchId)
  if (parsed.ackThrough !== batch.throughSeq) {
    throw new ActorProtocolError('ackThrough', String(parsed.ackThrough))
  }
  if (parsed.decision === 'speak') {
    if (!parsed.reply?.text) throw new ActorProtocolError('empty-text', raw.slice(0, 120))
    const ids = new Set(batch.messages.map((m) => m.id))
    if (!parsed.reply.replyTo.every((id) => ids.has(id))) {
      throw new ActorProtocolError('replyTo', parsed.reply.replyTo.join(','))
    }
  }
  return parsed
}

/** 单聊直答形态(不走 decision 协议):模型原始文本直接包成 speak reaction。
 *  为什么内部仍是 ActorReaction:router 的预算/去重/游标机制原样复用,
 *  只是"模型必须回显 JSON"这道协议在单聊里没有意义。空文本视为失败 → Worker 退避。
 *  直答不设 80 字台词上限(1对1自然回复可以更长),钳 600 字防御失控输出。
 *  情绪标签 <mood:X> 在这里单点解析:剥除后落盘/TTS/质量闸拿到的都是干净文本,
 *  映射出的动作随 reply.action 穿到呈现侧(剥除先于截断,标签不占字数) */
export function plainSpeakReaction(raw: string, batch: ActorBatch): ActorReaction {
  const { text: bare, tag } = parseMoodTag(raw)
  const text = bare.trim().slice(0, 600)
  if (!text) throw new ActorProtocolError('empty-text', raw.slice(0, 120))
  return {
    protocolVersion: 1,
    batchId: batch.id,
    ackThrough: batch.throughSeq,
    decision: 'speak',
    reply: { text, replyTo: [], action: tag ? MOOD_TAG_TABLE[tag].action : 'talk' },
  }
}
