// 聊天会话 · 深模块:用户聊天这条完整业务链的唯一入口(主聊天框/群聊页/语音闭环共用)。
//
// 对外形状是外部 store(React 经 useSyncExternalStore 消费,plain 调用方直接
// await send / 轮询 getSnapshot):
//   send(text, opts?) → 'accepted' | 'busy' | 'empty'
//     opts.voice = 语音对话路径:气泡随首帧声音上屏;台词播完才提交(句级提交,
//     打断后"说到一半"的句子不进上下文);推进节奏由语音 ended 驱动而非定时长
//   cancel()    → 真取消:AbortController 断开在飞 LLM 请求 + 句柄级停声,
//                 迟到内容不再呈现(订阅者不会看到半截回复)
//   getSnapshot() / subscribe()
//   whenIdle()  → 在飞应答结束(测试与退出清理用)
//
// 内部隐藏:@角色解析与 A/B 轮换、LLM(TurnBatch→单句回落)、逐句播报节奏、
// 短期窗口与聊天落盘双轨、后台事实提取、busy 状态、演出中改走插话队列。
//
// 依赖边界(测试用内存 adapter 跑行为矩阵,见 tests/chatSession.test.mjs):
//   · host 侧(必须注入,天然属于宿主):呈现三回调、名字、演出状态、活跃信号
//   · 引擎/存储侧(有默认实现,测试可覆盖):LLM、落盘双轨、事实提取、TTS、时钟
//     —— TTS 只经 tts.speak / speakTracked 通知,失败被吞:文本呈现永不因语音失败中断
//
// 本模块不 import 任何 DOM/Tauri 之外的重物,也不持有舞台状态:呈现只经回调
// 交还 presenter(与 usePerformanceDirector 的导演/舞台分界同款思路)。
import type { DialogLine, Speaker } from '../performer/player'
import type { SpeechHandle } from '../engine/tts'
import { generateTurnBatch, generateUserChatReply, extractFacts } from '../engine/llmClient'
import { pushTurn, chatWindow, type TurnWho } from '../dialogue/turnWindow'
import { appendChatTurns } from '../storage/chatLogStore'
import { getMemory, topFacts, mergeFacts, type FactCategory } from '../storage/memoryStore'
import { speak, speakTracked, prefetchVoice } from '../engine/tts'
import { streamVoiceReply } from '../engine/llmClient'

export type SendResult = 'accepted' | 'busy' | 'empty'

export interface SendOptions {
  /** 语音对话路径:首帧声音上屏 + 句级提交 + ended 驱动推进 */
  voice?: boolean
}

export interface ChatSnapshot {
  /** 应答在飞。演出生成/抉择等待不算(那是导演的状态) */
  busy: boolean
}

/** 单句台词的上屏停留时长(呈现 ms 与逐句节奏同源) */
export function chatLineHoldMs(text: string): number {
  return 2200 + text.length * 160
}

/** 明确同时问三人才放开 TurnBatch(与旧判定一致) */
const GROUP_ASK_RE = /你们|大家|各位|三位|每人|各自|都怎么|都说说/

export interface ChatHostDeps {
  /** 当前角色名(设置可改名;每次 send 时取最新) */
  names(): { A: string; B: string; C: string }
  /** 演出中?聊天改走插话队列,句尾安全缝反应后接回剧情 */
  isPerforming(): boolean
  queueInterjection(text: string, who: Speaker): void
  /** 呈现一句角色台词(上屏+动画;TTS 由 tts 通知,失败不影响本回调) */
  presentTurn(line: { speaker: Speaker; text: string; holdMs: number }): void
  /** 用户这句话上屏;who 非空 = 空闲路径(顺带聚焦该角色),null = 演出插话路径 */
  presentUser(text: string, who: Speaker | null): void
  /** 收走用户气泡;文本不符(已被顶掉)时保持不动 */
  clearUser(text: string): void
  /** 应答失败的兜底台词 */
  presentFallback(line: { speaker: Speaker; text: string }): void
  /** 用户活跃信号(主动行为调度) */
  onUserActive(): void
  /** 语音路径:一句开始出声(或无声兜底开屏)。语音会话据此把 phase 推进到「正在说」 */
  onTurnSpeechStart?(): void
}

