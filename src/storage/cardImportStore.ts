// 角色卡导入留档:data/card-imports.json,每槽位(A/B)一份导入记录。
// 目的:人设文本只装得下「分区烘焙」结果(核心人设/风格示例/常驻 lore),卡的其余
// 信息——非 constant 世界书条目、预算外条目、alternate_greetings、原始 JSON——
// 在这里完整留档,未来接入真正的世界书检索系统时直接迁移,用户无需重新导入。
// 原始 JSON 有 512KB 护栏(超限置 null,其余字段不受影响)。
// 读写走 withFileLock;浏览器预览降级 localStorage,与 configStore 同一套约定。

export interface StoredLoreEntry {
  keys: string[]
  content: string
  /** 留档里的常驻标记(可能因预算没烘焙) */
  constant: boolean
  priority: number
  enabled: boolean
  comment?: string
  /** 本地化生成的中文别名(keys 已含原文 + 别名,这里单存别名) */
  aliases?: string[]
}

export interface CardImportRecord {
  importedAt: number
  spec: string
  creator?: string
  characterVersion?: string
  tags: string[]
  /** 非中文卡已完成语义本地化 */
  localized?: boolean
  /** 烘焙进人设的风格示例(mes 组 + first_mes,宏已替换) */
  styleExamples: string[]
  /** 已烘焙进人设的常驻条目 */
  bakedLore: StoredLoreEntry[]
  /** 留档未烘焙条目(非 constant/预算外/禁用) */
  keywordLore: StoredLoreEntry[]
  alternateGreetings: string[]
  /** 原始卡 JSON;超过 RAW_MAX_BYTES 置 null */
  raw: string | null
}

export interface CardImportsData {
  version: 1
  imports: { a?: CardImportRecord; b?: CardImportRecord }
}

export const RAW_MAX_BYTES = 512 * 1024
const LS_KEY = 'vc-card-imports'
const FILE_NAME = 'card-imports.json'

let cache: CardImportsData | null = null

function emptyData(): CardImportsData {
  return { version: 1, imports: {} }
}

function sanitizeLoreEntry(v: unknown): StoredLoreEntry | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Record<string, unknown>
  const content = typeof e.content === 'string' ? e.content : ''
  if (!content) return null
  return {
    keys: Array.isArray(e.keys) ? e.keys.filter((k): k is string => typeof k === 'string').slice(0, 30) : [],
    content,
    constant: e.constant === true,
    priority: typeof e.priority === 'number' ? e.priority : 0,
    enabled: e.enabled !== false,
    ...(typeof e.comment === 'string' && e.comment.trim() ? { comment: e.comment.trim().slice(0, 60) } : {}),
    ...(Array.isArray(e.aliases)
      ? { aliases: e.aliases.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 3) }
      : {}),
  }
}

function sanitizeRecord(v: unknown): CardImportRecord | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  // importedAt 是真实导入的锚:缺它 = 不是一条导入记录(垃圾档直接拒)
  if (typeof r.importedAt !== 'number' || r.importedAt <= 0) return null
  const strs = (arr: unknown): string[] =>
    Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 50) : []
  const raw = typeof r.raw === 'string' && r.raw.length <= RAW_MAX_BYTES ? r.raw : null
  return {
    importedAt: r.importedAt,
    spec: typeof r.spec === 'string' ? r.spec.slice(0, 40) : 'unknown',
    ...(typeof r.creator === 'string' && r.creator ? { creator: r.creator.slice(0, 80) } : {}),
    ...(typeof r.characterVersion === 'string' && r.characterVersion ? { characterVersion: r.characterVersion.slice(0, 40) } : {}),
    tags: strs(r.tags),
    ...(r.localized === true ? { localized: true } : {}),
    styleExamples: strs(r.styleExamples),
    bakedLore: Array.isArray(r.bakedLore)
      ? (r.bakedLore.map(sanitizeLoreEntry).filter((e): e is StoredLoreEntry => e !== null)).slice(0, 100)
      : [],
    keywordLore: Array.isArray(r.keywordLore)
      ? (r.keywordLore.map(sanitizeLoreEntry).filter((e): e is StoredLoreEntry => e !== null)).slice(0, 500)
      : [],
    alternateGreetings: strs(r.alternateGreetings),
    raw,
  }
}

/** 幂等清洗(测试与读档共用) */
export function sanitizeCardImportsData(v: unknown): CardImportsData {
  const o = (v ?? {}) as Record<string, unknown>
  const imports = (o.imports ?? {}) as Record<string, unknown>
  const out: CardImportsData = { version: 1, imports: {} }
  for (const slot of ['a', 'b'] as const) {
    const rec = sanitizeRecord(imports[slot])
    if (rec) out.imports[slot] = rec
  }
  return out
}

async function readFile(): Promise<CardImportsData> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitizeCardImportsData(JSON.parse(raw))
    } catch {
      // 坏数据按空档处理
    }
    return emptyData()
  }
  try {
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs')
    const { appDataDir, join } = await import('@tauri-apps/api/path')
    const file = await join(await appDataDir(), 'data', FILE_NAME)
    if (await exists(file)) return sanitizeCardImportsData(JSON.parse(await readTextFile(file)))
  } catch (e) {
    console.warn('角色卡留档读取失败(按空档处理)', e)
  }
  return emptyData()
}

async function writeFile(data: CardImportsData): Promise<void> {
  cache = data
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data))
    } catch {
      /* ignore */
    }
    return
  }
  try {
    const [{ writeTextFile, exists, mkdir }, { appDataDir, join }, { withFileLock }] = await Promise.all([
      import('@tauri-apps/plugin-fs'),
      import('@tauri-apps/api/path'),
      import('./writeLock'),
    ])
    await withFileLock('card-imports', async () => {
      const dir = await join(await appDataDir(), 'data')
      if (!(await exists(dir))) await mkdir(dir, { recursive: true })
      await writeTextFile(await join(dir, FILE_NAME), JSON.stringify(data, null, 2))
    })
  } catch (e) {
    console.warn('角色卡留档落盘失败(静默)', e)
  }
}

async function ensureLoaded(): Promise<CardImportsData> {
  if (!cache) cache = await readFile()
  return cache
}

/** 读单槽留档 */
export async function getCardImport(slot: 'a' | 'b'): Promise<CardImportRecord | null> {
  const data = await ensureLoaded()
  return data.imports[slot] ?? null
}

/** 写/覆盖单槽留档(另一槽不受影响) */
export async function saveCardImport(slot: 'a' | 'b', record: CardImportRecord): Promise<void> {
  const data = await ensureLoaded()
  const next = sanitizeCardImportsData({ version: 1, imports: { ...data.imports, [slot]: record } })
  await writeFile(next)
}

/** 清除单槽留档(设置页复位用) */
export async function clearCardImport(slot: 'a' | 'b'): Promise<void> {
  const data = await ensureLoaded()
  if (!data.imports[slot]) return
  const imports = { ...data.imports }
  delete imports[slot]
  await writeFile({ version: 1, imports })
}
