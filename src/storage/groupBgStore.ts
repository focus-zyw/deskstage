// 群聊背景图持久化:appData/data/group-bg.txt 存 data URL 文本。
// 二进制走 base64 文本是项目既定模式(tts/cache.ts),CSP 未限制 data: 可直接当 img src;
// 启用标记在 config.groupChat.bg(图本体与配置解耦,删图不改配置结构)。
// 所有操作静默容错——背景失败不影响聊天主流程。
import { readTextFile, writeTextFile, exists, mkdir, remove } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'

/** data URL 白名单:只收常见位图;上限 ~6MB(压缩后正常 <1MB) */
const PREFIX_RE = /^data:image\/(png|jpeg|webp|gif);base64,/
const MAX_LEN = 8 * 1024 * 1024

function validDataUrl(s: string): boolean {
  return s.length <= MAX_LEN && PREFIX_RE.test(s)
}

let filePromise: Promise<string> | null = null

/** appData/data/group-bg.txt(懒创建,缓存 promise) */
function getBgFile(): Promise<string> {
  if (!filePromise) {
    filePromise = (async () => {
      const base = await appDataDir()
      const dir = await join(base, 'data')
      if (!(await exists(dir))) await mkdir(dir, { recursive: true })
      return join(dir, 'group-bg.txt')
    })()
  }
  return filePromise
}

/** 保存背景图 data URL(已由 UI 侧 canvas 压缩),失败返回 false */
export async function saveGroupBg(dataUrl: string): Promise<boolean> {
  if (!validDataUrl(dataUrl)) return false
  try {
    await withFileLock('group-bg', async () => {
      await writeTextFile(await getBgFile(), dataUrl)
    })
    return true
  } catch (e) {
    console.warn('群聊背景保存失败', e)
    return false
  }
}

/** 读取背景图 data URL;无图/非法/非 Tauri 环境返回 null */
export async function loadGroupBg(): Promise<string | null> {
  try {
    const file = await getBgFile()
    if (!(await exists(file))) return null
    const raw = (await readTextFile(file)).trim()
    return validDataUrl(raw) ? raw : null
  } catch (e) {
    console.warn('群聊背景读取失败', e)
    return null
  }
}

/** 移除背景图文件(启用标记由调用方走 config.groupChat.bg) */
export async function clearGroupBg(): Promise<void> {
  try {
    await withFileLock('group-bg', async () => {
      const file = await getBgFile()
      if (await exists(file)) await remove(file)
    })
  } catch (e) {
    console.warn('群聊背景清除失败', e)
  }
}
