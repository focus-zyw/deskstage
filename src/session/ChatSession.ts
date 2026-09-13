// 聊天会话 · 深模块:用户聊天这条完整业务链的唯一入口(主聊天框/群聊页共用)。
//
// 对外形状是外部 store(React 经 useSyncExternalStore 消费,plain 调用方直接
// await send / 轮询 getSnapshot):
//   send(text)  → 'accepted' | 'busy' | 'empty'
//   cancel()    → 取消在飞应答:迟到内容不再呈现(订阅者不会看到半截回复)
//   getSnapshot() / subscribe()
//   whenIdle()  → 在飞应答结束(测试与退出清理用)
//
// 内部隐藏:@角色解析与 A/B 轮换、LLM(TurnBatch→单句回落)、逐句播报节奏、
// 短期窗口与聊天落盘双轨、后台事实提取、busy 状态、演出中改走插话队列。
//
// 依赖边界(测试用内存 adapter 跑行为矩阵,见 tests/chatSession.test.mjs):
//   · host 侧(必须注入,天然属于宿主):呈现三回调、名字、演出状态、活跃信号
//   · 引擎/存储侧(有默认实现,测试可覆盖):LLM、落盘双轨、事实提取、TTS、时钟
//     —— TTS 只经 tts.speak 通知,失败被吞:文本呈现永不因语音失败中断
//
// 本模块不 import 任何 DOM/Tauri 之外的重物,也不持有舞台状态:呈现只经回调
// 交还 presenter(与 usePerformanceDirector 的导演/舞台分界同款思路)。
import type { DialogLine, Speaker } from '../performer/player'
import { generateTurnBatch, generateUserChatReply, extractFacts } from '../engine/llmClient'
import { pushTurn, chatWindow, type TurnWho } from '../dialogue/turnWindow'
import { appendChatTurns } from '../storage/chatLogStore'
import { getMemory, topFacts, mergeFacts, type FactCategory } from '../storage/memoryStore'
import { speak } from '../engine/tts'

export type SendResult = 'accepted' | 'busy' | 'empty'

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
}

/** 引擎/存储侧可覆盖的默认实现 */
export interface ChatEngineDeps {
  turnBatch(input: {
    userText: string
    target: Speaker
    groupAsk: boolean
  }): Promise<DialogLine[]>
  singleReply(target: Speaker, userText: string): Promise<string>
  recordTurn(who: TurnWho, text: string): void
  facts: {
    known(): Promise<string[]>
    extract(text: string, known: string[]): Promise<{ content: string; category: FactCategory }[]>
    merge(candidates: { content: string; category?: FactCategory }[]): Promise<unknown>
  }
  tts: { speak(who: Speaker, text: string): void }
  clock: { setTimeout(fn: () => void, ms: number): () => void }
}

export interface ChatSession {
  send(raw: string): Promise<SendResult>
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
    singleReply: (target, userText) => generateUserChatReply(target, userText),
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
  let snapshot: ChatSnapshot = { busy: false }
  const listeners = new Set<() => void>()
  // 在飞代次:cancel 置位;finally 里校验代次再清 busy,防止慢代次覆盖新代次
  let generation = 0
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
    send(raw): Promise<SendResult> {
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
      host.presentUser(text, who)
      host.onUserActive()
      deps.recordTurn('user', text)
      // 应答全程不阻塞受理返回:调用方发完即清输入,应答靠落盘订阅实时冒出
      void (async () => {
        try {
          // TurnBatch:默认只由被@角色回答;明确同时问三人才放开三句。
          // 生成失败回落单句应答(原行为)
          const groupAsk = GROUP_ASK_RE.test(text)
          let batch: DialogLine[] | null = null
          try {
            batch = await deps.turnBatch({ userText: text, target: who, groupAsk })
          } catch {
            batch = null // 静默回落
          }
          if (!batch || batch.length === 0) {
            batch = [{ speaker: who, text: await deps.singleReply(who, text), action: 'talk' }]
          }
          for (const l of batch) {
            if (cancelled()) return // 取消:迟到内容不再呈现
            const holdMs = chatLineHoldMs(l.text)
            try {
              host.presentTurn({ speaker: l.speaker, text: l.text, holdMs })
              deps.tts.speak(l.speaker, l.text)
            } catch {
              // 呈现/TTS 故障不吞落盘:台词已入短期窗口,下轮对话仍有上下文
            }
            deps.recordTurn(l.speaker, l.text)
            await new Promise<void>((r) => deps.clock.setTimeout(r, holdMs))
          }
          if (!cancelled()) {
            deps.clock.setTimeout(() => host.clearUser(text), 400)
          }
        } catch {
          host.clearUser(text)
          host.presentFallback({
            speaker: who,
            text: '（信号不好，没听清…再说一遍？）',
          })
        } finally {
          if (gen === generation) {
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
