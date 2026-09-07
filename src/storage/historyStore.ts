// 聊天记录持久化：appData/data/history/{yyyy-MM-dd}.jsonl，逐行 JSON 追加。
// 所有操作静默容错——存储失败不影响演出主流程。
import { readTextFile, writeTextFile, exists, mkdir, readDir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import type { DialogLine, Speaker } from '../performer/player'

export interface HistoryEntry extends DialogLine {
  ts: number
  mode: string
}

let dirPromise: Promise<string> | null = null

/** appData/data/history 目录（懒创建，缓存 promise） */
function getHistoryDir(): Promise<string> {
  if (!dirPromise) {
    dirPromise = (async () => {
      const base = await appDataDir()
      const dir = await join(base, 'data', 'history')
      if (!(await exists(dir))) {
        await mkdir(dir, { recursive: true })
      }
      return dir
    })()
  }
  return dirPromise
}

function todayFileId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 一集生成成功后整段落盘 */
export async function appendHistory(lines: DialogLine[], mode: string): Promise<void> {
  try {
    const dir = await getHistoryDir()
    const file = await join(dir, `${todayFileId()}.jsonl`)
    const ts = Date.now()
    const chunk =
      lines
        .map((l) =>
          JSON.stringify({ ts, mode, speaker: l.speaker, text: l.text, action: l.action }),
        )
        .join('\n') + '\n'
    await writeTextFile(file, chunk, { append: true })
  } catch (e) {
    console.warn('历史落盘失败（不影响演出）', e)
  }
}

/** 读取最近 n 条记录（从最新的日文件尾部取），用于启动恢复上下文 */
export async function loadRecentHistory(n = 20): Promise<HistoryEntry[]> {
  try {
    const dir = await getHistoryDir()
    const entries = await readDir(dir)
    const files = entries
      .filter((e) => e.isFile && e.name?.endsWith('.jsonl'))
      .map((e) => e.name!)
      .sort()
    if (files.length === 0) return []
    // 从最新文件往前凑够 n 条（通常一个文件就够）
    const result: HistoryEntry[] = []
    for (let i = files.length - 1; i >= 0 && result.length < n; i--) {
      const raw = await readTextFile(await join(dir, files[i]))
      const lines = raw.split('\n').filter(Boolean)
      const parsed: HistoryEntry[] = []
      for (const line of lines) {
        try {
          const obj = JSON.parse(line)
          if (obj.speaker === 'A' || obj.speaker === 'B') {
            parsed.push({
              ts: Number(obj.ts) || 0,
              mode: String(obj.mode || 'daily'),
              speaker: obj.speaker as Speaker,
              text: String(obj.text || ''),
              action: String(obj.action || 'talk'),
            })
          }
        } catch {
          // 跳过坏行
        }
      }
      result.unshift(...parsed.slice(Math.max(0, parsed.length - (n - result.length))))
    }
    return result.slice(-n)
  } catch (e) {
    console.warn('历史读取失败', e)
    return []
  }
}
