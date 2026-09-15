// 旧单飞聊天引擎(兼容回退,groupChatActors.engine='legacy' 时由 ChatSession 分派到这里)。
// 行为与群聊 Actor 化之前完全一致:busy 一票拒绝 + @解析/A/B 轮换 + 一次 LLM 调用生成
// 整批台词(TurnBatch→单句回落)+ 逐句播报。计划保留一个版本,下一版删除;
// 行为矩阵回归在 tests/chatSession.test.mjs(直接加载本文件)。
import type { DialogLine, Speaker } from '../performer/player'
import type { SpeechHandle } from '../engine/tts'
import { generateTurnBatch, generateUserChatReply } from '../engine/llmClient'
import { pushTurn, chatWindow } from '../dialogue/turnWindow'
import { appendChatTurns, type ChatMemoryRef } from '../storage/chatLogStore'
import { emptyTurnMemory, prepareTurnMemory, traceOf } from '../storage/memoryStore'
import { memoryIngestor } from '../memory/ingestor'
import { getConfig } from '../storage/configStore'
import { speak, speakTracked, prefetchVoice } from '../engine/tts'
import { streamVoiceReply } from '../engine/llmClient'
import { diag } from '../diag/store'
import {
  chatLineHoldMs,
  GROUP_ASK_RE,
  newTurnId,
  type SendOptions,
  type ChatHostDeps,
  type ChatEngineDeps,
} from './chatTypes'

export type { SendOptions, ChatHostDeps, ChatEngineDeps } from './chatTypes'

/** 旧链路快照:只有 busy(新链路快照扩展了 catchingUp/actors,本文件保持原样) */
export interface LegacyChatSnapshot {
  /** 应答在飞。演出生成/抉择等待不算(那是导演的状态) */
  busy: boolean
}

export type LegacySendResult = 'accepted' | 'busy' | 'empty'

export interface LegacyChatSession {
  send(raw: string, opts?: SendOptions): Promise<LegacySendResult>
  cancel(): void
  getSnapshot(): LegacyChatSnapshot
  subscribe(listener: () => void): () => void
  whenIdle(): Promise<void>
}

