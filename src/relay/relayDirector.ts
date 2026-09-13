// RelayDirector:多 AI 即兴剧场的本地导演(轮转唯一知识)。
//
// 职责:轮转(双角色固定交替)、提示词装配、两段式失败恢复、重复检测、
// 结束条件判定、会话释放。网页 AI 只负责"扮演当前角色,说下一句";
// 模型输出的 speaker 字段被忽略,谁发言完全由这里决定。
//
// 流水线契约:yield 当前句**之前**预发下一角色的网页请求——播放器消费当前句
// 的展示与 TTS 时间,正好遮住下一句的生成等待。
// 失败语义(提交点):首句产出前失败允许抛错(调用方回退兜底剧本);之后不再
// 抛错——单演员首次失败 reset 重建会话并附全量近况重发,二次失败 yield 另一
// 角色的本地收尾句后 return {natural:false, reason:'failed'}。

import { normalizeRelayText, parseRelayTurn, type ParsedRelayTurn } from './relaySchema'
import { buildRelayTurnPrompt } from './relayPrompt'
import type {
  PreparedRelaySource,
  RelayDirector,
  RelayDirectorDeps,
  RelayEndReason,
  RelayRequest,
  RelaySource,
  RelayTranscriptLine,
} from './types'
import type { DialogLine } from '../performer/player'

/// 单演员连续失败上限:达到即本地收尾(另一角色收句)
const ACTOR_MAX_FAILURES = 2
/// 同一会话成功轮次达到该值,下一请求自动重建标签页(上下文卫生;MVP 轮次到不了,防御性保留)
const CONVERSATION_RESET_TURNS = 15
/// 重复检测窗口:与最近 N 句归一化比对
const DUP_WINDOW = 4

/** 本地收尾句池(两段式失败后的体面散场,不依赖网页模型) */
const CLOSING_LINES = [
  '今天先到这吧，改日再战！',
  '好了好了，今天就聊到这儿～',
  '时间差不多了，各位回见！',
  '先散场，下次接着聊！',
]

export function createRelayDirector(deps: RelayDirectorDeps): RelayDirector {
  const now = deps.now ?? Date.now
  return {
    prepareRelay: (req) => prepare(req, deps, now),
  }
}

async function prepare(
  req: RelayRequest,
  deps: RelayDirectorDeps,
  now: () => number,
): Promise<PreparedRelaySource> {
  if (req.actors.length !== 2) {
    throw new Error('AI剧场 MVP 固定双角色,actors 必须为 2 人')
  }
  const gen = runRelay(req, deps, now)
  const first = await gen.next()
  if (first.done) {
    // 未产出任何台词就结束(两位演员开局即失败):按契约抛错,调用方回退兜底剧本
    throw new Error(`AI剧场首句生成失败(${first.value.reason})`)
  }
  return { first: first.value, rest: gen }
}

