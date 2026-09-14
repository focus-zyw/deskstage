// 聊天消息持久化:appData/data/chatlog.jsonl,逐行 JSON 追加。
// 记录用户在聊天框里说的话与角色的聊天应答(演出集台词在 historyStore,互不重复)。
// 单文件独立于 history/ 目录——避免 listHistoryFiles 把它当历史日文件解析。
// 所有操作静默容错——存储失败不影响聊天主流程。
// 订阅三件套(version 计数):群聊页据此实时刷新——角色逐句应答落盘即冒出。
import { readTextFile, writeTextFile, exists, mkdir, remove } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { emitTo, listen } from '@tauri-apps/api/event'
import { useSyncExternalStore } from 'react'
import type { Episode } from './historyStore'
import { withFileLock } from './writeLock'

/** 消息来源:user = 用户在聊天框打的字;A/B/C = 角色的聊天应答 */
export type ChatWho = 'user' | 'A' | 'B' | 'C'

/** 记忆引用(只存 id 与来源,绝不存正文——删除记忆后聊天日志不残留内容) */
export interface ChatMemoryRef {
  id: string
  source: 'passive' | 'search-tool'
}

export interface ChatLogEntry {
  ts: number
  who: ChatWho
  text: string
  /** 稳定轮 id:用户消息 = requestId,角色句各自的 entry id(应用生成一次,贯穿提取) */
  id?: string
  /** 角色句回链本次请求的用户消息 id(多句应答共享一份参考记忆) */
  parentTurnId?: string
  /** 本轮实际注入模型的记忆引用(与 presentTurn 的 memoryRefs 同源) */
  memoryRefs?: ChatMemoryRef[]
  /** 调试档完整检索 trace(仅 id/分数/枚举,无正文;默认档不落) */
  trace?: unknown
  /** 群聊 Actor 系统:因果链会话标识(同一会话内 roomSeq 严格递增) */
  sessionId?: string
  /** 群聊全局序号(并发提交的排序事实源,不依赖毫秒 ts) */
  roomSeq?: number
  /** 用户转向代次 */
  epoch?: number
  /** 因果链根消息 id */
  causalRootId?: string
  /** 明确回应的消息 id 列表 */
  replyTo?: string[]
}

const WHO_SET = new Set<ChatWho>(['user', 'A', 'B', 'C'])
const MAX_TEXT = 500
const MAX_TURNS = 5000

// ---------- 订阅三件套(useSyncExternalStore):version 只增不回退,读侧拿它当 effect 依赖 ----------
// 跨窗:写入发生在主窗,设置窗的模块实例感知不到——写入端 emit 'chatlog-bump',
// 设置窗 installChatlogSync() 监听后 bump 本地 version(修既有跨窗缝隙)。
const CHATLOG_BUMP_EVENT = 'chatlog-bump'
const inTauriHost = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let version = 0
const listeners = new Set<() => void>()

/** 落盘成功后 bump(append/清空各一处);渲染层订阅 version 变化重拉列表 */
function bumpVersion(): void {
  version += 1
  for (const l of listeners) l()
  if (inTauriHost) {
    void emitTo('settings', CHATLOG_BUMP_EVENT, { version }).catch(() => {})
  }
}

/** 设置窗调用:监听主窗的落盘通知并 bump 本地 version(幂等;预览环境无操作) */
export async function installChatlogSync(): Promise<void> {
  if (!inTauriHost) return
  await listen<{ version?: number }>(CHATLOG_BUMP_EVENT, () => {
    bumpVersion()
  })
}