/** 引擎/存储侧可覆盖的默认实现 */
export interface ChatEngineDeps {
  turnBatch(input: {
    userText: string
    target: Speaker
    groupAsk: boolean
    /** 取消信号:贯穿到网关,打断 = 真断请求 */
    signal?: AbortSignal
    /** 工具观察块(工具系统渲染好的不可信资料;原样附加到用户消息后) */
    toolNote?: string
  }): Promise<DialogLine[]>
  singleReply(target: Speaker, userText: string, signal?: AbortSignal, toolNote?: string): Promise<string>
  /** 角色工具协调(可选):用户回合先过工具系统——本句话要不要截图/识字/查记忆。
   *  返回的 note 由协调器渲染好(截断+不可信包裹),这里只透传给生成函数;
   *  clarify 直接作为本回合回复。协调失败回落普通聊天,永不阻塞消息收发 */
  tools?(input: { userText: string }, signal: AbortSignal): Promise<{
    userText: string
    note?: string
    clarify?: string
  }>
  recordTurn(who: TurnWho, text: string): void
  facts: {
    known(): Promise<string[]>
    extract(text: string, known: string[]): Promise<{ content: string; category: FactCategory }[]>
    merge(candidates: { content: string; category?: FactCategory }[]): Promise<unknown>
  }
  tts: {
    speak(who: Speaker, text: string): void
    /** 语音路径:生命周期句柄;null = 被更高优先级压制。返回句柄由会话持有,
     *  cancel() 时句柄级停声(不全局 stopSpeaking,不碰提醒/工具播报) */
    speakTracked?(who: Speaker, text: string): SpeechHandle | null
    /** 预合成(不播):语音路径在播第 i 句时预合成第 i+1,句间零等待 */
    prefetch?(who: Speaker, text: string): void
  }
  /** 语音流式应答(可选):逐句 yield,调用方边流边说。提交点(设计 §4.1):
   *  首句前失败 = 抛错(整段回落重生成安全);已有句后失败 = 排空已完成句再抛
   *  (调用方只补提示)。缺省 = 无流式,语音路径退回 turnBatch 整段 */
  streamTurn?(input: {
    userText: string
    target: Speaker
    signal?: AbortSignal
    toolNote?: string
    /** 句子入队回调(入队时机 = 消费方还在播上一句,正好预合成) */
    onQueued?(line: DialogLine): void
  }): AsyncGenerator<DialogLine>
  clock: { setTimeout(fn: () => void, ms: number): () => void }
}

export interface ChatSession {
  send(raw: string, opts?: SendOptions): Promise<SendResult>
  cancel(): void
  getSnapshot(): ChatSnapshot
  subscribe(listener: () => void): () => void
  whenIdle(): Promise<void>
}

