// 群聊已读游标 + 视口锚点持久化(§4 + 位置恢复):只保存最小事实,其余全部从日志派生。
//
//   { version: 1, roomId: 'main', lastReadEntryId, viewAnchor?, updatedAt }
//
// 刻意不持久化 unreadCount / firstUnreadMessageId / 每条 readState / 角色摘要——
// 它们都能从日志 + 游标推导,重复存储必然产生不一致。
// viewAnchor(产品决策,补全 §1):离开群聊页时的视口锚点(第一条可见消息 id +
// 相对容器顶的偏移),切分页/关窗/重启后回到原阅读位置;游标失配按"已读到末尾"处理。
// 写入时机:推进/滚动后 500ms 防抖;失焦/隐藏/切页/卸载立即落盘;
// 清空聊天记录时同时清空。每次落盘向主窗广播 'group-chat-read'(柔和角标据此更新)。
import { emitTo } from '@tauri-apps/api/event'
import { exists, readTextFile, writeTextFile, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { listChatTurns } from './chatLogStore'

export interface GroupChatViewAnchor {
  id: string
  offset: number
}

export interface GroupChatReadState {
  version: 1
  roomId: 'main'
  lastReadEntryId: string | null
  /** 离开时的视口锚点:恢复阅读位置用(非未读语义) */
  viewAnchor?: GroupChatViewAnchor | null
  updatedAt: number
}

const READ_FILE = 'group-chat-read.json'
const DEBOUNCE_MS = 500

const inTauriHost = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let cache: GroupChatReadState = {
  version: 1,
  roomId: 'main',
  lastReadEntryId: null,
  viewAnchor: null,
  updatedAt: 0,
}
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

function file(): Promise<string> {
  return (async () => {
    const base = await appDataDir()
    const dir = await join(base, 'data')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    return join(dir, READ_FILE)
  })()
}

function parseViewAnchor(v: unknown): GroupChatViewAnchor | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.slice(0, 64) : ''
  const offset = Number(o.offset)
  if (!id || !Number.isFinite(offset)) return null
  return { id, offset: Math.max(-100_000, Math.min(100_000, offset)) }
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
          viewAnchor: parseViewAnchor(raw.viewAnchor),
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

async function writeNow(): Promise<void> {
  cache = { ...cache, updatedAt: Date.now() }
  if (!inTauriHost) return
  try {
    await withFileLock(READ_FILE, async () => {
      const f = await file()
      await writeTextFile(f, JSON.stringify(cache))
    })
    // 主窗柔和角标:游标变化(以及清空)都广播一次
    void emitTo('main', 'group-chat-read', {
      lastReadEntryId: cache.lastReadEntryId,
      viewAnchor: cache.viewAnchor,
      updatedAt: cache.updatedAt,
    }).catch(() => {})
  } catch {
    // 落盘失败不影响聊天;下次推进再写
  }
}

function scheduleWrite(immediate?: boolean): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (immediate || !inTauriHost) {
    void writeNow()
    return
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void writeNow()
  }, DEBOUNCE_MS)
}

/** 推进已读游标(entryId=null = 清空)。缺省 500ms 防抖;immediate 立即落盘 */
export function setGroupChatReadCursor(
  entryId: string | null,
  opts?: { immediate?: boolean },
): void {
  cache.lastReadEntryId = entryId
  scheduleWrite(opts?.immediate || entryId === null)
}

/** 保存视口锚点(null = 清除)。滚动中频繁调用安全:存储侧 500ms 防抖 */
export function setGroupChatViewAnchor(
  anchor: GroupChatViewAnchor | null,
  opts?: { immediate?: boolean },
): void {
  cache.viewAnchor = anchor
  scheduleWrite(opts?.immediate)
}

/** 立即把待写状态落盘(失焦/隐藏/切页/卸载时调用) */
export function flushGroupChatRead(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
    void writeNow()
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
