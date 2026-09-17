// 影子大脑存档:data/shadow-brain/{inputs,decisions}.jsonl,逐行 JSON 追加。
// 照抄 chatlog 模式(withFileLock 写锁 + 尾部裁剪);这是「几百次决策记录」的
// 比对语料——Agent 直接读文件(或经 HTTP 端点)自行分析,应用内不做分析界面。
// 浏览器预览/纯测试(!inTauri)降级为进程内存数组,行为一致可单测。
// 所有操作静默容错——存档失败绝不影响演出主流程。

import { readTextFile, writeTextFile, exists, mkdir, remove } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { inTauri } from '../storage/configStore'
import { withFileLock } from '../storage/writeLock'

export type ShadowArchiveKind = 'inputs' | 'decisions'

const MAX_LINES = 5000
const DIR_NAME = 'shadow-brain'

// 非 Tauri 环境的内存降级(测试/预览)
const memStore = new Map<ShadowArchiveKind, string[]>()

let filePromises: Partial<Record<ShadowArchiveKind, Promise<string>>> = {}

function getLogFile(kind: ShadowArchiveKind): Promise<string> {
  const cached = filePromises[kind]
  if (cached) return cached
  const created = (async () => {
    const base = await appDataDir()
    const dir = await join(base, 'data', DIR_NAME)
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    return join(dir, `${kind}.jsonl`)
  })()
  filePromises[kind] = created
  return created
}

/** 追加一行(JSON 序列化失败按单条丢弃);超上限时尾部裁剪 */
export async function appendShadowRecord(kind: ShadowArchiveKind, record: object): Promise<void> {
  let line: string
  try {
    line = JSON.stringify(record)
  } catch {
    return
  }
  if (!inTauri) {
    const arr = memStore.get(kind) ?? []
    arr.push(line)
    memStore.set(kind, arr.slice(-MAX_LINES))
    return
  }
  try {
    await withFileLock(`shadow-${kind}`, async () => {
      const file = await getLogFile(kind)
      await writeTextFile(file, line + '\n', { append: true })
      const lines = (await readTextFile(file)).split('\n').filter(Boolean)
      if (lines.length > MAX_LINES) {
        await writeTextFile(file, lines.slice(-MAX_LINES).join('\n') + '\n')
      }
    })
  } catch (e) {
    console.warn('影子大脑存档失败(静默)', e)
  }
}

/** 读尾部 n 条(解析失败跳过);非 Tauri 读内存降级 */
export async function readShadowRecords(kind: ShadowArchiveKind, limit = 200): Promise<unknown[]> {
  const parseAll = (raw: string): unknown[] => {
    const out: unknown[] = []
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        out.push(JSON.parse(line))
      } catch {
        // 跳过坏行
      }
    }
    return out.slice(-limit)
  }
  if (!inTauri) return parseAll((memStore.get(kind) ?? []).join('\n'))
  try {
    const file = await getLogFile(kind)
    if (!(await exists(file))) return []
    return parseAll(await readTextFile(file))
  } catch (e) {
    console.warn('影子大脑存档读取失败', e)
    return []
  }
}

/** 存档行数(设置卡展示);读取失败按 0 */
export async function countShadowRecords(): Promise<{ inputs: number; decisions: number }> {
  const countOf = async (kind: ShadowArchiveKind): Promise<number> => {
    if (!inTauri) return (memStore.get(kind) ?? []).length
    try {
      const file = await getLogFile(kind)
      if (!(await exists(file))) return 0
      return (await readTextFile(file)).split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }
  return { inputs: await countOf('inputs'), decisions: await countOf('decisions') }
}

/** 清空存档(设置卡按钮) */
export async function clearShadowArchive(): Promise<void> {
  if (!inTauri) {
    memStore.clear()
    return
  }
  try {
    await withFileLock('shadow-inputs', async () => {
      const file = await getLogFile('inputs')
      if (await exists(file)) await remove(file)
    })
    await withFileLock('shadow-decisions', async () => {
      const file = await getLogFile('decisions')
      if (await exists(file)) await remove(file)
    })
  } catch (e) {
    console.warn('影子大脑存档清空失败', e)
  }
}
