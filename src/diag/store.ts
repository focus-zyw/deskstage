// AI 链路诊断 · 状态中心:会话环 + 三档详情捕获 + 类型化事件入口 + 派生结论。
//
// 职责边界:
//   · 只在内存(会话环 60 / 单会话 400 事件 / 详情会话 ≤20),不落盘不遥测,
//     导出是唯一出口(toolLog 同款纪律);
//   · detail_text 是唯一能携带正文的通道,必须先过 redact/scrub——详情未捕获
//     时此通道整体关闭(默认档零可读正文的落地点);
//   · deriveSummary 是纯函数:面板顶部"为什么没说话/是否回退/是否取消后仍出声"
//     的归纳全部由事件流推导,不额外存状态。
//
// 跨窗:环在主窗(埋点发生地);bridge.ts 订阅这里的 dirty 队列向设置窗增量推送,
// 设置窗持镜像。本模块不知道 Tauri 的存在。

import { useSyncExternalStore } from 'react'
import { redactText, scrubSecrets } from './redact'
import { fingerprintOf, detectLanguage } from './redact'
import type {
  DiagEvent,
  DiagSession,
  DiagSource,
  DiagSummary,
  LlmCallKind,
  LlmErrorKind,
  TurnOutcome,
} from './types'

export type { DiagEvent, DiagSession, DiagSource, DiagSummary, LlmCallKind, LlmErrorKind, TurnOutcome }

/** TTS/引擎侧的会话引用:把 turnId 带进引擎,事件才能归组 */
export type DiagRef = import('./types').DiagRef

const MAX_SESSIONS = 60
const MAX_EVENTS = 400
const MAX_DETAIL_SESSIONS = 20

// ---------- 详情捕获状态(模块内存,重启自然关闭) ----------

export interface DetailState {
  armed: boolean
  mode: 'off' | 'once' | 'timed'
  rawText: boolean
  /** timed 模式的截止时刻(面板倒计时显示) */
  untilTs: number
}

let detail: DetailState = { armed: false, mode: 'off', rawText: false, untilTs: 0 }
let detailTimer: ReturnType<typeof setTimeout> | null = null

export function armDetail(opts: { once?: boolean; minutes?: number; rawText?: boolean }): void {
  disarmDetail()
  const rawText = opts.rawText ?? false
  if (opts.minutes && opts.minutes > 0) {
    detail = { armed: true, mode: 'timed', rawText, untilTs: Date.now() + opts.minutes * 60_000 }
    detailTimer = setTimeout(() => disarmDetail(), opts.minutes * 60_000)
  } else {
    detail = { armed: true, mode: 'once', rawText, untilTs: 0 }
  }
  bump()
}

export function disarmDetail(): void {
  if (detailTimer) clearTimeout(detailTimer)
  detailTimer = null
  if (!detail.armed && detail.mode === 'off') return
  detail = { armed: false, mode: 'off', rawText: false, untilTs: 0 }
  bump()
}

export function getDetailState(): DetailState {
  return { ...detail }
}

// ---------- 环与订阅 ----------

let ring: DiagSession[] = []
let version = 0
const listeners = new Set<() => void>()
let snapshotCache: { version: number; sessions: DiagSession[] } | null = null

function bump(): void {
  version += 1
  snapshotCache = null
  listeners.forEach((l) => l())
}

export function subscribeDiag(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getDiagSnapshot(): { version: number; sessions: DiagSession[] } {
  if (!snapshotCache) snapshotCache = { version, sessions: [...ring].reverse() }
  return snapshotCache
}

export function useDiagSnapshot(): { version: number; sessions: DiagSession[] } {
  return useSyncExternalStore(subscribeDiag, getDiagSnapshot, getDiagSnapshot)
}

// ---------- 跨窗增量推送(bridge.ts 注册;主窗才有回调) ----------

type UpsertFn = (payload: { full: boolean; sessions: DiagSession[] }) => void
let upsert: UpsertFn | null = null
const dirty = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function setDiagUpsert(fn: UpsertFn | null): void {
  upsert = fn
  if (!fn) {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    dirty.clear()
  }
}

function markDirty(id: string, immediate = false): void {
  if (!upsert) return
  dirty.add(id)
  if (immediate) {
    flushUpserts()
    return
  }
  // 进行中的会话 1s 尾随节流;结束/清空走 immediate
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushUpserts()
    }, 1000)
  }
}

