// 群聊已读游标持久化(§4):只保存最小事实,其余全部从日志派生。
//
//   { version: 1, roomId: 'main', lastReadEntryId, updatedAt }
//
// 刻意不持久化 unreadCount / firstUnreadMessageId / 每条 readState / 角色摘要——
// 它们都能从日志 + 游标推导,重复存储必然产生不一致。
// 写入时机:用户实际看到新消息后 500ms 防抖;失焦/隐藏/切页立即落盘;
// 清空聊天记录时同时清空游标。每次落盘向主窗广播 'group-chat-read'
// (柔和角标据此更新);聊天记录页在快照变化时同步发布未读数。
import { emitTo } from '@tauri-apps/api/event'
import { exists, readTextFile, writeTextFile, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { listChatTurns } from './chatLogStore'

export interface GroupChatReadState {
  version: 1
  roomId: 'main'
  lastReadEntryId: string | null
  updatedAt: number
}

const READ_FILE = 'group-chat-read.json'
const DEBOUNCE_MS = 500

const inTauriHost = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let cache: GroupChatReadState = { version: 1, roomId: 'main', lastReadEntryId: null, updatedAt: 0 }
let loaded = false

// ---------- 订阅三件套(主窗角标/页面重放用):version 只增,内存未读数单源 ----------
let version = 0
let unreadCount = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const l of listeners) l()
}

export function subscribeGroupChatRead(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getGroupChatReadVersion(): number {
  return version
}

/** 当前未读数(内存;由聊天记录页发布 / 主窗从事件与日志重算) */
export function getGroupChatUnread(): number {
  return unreadCount
}

/** 发布未读数(设置窗群聊页在快照变化时调用,广播给主窗角标;
 *  主窗从日志重算后也用它回填本地) */
export function publishGroupChatUnread(count: number, opts?: { broadcast?: boolean }): void {
  const next = Math.max(0, Math.trunc(count) || 0)
  if (next === unreadCount) return
  unreadCount = next
  notify()
  if (opts?.broadcast && inTauriHost) {
    void emitTo('main', 'group-chat-read', { unreadCount: next }).catch(() => {})
  }
}

/** 主窗启动/日志变化时:按 日志 + 持久游标 重算未读(角色消息才计数) */
export async function computeGroupChatUnreadFromLog(limit = 300): Promise<number> {
  const state = await loadGroupChatReadState()
  const turns = await listChatTurns(limit)
  const ci = state.lastReadEntryId ? turns.findIndex((t) => t.id === state.lastReadEntryId) : -1
  const start = state.lastReadEntryId && ci >= 0 ? ci + 1 : turns.length
  let count = 0
  for (let i = start; i < turns.length; i++) {
    if (turns[i].who !== 'user') count += 1
  }
  return count
}

function file(): Promise<string> {
  return (async () => {
    const base = await appDataDir()
    const dir = await join(base, 'data')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    return join(dir, READ_FILE)
  })()
}

/** 首读(单飞):磁盘有合法状态用之,否则保持默认(游标 null = 首装,按日志末尾初始化) */
export async function loadGroupChatReadState(): Promise<GroupChatReadState> {
  if (loaded) return cache
  loaded = true
  if (!inTauriHost) return cache
  try {
    const f = await file()
    if (await exists(f)) {
      const raw = JSON.parse(await readTextFile(f)) as Partial<GroupChatReadState> | null
      if (raw && raw.version === 1) {
        cache = {
          version: 1,
          roomId: 'main',
          lastReadEntryId: typeof raw.lastReadEntryId === 'string' ? raw.lastReadEntryId : null,
          updatedAt: Number(raw.updatedAt) || 0,
        }
      }
    }
  } catch {
    // 损坏/读取失败:按首装处理,不阻塞聊天
  }
  return cache
}

/** 同步读取(须先 loadGroupChatReadState;未加载时返回内存默认) */
export function getGroupChatReadState(): GroupChatReadState {
  return cache
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingId: string | null = null

async function writeNow(entryId: string | null): Promise<void> {
  cache = { version: 1, roomId: 'main', lastReadEntryId: entryId, updatedAt: Date.now() }
  if (!inTauriHost) return
  try {
    await withFileLock(READ_FILE, async () => {
      const f = await file()
      await writeTextFile(f, JSON.stringify(cache))
    })
    // 主窗柔和角标:游标变化(以及清空)都广播一次
    void emitTo('main', 'group-chat-read', {
      lastReadEntryId: entryId,
      updatedAt: cache.updatedAt,
    }).catch(() => {})
  } catch {
    // 落盘失败不影响聊天;下次推进再写
  }
}

/** 推进游标(entryId=null = 清空)。缺省 500ms 防抖;immediate 立即落盘 */
export function setGroupChatReadCursor(
  entryId: string | null,
  opts?: { immediate?: boolean },
): void {
  pendingId = entryId
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (opts?.immediate || entryId === null || !inTauriHost) {
    void writeNow(entryId)
    return
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void writeNow(pendingId)
  }, DEBOUNCE_MS)
}

/** 立即把待写游标落盘(失焦/隐藏/切页时调用) */
export function flushGroupChatRead(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
    void writeNow(pendingId)
  }
}
