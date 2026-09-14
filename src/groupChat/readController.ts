// GroupChatReadController · 群聊未读与视口控制的深模块(方案 §5/§6/§7)。
//
// 页面只喂事实、只执行效果,不自行维护容易互相冲突的七八个状态:
//   setEntries(日志变化) / setView(视口与活动事实) / requestJump(点按钮)
//       → ReadEffect(none | scroll-bottom | scroll-message | preserve-viewport)
//       → GroupChatReadSnapshot(active/nearBottom/unreadCount/firstUnreadId/label)
//
// 模块内部维护三组正交事实(§6):
//   active      设置窗可见 + 有焦点 + 当前是群聊分页(页面判定后喂入)
//   nearBottom  距底部 < NEAR_BOTTOM_PX
//   cursor      最后实际看过的消息 ID(只能沿消息顺序向前移动,§7)
//
// 行为规则(§6):
//   用户自己发送           → 不计未读;从群聊页发送时滚到底部(notifyOwnSend)
//   角色消息+active+贴底   → 自动滚到底 + 推进游标
//   角色消息+非 active     → 不滚动,累计未读
//   角色消息+active+读历史 → 保持像素位置(preserve-viewport),累计未读
//
// 游标判定(§7):完全进入可视区才推进(页面用 IntersectionObserver 喂
// lastFullyVisibleId);滚到接近底部时一次性推进到最后一条;游标单调前进。
// 用户消息不计未读,但可作为游标位置。
//
// 定向回复(§10):不新增协议字段——entry.parentTurnId 命中,或 replyTo 指向
// 用户消息 ID,即视为"回复了你";@用户名只能辅助,不作依据。
//
// 本模块零 DOM、零 IO:游标持久化经 opts 注入(读自 groupChatReadStore),
// 时钟可注入(测试用手动时钟)。

import type { ChatLogEntry } from '../storage/chatLogStore'
import type { ActorId } from './types'

export const NEAR_BOTTOM_PX = 120

export interface GroupChatReadSnapshot {
  active: boolean
  nearBottom: boolean
  unreadCount: number
  firstUnreadId: string | null
  latestTargetedActor: ActorId | null
  label: string | null
}

export type ReadEffect =
  | { type: 'none' }
  | { type: 'scroll-bottom' }
  | { type: 'scroll-message'; id: string }
  | { type: 'preserve-viewport' }

export type EntriesCause = 'initial' | 'append' | 'prepend' | 'clear'

export interface GroupChatReadController {
  setEntries(entries: ChatLogEntry[], cause: EntriesCause): ReadEffect
  setView(input: {
    active: boolean
    distanceToBottom: number
    lastFullyVisibleId: string | null
  }): ReadEffect
  /** 从群聊页发送:视口立即贴底,且下一条追加按"跟随"处理(§6) */
  notifyOwnSend(): ReadEffect
  requestJump(): ReadEffect
  getSnapshot(): GroupChatReadSnapshot
  subscribe(listener: () => void): () => void
  dispose(): void
}

export interface GroupChatReadControllerOpts {
  /** 当前持久游标(启动时从 groupChatReadStore 读入) */
  getCursor(): string | null
  /** 游标推进/清空(entryId=null)= 清空已读;实现负责防抖与落盘广播 */
  setCursor(entryId: string | null): void
  /** 角色名(按钮文案"柯南回复了你") */
  nameOf(actor: ActorId): string
}

const USER_SET_CACHE = new WeakMap<ChatLogEntry[], Set<string>>()

/** 定向回复判定(§10):parentTurnId 命中,或 replyTo 指向用户消息 ID */
export function isTargetedReply(entry: ChatLogEntry, userMessageIds: Set<string>): boolean {
  if (entry.who === 'user') return false
  if (entry.parentTurnId && userMessageIds.has(entry.parentTurnId)) return true
  return entry.replyTo?.some((id) => userMessageIds.has(id)) === true
}