function flushUpserts(): void {
  if (!upsert || dirty.size === 0) return
  const sessions = ring.filter((s) => dirty.has(s.id))
  dirty.clear()
  try {
    upsert({ full: false, sessions })
  } catch {
    // 推送失败不影响采集
  }
}

// ---------- 会话生命周期 ----------

const EMPTY_SUMMARY: DiagSummary = {
  outcome: 'open',
  fallbacks: [],
  cancelLeak: false,
  memoryInjected: 0,
  memoryWritten: 0,
  ttsSegments: 0,
  ttsSpoken: 0,
}

/** 开一次交互会话(默认档,输入结构在 turnStarted 里记)。返回会话 id */
export function beginDiag(input: { id: string; source: DiagSource; ts?: number; room?: string }): string {
  const session: DiagSession = {
    id: input.id,
    ts: input.ts ?? Date.now(),
    source: input.source,
    room: input.room,
    ended: false,
    hasDetail: detail.armed,
    events: [],
    summary: { ...EMPTY_SUMMARY },
  }
  ring = [...ring, session].slice(-MAX_SESSIONS)
  pruneDetailSessions()
  markDirty(session.id)
  bump()
  return session.id
}

function pruneDetailSessions(): void {
  const detailSessions = ring.filter((s) => s.hasDetail)
  if (detailSessions.length <= MAX_DETAIL_SESSIONS) return
  const drop = new Set(detailSessions.slice(0, detailSessions.length - MAX_DETAIL_SESSIONS).map((s) => s.id))
  ring = ring.filter((s) => !drop.has(s.id))
}

/** 结束会话:派生总结论并定稿(事件仍可后到——后台记忆写入常晚于应答完成,
 *  finish 只是不再等待,迟到事件照常追加并重算 summary) */
export function finishDiag(id: string): void {
  const s = ring.find((x) => x.id === id)
  if (!s || s.ended) return
  s.ended = true
  s.summary = deriveSummary(s.events)
  // 「捕获下一次交互」语义:该会话定稿即自动关闭,不等超时
  if (detail.mode === 'once') disarmDetail()
  markDirty(id, true)
  bump()
}

export function clearDiag(): void {
  ring = []
  dirty.clear()
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  markDirty('__all__', true)
  try {
    upsert?.({ full: true, sessions: [] })
  } catch {
    // 忽略
  }
  bump()
}

// ---------- 类型化事件入口(白名单协议;零抛错,未知会话静默丢弃) ----------

function emit(id: string, ev: DiagEvent): void {
  try {
    const s = ring.find((x) => x.id === id)
    if (!s) return
    if (ev.level === 'detail' && !s.hasDetail) return
    if (s.events.length >= MAX_EVENTS) return
    s.events.push(ev)
    s.summary = deriveSummary(s.events)
    markDirty(id, ev.kind === 'turn_finished' || ev.kind === 'memory_write')
    bump()
  } catch {
    // 诊断永不影响业务
  }
}

