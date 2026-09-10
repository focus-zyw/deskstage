// 语音缓存 v2:内存(完整 wav 字节)→ 磁盘(base64 文本,沿用旧约定规避插件二进制读接口差异)。
// 缓存键含 provider/model/voice/speed/emotion/cacheVersion——换供应商/模型不会错播旧音频;
// gain 不进键:深夜降音量改在播放端做,同句缓存昼夜复用。
import { readTextFile, writeTextFile, exists, mkdir, readDir, remove, stat } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { inTauri } from '../../storage/configStore'

/** 缓存结构版本:变化即整体失效。v3 = 情感指令改走 <|endofprompt|>
 *  (v2 的旧音频把指令文本整句念出来了,必须作废) */
export const CACHE_VERSION = 3

/** 磁盘缓存预算:条数与字节双上限。wav 约为 mp3 的 8 倍大,必须按字节限,
 *  超限按 mtime 从最旧开始删 */
const MAX_CACHE_FILES = 400
const MAX_CACHE_BYTES = 256 * 1024 * 1024

/** hash(供应商|模型|音色|语速|语气|版本|文本) */
export async function hashOf(parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join('|'))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------- 内存层 ----------

/** hash → 完整 wav 字节;上限 100 条(单句 wav 约 0.5~1MB),满了从头清 */
const memory = new Map<string, ArrayBuffer>()
const MEM_MAX = 100

export function memGet(hash: string): ArrayBuffer | undefined {
  return memory.get(hash)
}

export function memPut(hash: string, bytes: ArrayBuffer): void {
  memory.set(hash, bytes)
  if (memory.size > MEM_MAX) {
    const oldest = memory.keys().next().value
    if (oldest !== undefined && oldest !== hash) memory.delete(oldest)
  }
}

// ---------- 磁盘层 ----------

let dirPromise: Promise<string> | null = null

/** v1 的 mp3 缓存:格式与键都已变,留着只会占盘,首次进入时静默清掉 */
async function removeLegacyFiles(root: string): Promise<void> {
  try {
    for (const e of await readDir(root)) {
      if (e.isFile && e.name?.endsWith('.mp3.txt')) {
        await remove(await join(root, e.name)).catch(() => {})
      }
    }
  } catch {
    // 清理失败不影响合成主流程
  }
}

/** appData/data/audio-cache/v2 目录(懒创建) */
function cacheDir(): Promise<string> {
  if (!dirPromise) {
    dirPromise = (async () => {
      const base = await appDataDir()
      const root = await join(base, 'data', 'audio-cache')
      const dir = await join(root, 'v2')
      if (!(await exists(dir))) await mkdir(dir, { recursive: true })
      void removeLegacyFiles(root)
      void pruneCacheDir(dir)
      return dir
    })()
  }
  return dirPromise
}

/** 启动后静默清理一次:条数/字节任一超预算就从最旧删起,防缓存目录无界膨胀 */
async function pruneCacheDir(dir: string): Promise<void> {
  try {
    const entries = await readDir(dir)
    const files = entries.filter((e) => e.isFile && e.name?.endsWith('.wav.txt')).map((e) => e.name!)
    if (files.length === 0) return
    const metas = await Promise.all(
      files.map(async (name) => {
        const f = await join(dir, name)
        const st = await stat(f).catch(() => null)
        return { f, size: st?.size ?? 0, t: st?.mtime?.getTime() ?? 0 }
      }),
    )
    metas.sort((a, b) => a.t - b.t)
    let total = metas.reduce((s, m) => s + m.size, 0)
    let count = metas.length
    for (const m of metas) {
      if (count <= MAX_CACHE_FILES && total <= MAX_CACHE_BYTES) break
      await remove(m.f).catch(() => {})
      total -= m.size
      count--
    }
  } catch {
    // 清理失败不影响合成主流程
  }
}

/** 磁盘命中:读 base64 还原字节,并顺手进内存层 */
export async function diskGet(hash: string): Promise<ArrayBuffer | undefined> {
  if (!inTauri) return undefined
  try {
    const file = await join(await cacheDir(), `${hash}.wav.txt`)
    if (!(await exists(file))) return undefined
    const bin = atob(await readTextFile(file))
    const bytes = new ArrayBuffer(bin.length)
    const arr = new Uint8Array(bytes)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    memPut(hash, bytes)
    return bytes
  } catch {
    return undefined
  }
}

/** 完整 wav 字节 base64 落盘。失败静默(下次重新合成) */
export async function diskPut(hash: string, bytes: Uint8Array): Promise<void> {
  if (!inTauri) return
  try {
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    const file = await join(await cacheDir(), `${hash}.wav.txt`)
    await writeTextFile(file, btoa(s))
  } catch {
    // 静默
  }
}

/** 在飞合成去重:同一 hash(预取+播放并发)只发一次请求 */
export const inflight = new Map<string, Promise<ArrayBuffer>>()