/** 订阅聊天日志变更;返回退订函数 */
export function subscribeChatLog(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** useSyncExternalStore 的 getSnapshot 侧:当前版本号 */
export function getChatLogVersion(): number {
  return version
}

/** React 侧订阅:版本号变化 → 群聊页重拉消息列表(角色应答实时冒出) */
export function useChatLogVersion(): number {
  return useSyncExternalStore(subscribeChatLog, getChatLogVersion)
}

/** 单条清洗:who/text/ts 任一非法整条拒收;记忆相关字段只收 id/枚举/数字,不收正文 */
export function sanitizeChatEntry(o: unknown): ChatLogEntry | null {
  if (!o || typeof o !== 'object') return null
  const rec = o as Record<string, unknown>
  const who = rec.who
  if (typeof who !== 'string' || !WHO_SET.has(who as ChatWho)) return null
  const text = typeof rec.text === 'string' ? rec.text.trim().slice(0, MAX_TEXT) : ''
  if (!text) return null
  const ts = Number(rec.ts) || 0
  if (!ts) return null
  const out: ChatLogEntry = { ts, who: who as ChatWho, text }
  if (typeof rec.id === 'string' && rec.id) out.id = rec.id.slice(0, 64)
  if (typeof rec.parentTurnId === 'string' && rec.parentTurnId) out.parentTurnId = rec.parentTurnId.slice(0, 64)
  if (Array.isArray(rec.memoryRefs)) {
    const refs = rec.memoryRefs
      .map((r) => {
        const m = (r ?? {}) as Record<string, unknown>
        if (typeof m.id !== 'string' || !m.id) return null
        return { id: m.id.slice(0, 64), source: m.source === 'search-tool' ? 'search-tool' : 'passive' } as ChatMemoryRef
      })
      .filter((r): r is ChatMemoryRef => r !== null)
    if (refs.length > 0) out.memoryRefs = refs.slice(0, 20)
  }
  if (rec.trace && typeof rec.trace === 'object') out.trace = rec.trace
  // 群聊 Actor 字段(可选; roomSeq 是并发提交的排序事实源)
  if (typeof rec.sessionId === 'string' && rec.sessionId) out.sessionId = rec.sessionId.slice(0, 64)
  if (typeof rec.roomSeq === 'number' && Number.isFinite(rec.roomSeq)) out.roomSeq = Math.trunc(rec.roomSeq)
  if (typeof rec.epoch === 'number' && Number.isFinite(rec.epoch)) out.epoch = Math.trunc(rec.epoch)
  if (typeof rec.causalRootId === 'string' && rec.causalRootId) out.causalRootId = rec.causalRootId.slice(0, 64)
  if (Array.isArray(rec.replyTo)) {
    const ids = rec.replyTo.filter((x): x is string => typeof x === 'string' && !!x).map((x) => x.slice(0, 64))
    if (ids.length > 0) out.replyTo = ids.slice(0, 6)
  }
  return out
}

let filePromise: Promise<string> | null = null

/** appData/data/chatlog.jsonl(懒创建,缓存 promise) */
function getLogFile(): Promise<string> {
  if (!filePromise) {
    filePromise = (async () => {
      const base = await appDataDir()
      const dir = await join(base, 'data')
      if (!(await exists(dir))) await mkdir(dir, { recursive: true })
      return join(dir, 'chatlog.jsonl')
    })()
  }
  return filePromise
}

/** 一批消息一次性落盘。角色应答可带 id/parentTurnId/memoryRefs/trace;
 *  ts 缺省 = 现在,但调用方应显式传入受理时刻的 ts(与 turn.id 同源,保证可对照) */
export async function appendChatTurns(
  turns: Array<{
    id?: string
    parentTurnId?: string
    who: ChatWho
    text: string
    ts?: number
    memoryRefs?: ChatMemoryRef[]
    trace?: unknown
    sessionId?: string
    roomSeq?: number
    epoch?: number
    causalRootId?: string
    replyTo?: string[]
  }>,
): Promise<void> {
  const valid = turns
    .map((t) => sanitizeChatEntry({ ...t, ts: t.ts ?? Date.now() }))
    .filter((t): t is ChatLogEntry => t !== null)
  if (valid.length === 0) return
  try {
    await withFileLock('chatlog', async () => {
      const file = await getLogFile()
      const chunk = valid.map((t) => JSON.stringify(t)).join('\n') + '\n'
      await writeTextFile(file, chunk, { append: true })
    })
    bumpVersion()
  } catch (e) {
    console.warn('聊天消息落盘失败(不影响聊天)', e)
  }
}

/** 最近 n 条聊天消息(文件为追加式,天然按时间升序;超上限的裁剪搭读取便车,追加路径保持轻量) */
export async function listChatTurns(limit = 500): Promise<ChatLogEntry[]> {
  try {
    const file = await getLogFile()
    if (!(await exists(file))) return []
    const out: ChatLogEntry[] = []
    for (const line of (await readTextFile(file)).split('\n').filter(Boolean)) {
      try {
        const e = sanitizeChatEntry(JSON.parse(line))
        if (e) out.push(e)
      } catch {
        // 跳过坏行
      }
    }
    if (out.length > MAX_TURNS) void trimChatLog()
    return out.slice(-limit)
  } catch (e) {
    console.warn('聊天消息读取失败', e)
    return []
  }
}

/** 清空聊天消息(设置页"清空聊天消息"按钮;演出历史不受影响) */
export async function clearChatLog(): Promise<void> {
  try {
    await withFileLock('chatlog', async () => {
      const file = await getLogFile()
      if (await exists(file)) await remove(file)
    })
    bumpVersion()
  } catch (e) {
    console.warn('聊天消息清空失败', e)
  }
}

// ---------- 时间线合并(纯函数,导出供测试) ----------

/** 信息流条目:聊天消息为独立气泡;演出集为整块(含全部台词)。
 *  ord = 输入序(同 ts 且无 roomSeq 时保持原序的稳定排序兜底) */
export type FeedItem =
  | { kind: 'chat'; ts: number; entry: ChatLogEntry; ord?: number }
  | { kind: 'episode'; ts: number; ep: Episode }

/**
 * 演出集与聊天消息按 ts 升序合并成统一时间线(聊天气泡穿插在集块之间)。
 * 同 ts 时聊天消息排在集块前(消息先于该刻定稿的演出呈现);各输入内部已有序时为稳定排序。
 * 同 ts 的聊天消息之间按 roomSeq(群聊 Actor 并发提交的排序事实源),无 roomSeq 保持原序。
 */
export function buildFeed(episodes: Episode[], turns: ChatLogEntry[]): FeedItem[] {
  const items: FeedItem[] = [
    ...episodes.map((ep) => ({ kind: 'episode', ts: ep.ts, ep }) as FeedItem),
    ...turns.map((entry, i) => ({ kind: 'chat', ts: entry.ts, entry, ord: i }) as FeedItem),
  ]
  return items.sort(
    (a, b) =>
      a.ts - b.ts ||
      rank(a) - rank(b) ||
      (a.kind === 'chat' && b.kind === 'chat'
        ? (a.entry.roomSeq ?? a.ord ?? 0) - (b.entry.roomSeq ?? b.ord ?? 0)
        : 0),
  )
}

/** 同 ts 的稳定次序:chat(0) 在 episode(1) 前 */
function rank(i: FeedItem): number {
  return i.kind === 'chat' ? 0 : 1
}

// 上限提示:append 时顺带裁剪,防单文件无限膨胀(读多写少,重写代价可接受)
export async function trimChatLog(): Promise<void> {
  try {
    await withFileLock('chatlog', async () => {
      const file = await getLogFile()
      if (!(await exists(file))) return
      const lines = (await readTextFile(file)).split('\n').filter(Boolean)
      if (lines.length <= MAX_TURNS) return
      await writeTextFile(file, lines.slice(-MAX_TURNS).join('\n') + '\n')
    })
  } catch (e) {
    console.warn('聊天消息裁剪失败', e)
  }
}