export const diag = {
  /** 快捷:begin + turn_started(输入结构一次记全) */
  beginTurn(input: {
    id: string
    source: DiagSource
    text: string
    target?: string
    groupAsk?: boolean
    voice?: boolean
    ts?: number
    room?: string
  }): string {
    beginDiag({ id: input.id, source: input.source, ts: input.ts, room: input.room })
    emit(input.id, {
      kind: 'turn_started',
      ts: input.ts ?? Date.now(),
      level: 'basic',
      source: input.source,
      inputChars: input.text.length,
      language: detectLanguage(input.text),
      fingerprint: fingerprintOf(input.text),
      target: input.target ?? '',
      groupAsk: input.groupAsk ?? false,
      voice: input.voice ?? false,
    })
    return input.id
  },

  turnFinished(
    id: string,
    p: { outcome: TurnOutcome; totalMs: number; replyChars: number; replySentences: number },
  ): void {
    emit(id, { kind: 'turn_finished', ts: Date.now(), level: 'basic', ...p })
  },

  llmStarted(
    id: string,
    p: {
      call: LlmCallKind
      transport: 'api' | 'webchat'
      model?: string
      endpointHost?: string
      promptChars: number
      systemChars: number
      userChars: number
      contextLines: number
      timeoutMs?: number
      estTokens?: number
      actor?: string
      batchId?: string
      attempt?: number
      queueDepth?: number
    },
  ): void {
    emit(id, {
      kind: 'llm_started',
      ts: Date.now(),
      level: 'basic',
      ...p,
      estTokens: p.estTokens ?? Math.round(p.promptChars / 1.6),
    })
  },

  llmFirstToken(id: string, p: { call: LlmCallKind; transport: 'api' | 'webchat'; ms: number }): void {
    emit(id, { kind: 'llm_first_token', ts: Date.now(), level: 'basic', ...p })
  },

  llmFirstSentence(id: string, p: { call: LlmCallKind; ms: number }): void {
    emit(id, { kind: 'llm_first_sentence', ts: Date.now(), level: 'basic', ...p })
  },

  llmFinished(
    id: string,
    p: {
      call: LlmCallKind
      transport: 'api' | 'webchat'
      ok: boolean
      cancelled?: boolean
      elapsedMs: number
      outputChars: number
      sentences?: number
      status?: number
      errorKind?: LlmErrorKind
      serverMsg?: string
      actor?: string
      batchId?: string
      attempt?: number
      queueDepth?: number
    },
  ): void {
    emit(id, {
      kind: 'llm_finished',
      ts: Date.now(),
      level: 'basic',
      ...p,
      serverMsg: p.serverMsg ? scrubSecrets(p.serverMsg).slice(0, 160) : undefined,
    })
  },

  fallback(id: string, p: { call: LlmCallKind; from: 'webchat' | 'stream' | 'turnBatch' | 'ocr' | 'actor'; reason: string }): void {
    emit(id, { kind: 'fallback', ts: Date.now(), level: 'basic', ...p })
  },

  webchatStages(
    id: string,
    p: { requestId: string; stages: { stage: string; ms: number }[]; totalMs: number; error?: string },
  ): void {
    emit(id, { kind: 'webchat_stages', ts: Date.now(), level: 'basic', ...p, error: p.error ? scrubSecrets(p.error).slice(0, 160) : undefined })
  },

  ttsRequest(id: string, p: { seg: number; speaker: string; chars: number; channel: string; epoch: number; action?: string }): void {
    emit(id, { kind: 'tts_request', ts: Date.now(), level: 'basic', ...p })
  },

  ttsSegment(
    id: string,
    p: {
      seg: number
      epoch: number
      outcome: 'played' | 'demoted' | 'silent' | 'failed' | 'cancelled' | 'stop-noop'
      synthMs?: number
      audibleAt?: number
      playbackMs?: number
      cacheHit?: boolean
      reason?: string
    },
  ): void {
    emit(id, { kind: 'tts_segment', ts: Date.now(), level: 'basic', ...p })
  },

  ttsStopped(
    id: string,
    p: { trigger: 'cancel' | 'global'; hadActiveSession: boolean; activeChannel?: string; epochBefore: number; epochAfter: number },
  ): void {
    emit(id, { kind: 'tts_stopped', ts: Date.now(), level: 'basic', ...p })
  },

  cancelRequested(id: string, p: { generation: number; hadHandle: boolean; hadAbort: boolean }): void {
    emit(id, { kind: 'cancel_requested', ts: Date.now(), level: 'basic', ...p })
  },

  actionFired(id: string, p: { speaker: string; action: string; seg?: number }): void {
    emit(id, { kind: 'action_fired', ts: Date.now(), level: 'basic', ...p })
  },

  toolsPrepare(id: string, p: { ms: number; clarified: boolean; hasNote: boolean; memoryRefs: number }): void {
    emit(id, { kind: 'tools_prepare', ts: Date.now(), level: 'basic', ...p })
  },

  /** 定稿会话(派生总结论并落位;once 详情捕获随之关闭;迟到事件仍会追加) */
  finish(id: string): void {
    finishDiag(id)
  },

  memorySelection(
    id: string,
    p: {
      ms: number
      selected: { id: string; score: number; source: string }[]
      candidates: { id: string; score: number; outcome: string }[]
    },
  ): void {
    emit(id, { kind: 'memory_selection', ts: Date.now(), level: 'basic', ...p })
  },

  memoryWrite(
    id: string,
    p: {
      candidates: number
      changed: number
      addedIds: string[]
      supersededIds: string[]
      rejected: number
      ms: number
      error?: string
    },
  ): void {
    emit(id, { kind: 'memory_write', ts: Date.now(), level: 'basic', ...p })
  },

  asrResult(id: string, p: { ms: number; chars: number; audioMs?: number; errorKind?: string }): void {
    emit(id, { kind: 'asr_result', ts: Date.now(), level: 'basic', ...p })
  },

  /** 唯一正文通道:详情未捕获时整体关闭;开启时强制 redactText(rawText 档仍强制 scrub)。
   *  调用方传原始文本,无权自定脱敏 */
  detailText(id: string, p: { textKind: 'input' | 'reply' | 'asr'; text: string; seg?: number }): void {
    try {
      const s = ring.find((x) => x.id === id)
      if (!s || !s.hasDetail) return
      const maxLen = p.textKind === 'reply' ? 1000 : 500
      const rawChars = p.text.length
      const text = detail.rawText ? scrubSecrets(p.text) : redactText(p.text, maxLen)
      if (!text) return
      emit(id, { kind: 'detail_text', ts: Date.now(), level: 'detail', textKind: p.textKind, seg: p.seg, text, rawChars })
    } catch {
      // 诊断永不影响业务
    }
  },
}

