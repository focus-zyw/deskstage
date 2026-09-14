// 群聊日志(RoomJournal)· 内存事实源:roomSeq 分配、消息追加、按游标取增量。
//
// 定位是「会话内可靠队列」:FIFO/ACK 强一致发生在内存;持久层 chatlog.jsonl 只提供
// 历史与上下文。重启后 journal 为空,由宿主用 listChatTurns 引导最近若干条(context-only,
// 各角色 ackedThrough 初始化为已见最大 roomSeq)——重启绝不重答旧批次,也不恢复待处理消息。
// roomSeq 严格递增且一经分配不变;id = "m{roomSeq}",短 id 便于模型在 replyTo 里引用。

import type { Clock, RoomAuthor, RoomMessage } from './types'

const MAX_MEMORY_MESSAGES = 500

export interface RoomJournal {
  /** 追加一条消息(分配 roomSeq 与 id);文本空串拒收抛错——调用方保证非空 */
  append(input: {
    author: RoomAuthor
    kind?: 'chat' | 'control'
    text: string
    epoch: number
    causalRootId: string
    depth: number
    replyTo?: string[]
  }): RoomMessage
  /** 全量快照(旧在后);只读视图,调用方不得改写 */
  list(): readonly RoomMessage[]
  /** roomSeq > seq 的消息(作者过滤由调用方做——"不收自己的消息"是投递语义) */
  after(seq: number): RoomMessage[]
  maxSeq(): number
  /** 启动引导:历史消息按原顺序占位 seq 1..n(context-only,不触发任何投递) */
  bootstrap(entries: Array<{ author: RoomAuthor; text: string; ts: number }>): void
  clear(): void
}

export function createRoomJournal(clock: Clock): RoomJournal {
  let messages: RoomMessage[] = []
  let seq = 0

  return {
    append(input) {
      const text = input.text.trim()
      if (!text) throw new Error('room message 空文本')
      seq += 1
      const msg: RoomMessage = {
        id: `m${seq}`,
        roomSeq: seq,
        epoch: input.epoch,
        author: input.author,
        kind: input.kind ?? 'chat',
        text,
        createdAt: clock.now(),
        causalRootId: input.causalRootId,
        depth: input.depth,
        replyTo: [...(input.replyTo ?? [])],
      }
      messages.push(msg)
      if (messages.length > MAX_MEMORY_MESSAGES) {
        messages = messages.slice(-MAX_MEMORY_MESSAGES)
      }
      return msg
    },

    list: () => messages,
    after: (s) => messages.filter((m) => m.roomSeq > s),
    maxSeq: () => seq,

    bootstrap(entries) {
      for (const e of entries) {
        const text = e.text.trim()
        if (!text) continue
        seq += 1
        const msg: RoomMessage = {
          id: `m${seq}`,
          roomSeq: seq,
          epoch: 0,
          author: e.author,
          kind: 'chat',
          text,
          createdAt: e.ts,
          causalRootId: `m${seq}`,
          depth: 0,
          replyTo: [],
        }
        messages.push(msg)
      }
      if (messages.length > MAX_MEMORY_MESSAGES) {
        messages = messages.slice(-MAX_MEMORY_MESSAGES)
      }
    },

    clear() {
      messages = []
      seq = 0
    },
  }
}