export function createLegacyChatSession(
  host: ChatHostDeps,
  engine: Partial<ChatEngineDeps> = {},
): LegacyChatSession {
  const deps: ChatEngineDeps = {
    turnBatch: (input) => generateTurnBatch({ ...input, window: chatWindow() }),
    singleReply: (target, userText, signal, toolNote, memory, diagTurnId) =>
      generateUserChatReply(target, userText, signal, toolNote, memory, diagTurnId),
    recordTurn: (who, text, meta) => {
      pushTurn({ who, text })
      void appendChatTurns([
        {
          who,
          text,
          id: meta?.entryId,
          parentTurnId: meta?.parentTurnId,
          ts: meta?.ts,
          memoryRefs: meta?.memoryRefs,
          trace: meta?.trace,
        },
      ])
    },
    // 记忆摄取:生产单例(测试可经 engine.memoryIngestor 注入假实现)
    memoryIngestor,    tts: {
      speak: (who, text, d) => {
        void speak(who, text, undefined, 'chat', d)
      },
      speakTracked: (who, text, d) => speakTracked(who, text, undefined, 'voice', d),
      prefetch: (who, text) => prefetchVoice(who, text),
    },
    streamTurn: (input) => streamVoiceReply(input),
    prepareMemory: (input) => prepareTurnMemory(input),
    includeTrace: async () => {
      try {
        return (await getConfig()).memoryDisplay === 'debug'
      } catch {
        return false
      }
    },
    clock: {
      setTimeout: (fn, ms) => {
        const id = window.setTimeout(fn, ms)
        return () => window.clearTimeout(id)
      },
    },
    ...engine,
  }

  let busy = false
  let snapshot: LegacyChatSnapshot = { busy: false }
  const listeners = new Set<() => void>()
  // 在飞代次:cancel 置位;finally 里校验代次再清 busy,防止慢代次覆盖新代次
  let generation = 0
  // 当前在飞的取消源与语音句柄:cancel() 真取消的两个抓手
  let currentAbort: AbortController | null = null
  let currentHandle: SpeechHandle | null = null
  /** 当前在飞回合的诊断会话 id(cancel 时发 cancelRequested 用) */
  let currentTurnId: string | null = null
  const idleWaiters: Array<() => void> = []

  function emit(): void {
    const next = { busy }
    if (next.busy === snapshot.busy) return
    snapshot = next
    listeners.forEach((l) => l())
  }

  function resolveIdle(): void {
    if (!busy) while (idleWaiters.length) idleWaiters.shift()!()
  }

  /** @角色解析:名字/甲乙丙/A B C;无 @ 时在甲乙间轮换(丙需显式点名) */
  function resolveTarget(text: string): Speaker {
    const { A, B, C } = host.names()
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const targetOf: Record<string, Speaker> = {
      [A]: 'A',
      [B]: 'B',
      [C]: 'C',
      甲: 'A',
      乙: 'B',
      丙: 'C',
      A: 'A',
      B: 'B',
      C: 'C',
    }
    const alt = new RegExp(`^\\s*@?(${esc(A)}|${esc(B)}|${esc(C)}|甲|乙|丙|A|B|C)\\s*`)
    const m = text.match(alt)
    if (m) return targetOf[m[1]] ?? 'A'
    rotation = rotation === 'A' ? 'B' : 'A'
    return rotation
  }
  let rotation: Speaker = 'A'

  /** 后台事实提取:候选/合并决策进诊断环(id 级,无正文),提取正文绝不入诊断 */
  function backgroundFacts(text: string, turnId: string | null): void {
    void (async () => {
      const t0 = Date.now()
      try {
        // 摄取器内含账本/证据校验/冲突裁决;报告只含 id 级决策,提取正文绝不入诊断
        const report = await (deps.memoryIngestor ?? memoryIngestor).ingestUserTurn({ turnId, text })
        if (turnId) {
          diag.memoryWrite(turnId, {
            candidates: report.candidateCount,
            changed: report.appliedFactIds.length,
            addedIds: report.appliedFactIds,
            supersededIds: report.supersededFactIds,
            rejected: report.rejected,
            ms: Date.now() - t0,
          })
        }
      } catch (e) {
        if (turnId) {
          diag.memoryWrite(turnId, {
            candidates: 0,
            changed: 0,
            addedIds: [],
            supersededIds: [],
            rejected: 0,
            ms: Date.now() - t0,
            error: String((e as Error)?.message ?? e).slice(0, 120),
          })
        }
      }
    })()
  }

  return {
    send(raw: string, opts: SendOptions = {}): Promise<LegacySendResult> {
      const text = raw.trim()
      if (!text) return Promise.resolve('empty')
      if (busy) return Promise.resolve('busy')
      const who = resolveTarget(text)
      if (host.isPerforming()) {
        // 演出中插话:入队,当前句结束的安全缝处反应并接回剧情
        host.queueInterjection(text, who)
        host.presentUser(text, null)
        host.onUserActive()
        deps.recordTurn('user', text)
        deps.clock.setTimeout(() => host.clearUser(text), 6000)
        return Promise.resolve('accepted')
      }
      busy = true
      emit()
      generation += 1
      const gen = generation
      const cancelled = () => gen !== generation
      const abort = new AbortController()
      currentAbort = abort
      // 稳定轮 id:受理即定,贯穿 chatLog/提取/参考记忆;角色句以 parentTurnId 回链
      const turnId = newTurnId()
      const acceptedAt = Date.now()
      // 诊断:回合受理即开会话(默认档只记结构:长度/语言/盐哈希/target)
      diag.beginTurn({
        id: turnId,
        source: opts.voice ? 'voice' : 'chat',
        text,
        target: who,
        groupAsk: GROUP_ASK_RE.test(text),
        voice: !!opts.voice,
        ts: acceptedAt,
      })
      diag.detailText(turnId, { textKind: 'input', text })
      if (opts.diagAsr) diag.asrResult(turnId, opts.diagAsr)
      host.presentUser(text, who)
      host.onUserActive()
      deps.recordTurn('user', text, { entryId: turnId, ts: acceptedAt })
      // 应答全程不阻塞受理返回:调用方发完即清输入,应答靠落盘订阅实时冒出
      void (async () => {
        const sleep = (ms: number) => new Promise<void>((r) => deps.clock.setTimeout(r, ms))
        currentTurnId = turnId
        // 诊断:回合结果在所有出口统一收口(呈现句数即回复句数;语音是否真出声由 tts 段事件回答)
        let presentCount = 0
        let replyChars = 0
        const finishTurn = (outcome: 'spoke' | 'silent' | 'failed' | 'cancelled'): void => {
          diag.turnFinished(turnId, {
            outcome,
            totalMs: Date.now() - acceptedAt,
            replyChars,
            replySentences: presentCount,
          })
          // 定稿:once 模式的详情捕获在此自动关闭;后台记忆写入仍会迟到追加
          diag.finish(turnId)
        }
        // 回合记忆上下文:受理后检索一次;prompt 注入与 present/record 引用全部由它派生
        const memoryT0 = Date.now()
        const memory = (await deps.prepareMemory?.({ query: text, n: 3 }).catch(() => emptyTurnMemory())) ?? emptyTurnMemory()
        // 诊断:注入了哪些记忆 id、检索候选与落选原因(id/分数/枚举,无正文)
        diag.memorySelection(turnId, {
          ms: Date.now() - memoryT0,
          selected: memory.selected.map((s) => ({ id: s.id, score: s.score, source: s.source })),
          candidates: memory.candidates.map((c) => ({ id: c.id, score: c.score, outcome: c.outcome })),
        })
        const withTrace = (await deps.includeTrace?.().catch(() => false)) ?? false
        const turnTrace = withTrace ? traceOf(memory) : undefined
        let turnRefsCombined: ChatMemoryRef[] = [...memory.refs]
        let firstShown = false // 记忆徽标只在首句气泡出现
        let firstRecorded = false
        /** 回复句的落盘 meta:首条回复携带引用与 trace,其余以 parentTurnId 归组 */
        const replyMeta = () => {
          const first = !firstRecorded
          firstRecorded = true
          return {
            entryId: newTurnId(),
            parentTurnId: turnId,
            ts: Date.now(),
            memoryRefs: first && turnRefsCombined.length > 0 ? turnRefsCombined : undefined,
            trace: first ? turnTrace : undefined,
          }
        }
        /** 呈现一句(首句携带参考记忆徽标;TTS 故障不吞呈现) */
        const present = (l: DialogLine): number => {
          presentCount += 1
          replyChars += l.text.length
          const holdMs = chatLineHoldMs(l.text)
          diag.actionFired(turnId, { speaker: l.speaker, action: l.action ?? 'talk', seg: presentCount - 1 })
          diag.detailText(turnId, { textKind: 'reply', text: l.text, seg: presentCount - 1 })
          try {
            host.presentTurn({
              speaker: l.speaker,
              text: l.text,
              holdMs,
              memoryRefs: !firstShown && turnRefsCombined.length > 0 ? turnRefsCombined : undefined,
            })
            firstShown = true
          } catch {
            // 呈现故障不吞落盘:台词已入短期窗口,下轮对话仍有上下文
          }
          return holdMs
        }
        try {
          // 工具回合:用户发起的回合先过工具协调(要不要截图/识字/查记忆)。
          // 协调器内部失败自会回落,这里只怕用户取消;观察块由生成函数注入,
          // 永不进 backgroundFacts——不可信数据不入长期记忆
          let toolNote: string | undefined
          if (deps.tools) {
            const toolsT0 = Date.now()
            const prep = await deps.tools({ userText: text }, abort.signal)
            diag.toolsPrepare(turnId, {
              ms: Date.now() - toolsT0,
              clarified: !!prep.clarify,
              hasNote: !!prep.note,
              memoryRefs: prep.memoryRefs?.length ?? 0,
            })
            if (cancelled() || abort.signal.aborted) {
              finishTurn('cancelled')
              return
            }
            if (prep.clarify) {
              // 意图含糊:角色反问一句,本回合到此为止(不烧一次生成)
              const clar: DialogLine = { speaker: who, text: prep.clarify, action: 'talk' }
              present(clar)
              deps.tts.speak(who, prep.clarify, { turnId, segIndex: 0 })
              deps.recordTurn(who, prep.clarify)
              deps.clock.setTimeout(() => host.clearUser(text), 400)
              finishTurn('spoke')
              return
            }
            toolNote = prep.note
            // search_memory 命中的记忆并入总注入集合(不变量:present=record=总注入)
            for (const r of prep.memoryRefs ?? []) {
              if (!turnRefsCombined.some((x) => x.id === r.id)) turnRefsCombined.push(r)
            }
          }
          const groupAsk = GROUP_ASK_RE.test(text)
          /** 语音单句:气泡随首帧声音上屏;台词播完才提交(句级提交——打断时
           *  "说到一半"的句子不进上下文,与 barge-in 截断语义对齐) */
          const speakLine = async (l: DialogLine, seg: number): Promise<void> => {
            const handle = deps.tts.speakTracked?.(l.speaker, l.text, { turnId, segIndex: seg }) ?? null
            // 先登记再等首声:cancel 从登记那一刻起就能句柄级停声,无死角
            if (handle) currentHandle = handle
            if (!handle || (await handle.started) !== 'audible') {
              // 被更高优先级压制/无声收场(勿扰/静音/TTS 失败):文本节奏兜底
              if (cancelled()) return
              if (currentHandle === handle) currentHandle = null
              const holdMs = present(l)
              host.onTurnSpeechStart?.()
              deps.recordTurn(l.speaker, l.text, replyMeta())
              await sleep(holdMs)
              return
            }
            if (cancelled()) return
            present(l)
            host.onTurnSpeechStart?.()
            await handle.ended
            if (currentHandle === handle) currentHandle = null
            if (cancelled()) return // 打断:本句不提交
            deps.recordTurn(l.speaker, l.text, replyMeta())
          }
          /** 整批顺序播:播第 i 句时预合成第 i+1(句间零等待) */
          const runBatch = async (lines: DialogLine[]): Promise<void> => {
            for (let i = 0; i < lines.length; i++) {
              if (cancelled()) return
              const nxt = lines[i + 1]
              if (nxt) deps.tts.prefetch?.(nxt.speaker, nxt.text)
              await speakLine(lines[i], i)
            }
          }
          /** 整段兜底:turnBatch 失败回落单句应答(原语义) */
          const batchFallback = async (): Promise<DialogLine[]> => {
            let batch: DialogLine[] | null = null
            try {
              batch = await deps.turnBatch({ userText: text, target: who, groupAsk, signal: abort.signal, toolNote, memory, diagTurnId: turnId })
            } catch (e) {
              if (cancelled() || (e as Error)?.name === 'AbortError') throw e
              diag.fallback(turnId, {
                call: 'turnBatch',
                from: 'turnBatch',
                reason: `整批失败 → 单句回落:${String((e as Error)?.message ?? e).slice(0, 100)}`,
              })
              batch = null // 静默回落
            }
            if (!batch || batch.length === 0) {
              diag.fallback(turnId, { call: 'singleReply', from: 'turnBatch', reason: '整批为空 → 单句回落' })
              batch = [
                { speaker: who, text: await deps.singleReply(who, text, abort.signal, toolNote, memory, turnId), action: 'talk' },
              ]
            }
            return batch
          }
          if (opts.voice) {
            // 语音路径,流式优先:句子边流边说(首句闭合即说,不等后续)。
            // 提交点(设计 §4.1):首句产出前失败 → 整段回落重生成(无任何上屏,安全);
            // 已出声 ≥1 句后失败 → 保留已完成句,只补一句轻提示,绝不整段重生成(防重复回答)
            let spoken = 0
            let streamBroken = false
            const iter = deps.streamTurn?.({
              userText: text,
              target: who,
              signal: abort.signal,
              toolNote,
              memory,
              diagTurnId: turnId,
              onQueued: (l) => deps.tts.prefetch?.(l.speaker, l.text),
            })
            if (iter) {
              try {
                for await (const l of iter) {
                  if (cancelled()) {
                    finishTurn('cancelled')
                    return
                  }
                  await speakLine(l, spoken)
                  spoken += 1
                }
              } catch (e) {
                if (cancelled() || (e as Error)?.name === 'AbortError') {
                  finishTurn('cancelled')
                  return
                }
                streamBroken = true
                diag.fallback(turnId, {
                  call: 'streamVoice',
                  from: 'stream',
                  reason: `流式中断 → ${spoken > 0 ? '保留已说部分' : '整段回落'}:${String((e as Error)?.message ?? e).slice(0, 100)}`,
                })
              }
            }
            if (spoken === 0) {
              await runBatch(await batchFallback())
            } else if (streamBroken) {
              host.presentFallback({ speaker: who, text: '（信号断了，先说到这…）' })
            }
          } else {
            const batch = await batchFallback()
            for (let i = 0; i < batch.length; i++) {
              const l = batch[i]
              if (cancelled()) {
                finishTurn('cancelled')
                return // 取消:迟到内容不再呈现
              }
              const holdMs = present(l)
              try {
                deps.tts.speak(l.speaker, l.text, { turnId, segIndex: i })
              } catch {
                // TTS 故障不吞落盘(文本呈现与提交照常)
              }
              deps.recordTurn(l.speaker, l.text, replyMeta())
              await sleep(holdMs)
            }
          }
          if (!cancelled()) {
            deps.clock.setTimeout(() => host.clearUser(text), 400)
          }
          // runBatch 逐句间被取消会静默返回,不能按 spoke 定稿
          finishTurn(cancelled() ? 'cancelled' : presentCount > 0 ? 'spoke' : 'silent')
        } catch (e) {
          if (cancelled() || (e as Error)?.name === 'AbortError') {
            finishTurn('cancelled')
            return
          }
          host.clearUser(text)
          host.presentFallback({
            speaker: who,
            text: '（信号不好，没听清…再说一遍？）',
          })
          finishTurn('failed')
        } finally {
          if (gen === generation) {
            currentAbort = null
            currentTurnId = null
            busy = false
            emit()
            resolveIdle()
          }
        }
        backgroundFacts(text, turnId)
      })()
      return Promise.resolve('accepted')
    },

    cancel(): void {
      if (!busy) return
      generation += 1 // 在飞代次全部作废:迟到响应/收尾路径按 cancelled() 丢弃
      if (currentTurnId) {
        diag.cancelRequested(currentTurnId, {
          generation,
          hadHandle: !!currentHandle,
          hadAbort: !!currentAbort,
        })
      }
      currentAbort?.abort() // 真取消:LLM 请求/流读取随 signal 断开,不烧额度
      currentHandle?.stop() // 句柄级停声:只停本轮语音,不碰提醒/工具播报
      currentHandle = null
      busy = false
      emit()
      resolveIdle()
    },

    getSnapshot: () => snapshot,

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    whenIdle(): Promise<void> {
      if (!busy) return Promise.resolve()
      return new Promise((r) => idleWaiters.push(r))
    },
  }
}