// ---------- 派生结论(纯函数) ----------

/** 从事件流推导面板顶部结论:未说话原因/回退链/取消泄漏/错误分类/关键延迟。
 *  错误章只在"错误是最终状态"时挂:重试成功/回退成功都不算(回退链已可见) */
export function deriveSummary(events: DiagEvent[]): DiagSummary {
  const out: DiagSummary = { ...EMPTY_SUMMARY, fallbacks: [] }
  let cancelAt = 0
  let hadCancel = false
  let lastError: { kind: LlmErrorKind; text?: string; idx: number } | null = null
  let lastOkIdx = -1
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    switch (ev.kind) {
      case 'turn_started':
        break
      case 'turn_finished':
        out.outcome = ev.outcome
        out.totalMs = ev.totalMs
        break
      case 'llm_first_token':
        out.firstTokenMs = out.firstTokenMs ?? ev.ms
        break
      case 'llm_first_sentence':
        out.firstSentenceMs = out.firstSentenceMs ?? ev.ms
        break
      case 'fallback':
        out.fallbacks.push({ from: ev.from, reason: ev.reason, ts: ev.ts })
        break
      case 'llm_finished':
        if (ev.ok) {
          lastOkIdx = i
        } else if (!ev.cancelled && ev.errorKind !== 'unsupported') {
          lastError = { kind: ev.errorKind ?? 'unknown', text: ev.serverMsg || `${ev.call} 失败(${ev.errorKind ?? 'unknown'})`, idx: i }
        }
        break
      case 'webchat_stages':
        // 阶段错误只进时间轴(异步晚到,常晚于回落 API 的成功);错误章由 llm_finished 负责
        break
      case 'tts_request':
        out.ttsSegments += 1
        break
      case 'tts_segment':
        if (ev.outcome === 'played') out.ttsSpoken += 1
        // 取消之后(含同毫秒)才出声的段 = "取消后仍播放"的直接证据
        if (hadCancel && ev.audibleAt && ev.audibleAt >= cancelAt && ev.outcome === 'played') {
          out.cancelLeak = true
        }
        break
      case 'cancel_requested':
        hadCancel = true
        cancelAt = ev.ts
        break
      case 'memory_selection':
        out.memoryInjected = Math.max(out.memoryInjected, ev.selected.length)
        break
      case 'memory_write':
        out.memoryWritten = Math.max(out.memoryWritten, ev.changed)
        break
      default:
        break
    }
  }
  // 同毫秒事件按序号比先后:错误晚于最后一次成功才挂章
  if (lastError && lastError.idx > lastOkIdx) {
    out.errorKind = lastError.kind
    out.errorText = lastError.text
  }
  if (out.outcome === 'silent' || out.outcome === 'failed') {
    out.noSpeechReason = deriveNoSpeechReason(events, out)
  }
  return out
}

