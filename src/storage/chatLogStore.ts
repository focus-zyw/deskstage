// 聊天消息持久化:appData/data/chatlog.jsonl,逐行 JSON 追加。
// 记录用户在聊天框里说的话与角色的聊天应答(演出集台词在 historyStore,互不重复)。
// 单文件独立于 history/ 目录——避免 listHistoryFiles 把它当历史日文件解析。
// 所有操作静默容错——存储失败不影响聊天主流程。
import { readTextFile, writeTextFile, exists, mkdir, remove } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import type { Episode } from './historyStore'
import { withFileLock } from './writeLock'

/** 消息来源:user = 用户在聊天框打的字;A/B/C = 角色的聊天应答 */
export type ChatWho = 'user' | 'A' | 'B' | 'C'

export interface ChatLogEntry {
  ts: number
  who: ChatWho
  text: string
}

const WHO_SET = new Set<ChatWho>(['user', 'A', 'B', 'C'])
const MAX_TEXT = 500
const MAX_TURNS = 5000

/** 单条清洗:who/text/ts 任一非法整条拒收 */
export function sanitizeChatEntry(o: unknown): ChatLogEntry | null {
  if (!o || typeof o !== 'object') return null
  const rec = o as Record<string, unknown>
  const who = rec.who
  if (typeof who !== 'string' || !WHO_SET.has(who as ChatWho)) return null
  const text = typeof rec.text === 'string' ? rec.text.trim().slice(0, MAX_TEXT) : ''
  if (!text) return null
  const ts = Number(rec.ts) || 0
  if (!ts) return null
  return { ts, who: who as ChatWho, text }
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

/** 一批消息一次性落盘(同一时刻的整批:用户一句或角色一次应答) */
export async function appendChatTurns(turns: Array<{ who: ChatWho; text: string }>): Promise<void> {
  const valid = turns
    .map((t) => sanitizeChatEntry({ ...t, ts: Date.now() }))
    .filter((t): t is ChatLogEntry => t !== null)
  if (valid.length === 0) return
  try {
    await withFileLock('chatlog', async () => {
      const file = await getLogFile()
      const chunk = valid.map((t) => JSON.stringify(t)).join('\n') + '\n'
      await writeTextFile(file, chunk, { append: true })
    })
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
  } catch (e) {
    console.warn('聊天消息清空失败', e)
  }
}

// ---------- 时间线合并(纯函数,导出供测试) ----------

/** 信息流条目:聊天消息为独立气泡;演出集为整块(含全部台词) */
export type FeedItem =
  | { kind: 'chat'; ts: number; entry: ChatLogEntry }
  | { kind: 'episode'; ts: number; ep: Episode }

/**
 * 演出集与聊天消息按 ts 升序合并成统一时间线(聊天气泡穿插在集块之间)。
 * 同 ts 时聊天消息排在集块前(消息先于该刻定稿的演出呈现);各输入内部已有序时为稳定排序。
 */
export function buildFeed(episodes: Episode[], turns: ChatLogEntry[]): FeedItem[] {
  const items: FeedItem[] = [
    ...episodes.map((ep) => ({ kind: 'episode', ts: ep.ts, ep }) as FeedItem),
    ...turns.map((entry) => ({ kind: 'chat', ts: entry.ts, entry }) as FeedItem),
  ]
  return items.sort((a, b) => a.ts - b.ts || rank(a) - rank(b))
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
