// 会话注册表:群聊唯一房间(group:main,App 装配)+ 每角色单聊房间(direct:<slot>)。
// 单聊会话自含 host(面板模式),不依赖 App 的舞台回调;重复获取返回同一间。
import type { ActorId } from '../groupChat/types'
import type { ChatSession } from './ChatSession'
import { createDirectSession, type DirectSessionOpts } from './directSession'

const directRooms = new Map<ActorId, ChatSession>()
let group: ChatSession | null = null

/** 群聊会话装配(App 创建后注册;聊天面板/设置桥经此取用) */
export function registerGroupSession(s: ChatSession): void {
  group = s
}

export function getGroupSession(): ChatSession {
  if (!group) throw new Error('群聊会话尚未装配')
  return group
}

/** 单聊会话(每角色一间,惰性创建) */
export function getDirectSession(slot: ActorId, opts?: DirectSessionOpts): ChatSession {
  let s = directRooms.get(slot)
  if (!s) {
    s = createDirectSession(slot, opts)
    directRooms.set(slot, s)
  }
  return s
}

/** 清空聊天记录时:所有单聊房间一并重置(历史文件已删,无需重新引导) */
export function resetDirectSessions(): void {
  for (const s of directRooms.values()) s.reset()
}