export function createChatSession(
  host: ChatHostDeps,
  engine: Partial<ChatEngineDeps> = {},
): ChatSession {
  const deps: ChatEngineDeps = {
    turnBatch: (input) => generateTurnBatch({ ...input, window: chatWindow() }),
    singleReply: (target, userText, signal, toolNote) => generateUserChatReply(target, userText, signal, toolNote),
    recordTurn: (who, text) => {
      pushTurn({ who, text })
      void appendChatTurns([{ who, text }])
    },
    facts: {
      known: async () => topFacts(await getMemory(), 8),
      extract: (text, known) => extractFacts(text, known),
      merge: (candidates) => mergeFacts(candidates),
    },
    tts: {
      speak: (who, text) => {
        void speak(who, text, undefined, 'chat')
      },
      speakTracked: (who, text) => speakTracked(who, text, undefined, 'voice'),
      prefetch: (who, text) => prefetchVoice(who, text),
    },
    streamTurn: (input) => streamVoiceReply(input),
    clock: {
      setTimeout: (fn, ms) => {
        const id = window.setTimeout(fn, ms)
        return () => window.clearTimeout(id)
      },
    },
    ...engine,
  }

  let busy = false
  let snapshot: ChatSnapshot = { busy: false }
  const listeners = new Set<() => void>()
  // 在飞代次:cancel 置位;finally 里校验代次再清 busy,防止慢代次覆盖新代次
  let generation = 0
  // 当前在飞的取消源与语音句柄:cancel() 真取消的两个抓手
  let currentAbort: AbortController | null = null
  let currentHandle: SpeechHandle | null = null
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

  function backgroundFacts(text: string): void {
    void (async () => {
      try {
        const known = await deps.facts.known()
        const candidates = await deps.facts.extract(text, known)
        if (candidates.length > 0) await deps.facts.merge(candidates)
      } catch {
        // 后台记忆提取:不阻塞、失败静默
      }
    })()
  }

  return {
    send(raw: string, opts: SendOptions = {}): Promise<SendResult> {
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
      host.presentUser(text, who)
      host.onUserActive()
      deps.recordTurn('user', text)
      // 应答全程不阻塞受理返回:调用方发完即清输入,应答靠落盘订阅实时冒出
      void (async () => {
        const sleep = (ms: number) => new Promise<void>((r) => deps.clock.setTimeout(r, ms))
        /** 呈现一句(TTS 故障不吞呈现);返回本句节奏时长 */
        const present = (l: DialogLine): number => {
          const holdMs = chatLineHoldMs(l.text)
          try {
            host.presentTurn({ speaker: l.speaker, text: l.text, holdMs })
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
            const prep = await deps.tools({ userText: text }, abort.signal)
            if (cancelled() || abort.signal.aborted) return
            if (prep.clarify) {
              // 意图含糊:角色反问一句,本回合到此为止(不烧一次生成)
              host.presentTurn({ speaker: who, text: prep.clarify, holdMs: chatLineHoldMs(prep.clarify) })
              deps.tts.speak(who, prep.clarify)
              deps.recordTurn(who, prep.clarify)
              deps.clock.setTimeout(() => host.clearUser(text), 400)
              return
            }
            toolNote = prep.note
          }
          const groupAsk = GROUP_ASK_RE.test(text)
          /** 语音单句:气泡随首帧声音上屏;台词播完才提交(句级提交——打断时
           *  "说到一半"的句子不进上下文,与 barge-in 截断语义对齐) */
          const speakLine = async (l: DialogLine): Promise<void> => {
            const handle = deps.tts.speakTracked?.(l.speaker, l.text) ?? null
            // 先登记再等首声:cancel 从登记那一刻起就能句柄级停声,无死角
            if (handle) currentHandle = handle
            if (!handle || (await handle.started) !== 'audible') {
              // 被更高优先级压制/无声收场(勿扰/静音/TTS 失败):文本节奏兜底
              if (cancelled()) return
              if (currentHandle === handle) currentHandle = null
              const holdMs = present(l)
              host.onTurnSpeechStart?.()
              deps.recordTurn(l.speaker, l.text)
              await sleep(holdMs)
              return
            }
            if (cancelled()) return
            present(l)
            host.onTurnSpeechStart?.()
            await handle.ended
            if (currentHandle === handle) currentHandle = null
            if (cancelled()) return // 打断:本句不提交
            deps.recordTurn(l.speaker, l.text)
          }
          /** 整批顺序播:播第 i 句时预合成第 i+1(句间零等待) */
          const runBatch = async (lines: DialogLine[]): Promise<void> => {
            for (let i = 0; i < lines.length; i++) {
              if (cancelled()) return
              const nxt = lines[i + 1]
              if (nxt) deps.tts.prefetch?.(nxt.speaker, nxt.text)
              await speakLine(lines[i])
            }
          }
          /** 整段兜底:turnBatch 失败回落单句应答(原语义) */
          const batchFallback = async (): Promise<DialogLine[]> => {
            let batch: DialogLine[] | null = null
            try {
              batch = await deps.turnBatch({ userText: text, target: who, groupAsk, signal: abort.signal, toolNote })
            } catch (e) {
              if (cancelled() || (e as Error)?.name === 'AbortError') throw e
              batch = null // 静默回落
            }
            if (!batch || batch.length === 0) {
              batch = [
                { speaker: who, text: await deps.singleReply(who, text, abort.signal, toolNote), action: 'talk' },
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
              onQueued: (l) => deps.tts.prefetch?.(l.speaker, l.text),
            })
            if (iter) {
              try {
                for await (const l of iter) {
                  if (cancelled()) return
                  await speakLine(l)
                  spoken += 1
                }
              } catch (e) {
                if (cancelled() || (e as Error)?.name === 'AbortError') return
                streamBroken = true
              }
            }
            if (spoken === 0) {
              await runBatch(await batchFallback())
            } else if (streamBroken) {
              host.presentFallback({ speaker: who, text: '（信号断了，先说到这…）' })
            }
          } else {
            const batch = await batchFallback()
            for (const l of batch) {
              if (cancelled()) return // 取消:迟到内容不再呈现
              const holdMs = present(l)
              try {
                deps.tts.speak(l.speaker, l.text)
              } catch {
                // TTS 故障不吞落盘(文本呈现与提交照常)
              }
              deps.recordTurn(l.speaker, l.text)
              await sleep(holdMs)
            }
          }
          if (!cancelled()) {
            deps.clock.setTimeout(() => host.clearUser(text), 400)
          }
        } catch (e) {
          if (cancelled() || (e as Error)?.name === 'AbortError') return
          host.clearUser(text)
          host.presentFallback({
            speaker: who,
            text: '（信号不好，没听清…再说一遍？）',
          })
        } finally {
          if (gen === generation) {
            currentAbort = null
            busy = false
            emit()
            resolveIdle()
          }
        }
        backgroundFacts(text)
      })()
      return Promise.resolve('accepted')
    },

    cancel(): void {
      if (!busy) return
      generation += 1 // 在飞代次全部作废:迟到响应/收尾路径按 cancelled() 丢弃
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