async function* runRelay(
  req: RelayRequest,
  deps: RelayDirectorDeps,
  now: () => number,
): RelaySource {
  const [actorA, actorB] = req.actors
  const transcript: RelayTranscriptLine[] = []
  let seq = 0
  let lastIntent: 'continue' | 'end' = 'continue'
  let dupStreak = 0
  const recentNorms: string[] = []
  const startedAt = now()
  const runtimes = new Map<string, { lastSeenSeq: number; failures: number; turnsSinceReset: number }>()
  for (const a of req.actors) {
    runtimes.set(a.speaker, { lastSeenSeq: 0, failures: 0, turnsSinceReset: 0 })
  }

  /** 接受一句入册:编号、重复窗口、阅读游标、意图 */
  function accept(parsed: { text: string; action: string; intent: 'continue' | 'end' }, actorKey: string): DialogLine {
    seq += 1
    const line: RelayTranscriptLine = {
      speaker: actorKey as 'A' | 'B' | 'C',
      text: parsed.text,
      action: parsed.action,
      seq,
    }
    transcript.push(line)
    lastIntent = parsed.intent
    recentNorms.push(normalizeRelayText(parsed.text))
    const rt = runtimes.get(actorKey)
    if (rt) rt.lastSeenSeq = seq
    return line
  }

  /** 结束判定:返回 null = 继续。次序=优先级(取消 > 轮次 > 预算 > 意图) */
  function judge(): { natural: boolean; reason: RelayEndReason } | null {
    if (req.signal.aborted) return { natural: false, reason: 'cancelled' }
    if (transcript.length >= req.maxTurns) return { natural: true, reason: 'max-turns' }
    if (now() - startedAt > req.timeBudgetMs) return { natural: false, reason: 'timeout' }
    if (lastIntent === 'end' && transcript.length >= req.minTurns) {
      return { natural: true, reason: 'model-ended' }
    }
    return null
  }

  /** 单次请求 + 两段式失败恢复;返回 null = 两次都失败(调用方本地收尾) */
  async function askWithRecovery(
    actor: (typeof req.actors)[number],
    turnIndex: number,
  ): Promise<{ text: string; action: string; intent: 'continue' | 'end' } | null> {
    const rt = runtimes.get(actor.speaker)!
    const attempt = async (reset: boolean, recovery: boolean) => {
      const raw = await deps.ask({
        actor,
        prompt: buildRelayTurnPrompt({
          scene: req.scene,
          actor,
          transcript,
          lastSeenSeq: rt.lastSeenSeq,
          turnIndex,
          maxTurns: req.maxTurns,
          opening: turnIndex === 0,
          recovery,
        }),
        timeoutMs: req.perTurnTimeoutMs,
        reset,
        signal: req.signal,
      })
      const parsed = parseRelayTurn(raw)
      if (!parsed) throw new Error('模型输出不可解析')
      return parsed
    }
    try {
      const reset = rt.turnsSinceReset >= CONVERSATION_RESET_TURNS
      const parsed = await attempt(reset, false)
      rt.turnsSinceReset = reset ? 0 : rt.turnsSinceReset + 1
      rt.failures = 0
      return parsed
    } catch {
      rt.failures += 1
      if (rt.failures >= ACTOR_MAX_FAILURES) return null
      // 重试一次:重建会话 + 恢复型提示(网络断了一下,演出继续)
      try {
        const parsed = await attempt(true, true)
        rt.failures = 0
        rt.turnsSinceReset = 0
        return parsed
      } catch {
        rt.failures += 1
        return null
      }
    }
  }

  try {
    const firstParsed = await askWithRecovery(actorA, 0)
    if (!firstParsed) throw new Error('AI剧场首句生成失败')
    let current: ParsedRelayTurn = firstParsed
    let speaker = actorA.speaker
    accept(current, speaker)

    while (true) {
      // 结束判定先行:已注定收场就不再多发网页请求
      const verdict = judge()
      if (verdict?.reason === 'cancelled') {
        // 用户停止:不再产出新台词(已播前缀由播放器侧记账)
        return { lines: [...transcript], ...verdict }
      }
      const nextActor = verdict
        ? null
        : speaker === actorA.speaker
          ? actorB
          : actorA
      // 流水线核心:yield 前预发下一角色的请求,当前句播放时间遮住生成等待
      const nextPromise: Promise<{ line: ParsedRelayTurn | null }> | null = nextActor
        ? askWithRecovery(nextActor, transcript.length).then(
            (line) => ({ line }),
            () => ({ line: null }),
          )
        : null
      yield { speaker: speaker as 'A' | 'B' | 'C', text: current.text, action: current.action }
      if (verdict || !nextActor) {
        // 最后一句已上台(气泡定格交给播放器),按判定收场
        if (verdict) return { lines: [...transcript], ...verdict }
        return { lines: [...transcript], natural: false, reason: 'cancelled' }
      }
      if (req.signal.aborted) {
        return { lines: [...transcript], natural: false, reason: 'cancelled' }
      }

      const outcome = nextPromise ? await nextPromise : { line: null }
      if (!outcome.line) {
        // 两段式失败:由最近成功发言的角色本地收一句,体面散场
        seq += 1
        const closing: RelayTranscriptLine = {
          speaker: speaker as 'A' | 'B' | 'C',
          text: CLOSING_LINES[seq % CLOSING_LINES.length],
          action: 'talk',
          seq,
        }
        transcript.push(closing)
        yield closing
        return { lines: [...transcript], natural: false, reason: 'failed' }
      }

      // 重复检测:连续两轮明显重复 → 丢弃重复句收场(该句不上台)
      const norm = normalizeRelayText(outcome.line.text)
      if (recentNorms.slice(-DUP_WINDOW).includes(norm)) {
        dupStreak += 1
        if (dupStreak >= 2) {
          return { lines: [...transcript], natural: false, reason: 'repetitive' }
        }
      } else {
        dupStreak = 0
      }

      accept(outcome.line, nextActor.speaker)
      speaker = nextActor.speaker
      current = outcome.line
    }
  } finally {
    // 会话释放:正常返回 / 播放器 return()(停止)/ 异常,全部覆盖
    for (const a of req.actors) {
      try {
        deps.release(a.conversationKey)
      } catch {
        // 释放失败静默:后台 sweeper 兜底
      }
    }
  }
}
