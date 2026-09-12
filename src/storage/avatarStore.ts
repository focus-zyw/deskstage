// 群聊头像持久化:appData/data/avatars/{a|b|c|user}.txt,各存一张 data URL 文本。
// 与群背景同款模式(base64 文本,CSP 不限 data: src);文件存在即有头像,
// 无独立启用标记——清除 = 删文件。所有操作静默容错。
import { readTextFile, writeTextFile, exists, mkdir, remove } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'

export type AvatarKey = 'a' | 'b' | 'c' | 'user'
export const AVATAR_KEYS: AvatarKey[] = ['a', 'b', 'c', 'user']

/** data URL 白名单与上限(头像经 UI 压缩到 128px,正常 <30KB;上限兜底) */
const PREFIX_RE = /^data:image\/(png|jpeg|webp|gif);base64,/
const MAX_LEN = 512 * 1024

export type AvatarMap = Record<AvatarKey, string | null>

function emptyMap(): AvatarMap {
  return { a: null, b: null, c: null, user: null }
}

function validDataUrl(s: string): boolean {
  return s.length <= MAX_LEN && PREFIX_RE.test(s)
}

let dirPromise: Promise<string> | null = null

/** appData/data/avatars 目录(懒创建,缓存 promise) */
function getAvatarDir(): Promise<string> {
  if (!dirPromise) {
    dirPromise = (async () => {
      const base = await appDataDir()
      const dir = await join(base, 'data', 'avatars')
      if (!(await exists(dir))) await mkdir(dir, { recursive: true })
      return dir
    })()
  }
  return dirPromise
}

/** 保存一张头像(data URL),失败返回 false */
export async function saveAvatar(key: AvatarKey, dataUrl: string): Promise<boolean> {
  if (!validDataUrl(dataUrl)) return false
  try {
    await withFileLock('avatars', async () => {
      await writeTextFile(await join(await getAvatarDir(), `${key}.txt`), dataUrl)
    })
    return true
  } catch (e) {
    console.warn('头像保存失败', e)
    return false
  }
}

/** 读全部头像;缺文件/非法/非 Tauri 环境的键为 null */
export async function loadAvatars(): Promise<AvatarMap> {
  const out = emptyMap()
  try {
    const dir = await getAvatarDir()
    for (const key of AVATAR_KEYS) {
      try {
        const file = await join(dir, `${key}.txt`)
        if (!(await exists(file))) continue
        const raw = (await readTextFile(file)).trim()
        if (validDataUrl(raw)) out[key] = raw
      } catch {
        // 单张失败不影响其余
      }
    }
  } catch (e) {
    console.warn('头像读取失败', e)
  }
  return out
}

/** 移除一张头像(文件不存在视为已清) */
export async function clearAvatar(key: AvatarKey): Promise<void> {
  try {
    await withFileLock('avatars', async () => {
      const file = await join(await getAvatarDir(), `${key}.txt`)
      if (await exists(file)) await remove(file)
    })
  } catch (e) {
    console.warn('头像清除失败', e)
  }
}