export function createGroupChatReadController(opts: GroupChatReadControllerOpts): GroupChatReadController {
  let entries: ChatLogEntry[] = []
  let active = false
  let nearBottom = false
  let cursor = opts.getCursor()
  let cursorId: string | null = cursor
  let ownSendPending = false
  const listeners = new Set<() => void>()
  let snapshotCache: GroupChatReadSnapshot | null = null
  const dirtySnapshot = () => {
    snapshotCache = null
  }

  /** 派生键:页面保证条目有 ID(listChatTurns 兜底);这里仍防御缺 ID */
  const keyOf = (e: ChatLogEntry, i: number): string => e.id ?? `#${i}`

  function cursorIndex(): number {
    if (cursorId === null) return -2 // -2 = 游标未初始化(首装/失配):按"已读到末尾"处理
    const i = entries.findIndex((e, idx) => keyOf(e, idx) === cursorId)
    return i // -1 = 失配(日志被裁剪/清空):同样按已读处理,下次推进重建
  }

  function unreadSlice(): Array<{ entry: ChatLogEntry; key: string; index: number }> {
    const ci = cursorIndex()
    const start = ci === -2 || ci === -1 ? entries.length : ci + 1
    const out: Array<{ entry: ChatLogEntry; key: string; index: number }> = []
    for (let i = start; i < entries.length; i++) {
      out.push({ entry: entries[i], key: keyOf(entries[i], i), index: i })
    }
    return out
  }

  function userMessageIds(): Set<string> {
    const cached = USER_SET_CACHE.get(entries)
    if (cached) return cached
    const set = new Set<string>()
    entries.forEach((e, i) => {
      if (e.who === 'user') set.add(keyOf(e, i))
    })
    USER_SET_CACHE.set(entries, set)
    return set
  }

  function emit(): void {
    listeners.forEach((l) => l())
  }

  function advanceCursorTo(key: string): void {
    // 游标只能向前:目标位置必须在当前游标之后
    const ci = cursorIndex()
    const targetIndex = entries.findIndex((e, idx) => keyOf(e, idx) === key)
    if (targetIndex < 0) return
    if (ci >= 0 && targetIndex <= ci) return
    cursorId = key
    dirtySnapshot()
    opts.setCursor(cursorId)
    emit()
  }

  function advanceCursorToEnd(): void {
    if (entries.length === 0) return
    const last = keyOf(entries[entries.length - 1], entries.length - 1)
    if (cursorId === last) return
    cursorId = last
    dirtySnapshot()
    opts.setCursor(cursorId)
    emit()
  }

  function buildEffect(effect: ReadEffect): ReadEffect {
    emit()
    return effect
  }

  return {
    setEntries(next, cause) {
      const prev = entries
      entries = next
      dirtySnapshot()
      USER_SET_CACHE.delete(prev)

      if (cause === 'clear' || next.length === 0) {
        cursorId = null
        dirtySnapshot()
        opts.setCursor(null)
        return buildEffect({ type: 'none' })
      }

      if (cause === 'initial') {
        // §8:首装/游标失配不把全部历史判为未读——以当前日志末尾初始化
        if (cursorId === null || cursorIndex() === -1) {
          cursorId = null
          advanceCursorToEnd()
        }
        const unread = unreadSlice().filter((u) => u.entry.who !== 'user')
        if (unread.length > 0) {
          return buildEffect({ type: 'scroll-message', id: unread[0].key })
        }
        return buildEffect({ type: 'scroll-bottom' })
      }

      if (cause === 'prepend') {
        // 顶部加载旧消息:游标不动,视口由页面按锚点恢复
        return buildEffect({ type: 'preserve-viewport' })
      }

      // append(含整表刷新无新内容的情形)
      if (ownSendPending) {
        ownSendPending = false
        if (active) advanceCursorToEnd()
        return buildEffect({ type: 'scroll-bottom' })
      }
      if (active && nearBottom) {
        // 跟随:自动滚到底 + 推进游标(§6)
        advanceCursorToEnd()
        return buildEffect({ type: 'scroll-bottom' })
      }
      // 读历史/窗口不活动:保持像素位置,未读累计(§6/§12 底部追加不补偿)
      return buildEffect({ type: 'preserve-viewport' })
    },

    setView(input) {
      const prevActive = active
      active = input.active
      nearBottom = input.distanceToBottom < NEAR_BOTTOM_PX
      dirtySnapshot()

      if (!prevActive && active) {
        // 重新进入群聊(§1):有未读 → 定位第一条未读;没有 → 保持视口
        opts.setCursor(cursorId) // 失焦期间可能有未落盘推进:激活即落盘
        const unread = unreadSlice().filter((u) => u.entry.who !== 'user')
        if (unread.length > 0) {
          return buildEffect({ type: 'scroll-message', id: unread[0].key })
        }
        return buildEffect({ type: 'none' })
      }

      // 贴底:一次性推进到最后一条(§7);否则按完全可见的最后一条单调推进
      if (active && nearBottom) {
        advanceCursorToEnd()
      } else if (input.lastFullyVisibleId) {
        advanceCursorTo(input.lastFullyVisibleId)
      }
      return buildEffect({ type: 'none' })
    },

    notifyOwnSend() {
      ownSendPending = true
      nearBottom = true
      dirtySnapshot()
      if (active) advanceCursorToEnd()
      return buildEffect({ type: 'scroll-bottom' })
    },

    requestJump() {
      const unread = unreadSlice().filter((u) => u.entry.who !== 'user')
      if (unread.length > 0) {
        // §7:定位第一条未读,而不是最后一条
        return buildEffect({ type: 'scroll-message', id: unread[0].key })
      }
      return buildEffect({ type: 'scroll-bottom' })
    },

    getSnapshot() {
      if (snapshotCache) return snapshotCache
      const unread = unreadSlice().filter((u) => u.entry.who !== 'user')
      const userSet = userMessageIds()
      let latestTargetedActor: ActorId | null = null
      for (const { entry } of unread) {
        if (isTargetedReply(entry, userSet) && (entry.who === 'A' || entry.who === 'B' || entry.who === 'C')) {
          latestTargetedActor = entry.who
        }
      }
      const count = unread.length
      let label: string | null = null
      if (count > 0) {
        if (latestTargetedActor) {
          label = `${opts.nameOf(latestTargetedActor)}回复了你 · ${count}`
        } else if (count === 1) {
          label = '1 条新消息'
        } else {
          label = `${count} 条新消息`
        }
      }
      snapshotCache = {
        active,
        nearBottom,
        unreadCount: count,
        firstUnreadId: unread[0]?.key ?? null,
        latestTargetedActor,
        label,
      }
      return snapshotCache
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose() {
      listeners.clear()
    },
  }
}
