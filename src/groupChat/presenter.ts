// 群聊呈现管线 · 按 roomSeq 严格串行的独立消费者(评审②的落地):
//
//   commit → 宿主立即落盘(群聊页即刷)→ enqueue PresentationItem(roomSeq)
//          → 消费者逐项:presentTurn → speakTracked → await ended(无有效句柄才 holdMs 兜底)
//            notifyTurnSpeechStart 在该项真正开播时调
//
// 三条顺序(必补测试项)一致:群聊文本序 = 舞台呈现序 = TTS 序,全部由 roomSeq 决定。
// cancel():停当前句柄 + 废弃整个待播队列(旧 epoch 项一并作废,I8)。
// 队列非空或正在播期间持有 runtime.presentationHold:whenIdle/静止谓词含 TTS 排空。
// 记忆徽标:每条因果链的徽标由"第一个成功呈现的回复"原子领取(评审④),并发不双标。

import type { ChatMemoryRef } from '../storage/chatLogStore'
import type { ActorId, Clock } from './types'

export interface PresentationItem {
  roomSeq: number
  speaker: ActorId
  text: string
  /** 该回复所属因果链根(徽标按链领取) */
  chainRootId: string
  action?: string
}

export interface RoomPresenterDeps {
  /** 台词上屏 + 动画(气泡停留时长内部决定;action = 情绪动作词表词,呈现侧查表) */
  presentTurn(item: {
    speaker: ActorId
    text: string
    holdMs: number
    memoryRefs?: ChatMemoryRef[]
    action?: string
  }): void
  /** 生命周期句柄;null = 被更高优先级压制/无声 */
  speakTracked(speaker: ActorId, text: string): { started: Promise<'audible' | 'silent'>; ended: Promise<void>; stop(): void } | null
  prefetch?(speaker: ActorId, text: string): void
  /** 一句开始出声(或无声兜底开屏):语音会话据此推进 phase */
  onTurnSpeechStart?(): void
  /** 队列持有/释放运行时的呈现闸(静止谓词包含 TTS 排空) */
  holdRuntime(): () => void
  clock: Clock
}

export interface RoomPresenter {
  enqueue(item: PresentationItem): void
  /** 登记某因果链的记忆徽标载荷(用户消息受理时一次;呈现时原子领取) */
  setBadge(chainRootId: string, refs: ChatMemoryRef[]): void
  /** 取消:停当前句柄 + 废弃待播队列;返回 false = 本来就空 */
  cancel(): boolean
  playing(): boolean
  /** 待播+在播数量(诊断) */
  depth(): number
}

export function createRoomPresenter(deps: RoomPresenterDeps): RoomPresenter {
  const queue: PresentationItem[] = []
  let current: { item: PresentationItem; stop(): void } | null = null
  let running = false
  let wakePending = false
  let releaseHold: (() => void) | null = null
  /** 已领取徽标的因果链根(第一个成功呈现的回复原子领取) */
  const claimedBadges = new Set<string>()
  let pendingBadges = new Map<string, ChatMemoryRef[]>()

  function acquireHold(): void {
    if (!releaseHold) releaseHold = deps.holdRuntime()
  }

  function releaseHoldIfIdle(): void {
    if (releaseHold && queue.length === 0 && !current) {
      releaseHold()
      releaseHold = null
    }
  }

  /** 记忆徽标:同一链只有第一个呈现项携带 */
  function takeBadge(item: PresentationItem): ChatMemoryRef[] | undefined {
    if (claimedBadges.has(item.chainRootId)) return undefined
    const refs = pendingBadges.get(item.chainRootId)
    if (!refs || refs.length === 0) return undefined
    claimedBadges.add(item.chainRootId)
    pendingBadges.delete(item.chainRootId)
    return refs
  }

  /** 供宿主登记某链的徽标载荷(用户消息受理时一次) */
  function setBadge(chainRootId: string, refs: ChatMemoryRef[]): void {
    if (refs.length === 0) return
    pendingBadges.set(chainRootId, refs)
  }

  async function drain(): Promise<void> {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      current = { item, stop: () => {} }
      const handle = deps.speakTracked(item.speaker, item.text)
      current = { item, stop: () => handle?.stop() }
      try {
        deps.presentTurn({
          speaker: item.speaker,
          text: item.text,
          holdMs: holdMsOf(item.text),
          memoryRefs: takeBadge(item),
          action: item.action,
        })
        if (handle && (await handle.started) === 'audible') {
          deps.onTurnSpeechStart?.()
          await handle.ended
        } else {
          // 无声兜底:文本节奏(被压制/勿扰/TTS 失败不影响呈现与推进)
          deps.onTurnSpeechStart?.()
          await new Promise<void>((resolve) => deps.clock.setTimeout(resolve, holdMsOf(item.text)))
        }
      } catch {
        // 呈现/语音故障不吞推进
      } finally {
        current = null
        releaseHoldIfIdle()
      }
    }
  }

  function pump(): void {
    if (running) {
      wakePending = true
      return
    }
    running = true
    void drain().finally(() => {
      running = false
      releaseHoldIfIdle()
      if (wakePending) {
        wakePending = false
        pump()
      }
    })
  }

  return {
    enqueue(item) {
      acquireHold()
      queue.push(item)
      // 正在播时预合成下一句(入队时机 = 消费方还在播上一句,句间零等待)
      if (current && queue[0]) deps.prefetch?.(queue[0].speaker, queue[0].text)
      pump()
    },
    setBadge(chainRootId, refs) {
      setBadge(chainRootId, refs)
    },
    cancel(): boolean {
      const had = queue.length > 0 || current !== null
      queue.length = 0
      current?.stop()
      current = null
      // 取消即废弃整条待播队列:徽标一并作废(链已中断)
      pendingBadges = new Map()
      releaseHoldIfIdle()
      return had
    },
    playing: () => current !== null,
    depth: () => queue.length + (current ? 1 : 0),
  }
}

/** 气泡停留时长(与旧 chatLineHoldMs 同源:2200 + 160/字) */
export function holdMsOf(text: string): number {
  return 2200 + text.length * 160
}