function deriveNoSpeechReason(events: DiagEvent[], out: DiagSummary): string {
  const segments = events.filter((e): e is Extract<DiagEvent, { kind: 'tts_segment' }> => e.kind === 'tts_segment')
  const silentSeg = segments.find((s) => s.outcome !== 'played' && s.outcome !== 'cancelled' && s.reason)
  if (silentSeg?.reason) return silentSeg.reason
  if (out.errorKind) return `生成失败:${out.errorText ?? out.errorKind}`
  if (out.fallbacks.length > 0) {
    const last = out.fallbacks[out.fallbacks.length - 1]
    return `回退后仍未出声:${last.from} → ${last.reason}`
  }
  if (segments.some((s) => s.outcome === 'cancelled')) return '出声前被取消'
  if (!events.some((e) => e.kind === 'tts_request')) return '没有进入语音播报(无回复句/文本路径)'
  return '未知原因'
}

// ---------- 导出 ----------

export interface DiagExportOptions {
  /** false = 剔除 detail_text 事件(默认);true = 包含已脱敏/已 scrub 的详情文本 */
  includeDetailText: boolean
}

/** 导出 JSON 构建(纯函数,设置窗镜像也复用;所有文本都已在入库前脱敏,这里只做筛选) */
export function buildDiagExportJson(sessions: DiagSession[], opts: DiagExportOptions): string {
  const filtered = sessions.map((s) => ({
    ...s,
    events: opts.includeDetailText ? s.events : s.events.filter((e) => e.kind !== 'detail_text'),
  }))
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      tier: opts.includeDetailText ? 'detail(文本已经脱敏或强制 scrub)' : 'basic(无对话正文)',
      privacy: {
        included: [
          '事件时间线与耗时',
          '错误码与运行状态',
          opts.includeDetailText ? '脱敏后的对话文本' : '无对话正文',
          '记忆 id 与决策(不含正文)',
        ],
        excluded: ['API Key 与 Cookie(强制 scrub)', '麦克风音频', '截图与上传文件', '记忆正文(按 id 另查)'],
      },
      sessions: filtered,
    },
    null,
    2,
  )
}

/** 导出当前环(唯一出口;所有文本都已在入库前脱敏,这里只做筛选) */
export function exportDiagJson(opts: DiagExportOptions): string {
  return buildDiagExportJson(ring, opts)
}

/** 测试隔离 */
export function resetDiagForTest(): void {
  ring = []
  version = 0
  snapshotCache = null
  detail = { armed: false, mode: 'off', rawText: false, untilTs: 0 }
  if (detailTimer) clearTimeout(detailTimer)
  detailTimer = null
  setDiagUpsert(null)
}
