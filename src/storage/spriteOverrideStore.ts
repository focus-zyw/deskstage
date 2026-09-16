// 角色工坊立绘覆盖持久层:appData/data/sprites/{a|b}/{file}.txt,每图一个
// data URL 文本文件(仅 png/webp,保透明通道;单图 ≤ 1MB);浏览器预览降级
// localStorage `vc-sprites-{slot}`。文件存在即覆盖生效,删除即还原默认。
// 内存生效走 spriteSets.applySpriteOverride(渲染层唯一拼装点 spriteFileSrc 查缓存);
// 读写 withFileLock + 静默容错,与 avatarStore 同一套约定。
import { readTextFile, writeTextFile, exists, mkdir, remove, readDir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'
import { SPRITE_SETS, spriteFileWhitelist, applySpriteOverrides, applySpriteOverride } from '../stage/spriteSets'

export type SpriteSlot = 'a' | 'b'

/** 仅 png/webp:立绘需要透明通道(拒绝 jpeg 白底) */
const DATA_URL_RE = /^data:image\/(png|webp);base64,/
export const MAX_SPRITE_DATA_URL = 1024 * 1024

const LS_PREFIX = 'vc-sprites-'

const setOf = (slot: SpriteSlot) => SPRITE_SETS[slot === 'a' ? 'A' : 'B']

/** 文件名必须在白名单内(动作图/变体图),防任意路径写入 */
export function isKnownSpriteFile(slot: SpriteSlot, file: string): boolean {
  return spriteFileWhitelist(setOf(slot)).has(file)
}

export function validateSpriteDataUrl(dataUrl: string): string | null {
  if (!DATA_URL_RE.test(dataUrl)) return '只支持 PNG / WebP 格式(立绘需要透明背景)'
  if (dataUrl.length > MAX_SPRITE_DATA_URL) return '图片太大(编码后需 ≤ 1MB),请缩小尺寸后再试'
  return null
}

const lsKey = (slot: SpriteSlot) => `${LS_PREFIX}${slot}`

function readLsMap(slot: SpriteSlot): Record<string, string> {
  try {
    const raw = localStorage.getItem(lsKey(slot))
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [file, v] of Object.entries(obj)) {
        if (typeof v === 'string' && DATA_URL_RE.test(v) && isKnownSpriteFile(slot, file)) out[file] = v
      }
      return out
    }
  } catch {
    // 坏数据按空表处理
  }
  return {}
}

function writeLsMap(slot: SpriteSlot, map: Record<string, string>): void {
  try {
    localStorage.setItem(lsKey(slot), JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

/** 读单槽全部覆盖(文件 → data URL)。磁盘目录枚举;坏文件跳过 */
export async function listSpriteOverrides(slot: SpriteSlot): Promise<Record<string, string>> {
  if (!inTauri) return readLsMap(slot)
  try {
    const dir = await join(await appDataDir(), 'data', 'sprites', slot)
    if (!(await exists(dir))) return {}
    const entries = await readDir(dir)
    const map: Record<string, string> = {}
    for (const entry of entries) {
      if (!entry.name.endsWith('.txt')) continue
      const file = entry.name.slice(0, -4)
      if (!isKnownSpriteFile(slot, file)) continue
      const content = (await readTextFile(await join(dir, entry.name))).trim()
      if (DATA_URL_RE.test(content) && content.length <= MAX_SPRITE_DATA_URL) map[file] = content
    }
    return map
  } catch (e) {
    console.warn('立绘覆盖读取失败(按无覆盖处理)', e)
    return {}
  }
}

async function writeFileOverride(slot: SpriteSlot, file: string, dataUrl: string | null): Promise<void> {
  if (!inTauri) return // 浏览器/测试:仅 localStorage(由调用方维护)
  const base = await appDataDir()
  const dir = await join(base, 'data', 'sprites', slot)
  await withFileLock(`sprites-${slot}`, async () => {
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    const target = await join(dir, `${file}.txt`)
    if (dataUrl === null) {
      if (await exists(target)) await remove(target)
    } else {
      await writeTextFile(target, dataUrl)
    }
  })
}

/** 保存单张覆盖(校验通过才生效);返回 null=成功,否则为可读错误 */
export async function saveSpriteOverride(slot: SpriteSlot, file: string, dataUrl: string): Promise<string | null> {
  if (!isKnownSpriteFile(slot, file)) return '未知的贴图文件名'
  const invalid = validateSpriteDataUrl(dataUrl)
  if (invalid) return invalid
  await writeFileOverride(slot, file, dataUrl)
  applySpriteOverride(setOf(slot).dir, file, dataUrl)
  if (!inTauri) {
    const map = readLsMap(slot)
    map[file] = dataUrl
    writeLsMap(slot, map)
  }
  return null
}

/** 清除单张覆盖(还原默认立绘) */
export async function clearSpriteOverride(slot: SpriteSlot, file: string): Promise<void> {
  if (!isKnownSpriteFile(slot, file)) return
  await writeFileOverride(slot, file, null)
  applySpriteOverride(setOf(slot).dir, file, null)
  if (!inTauri) {
    const map = readLsMap(slot)
    delete map[file]
    writeLsMap(slot, map)
  }
}

/** 还原整槽(全部默认立绘) */
export async function clearAllSpriteOverrides(slot: SpriteSlot): Promise<void> {
  const map = await listSpriteOverrides(slot)
  for (const file of Object.keys(map)) await clearSpriteOverride(slot, file)
}

let loaded: Promise<void> | null = null

/** 启动预载:把磁盘覆盖装进 spriteSets 缓存(未加载前渲染默认图,加载后订阅重绘) */
export function ensureSpriteOverridesLoaded(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      for (const slot of ['a', 'b'] as const) {
        applySpriteOverrides(setOf(slot).dir, await listSpriteOverrides(slot))
      }
    })().catch((e) => {
      console.warn('立绘覆盖预载失败(按无覆盖处理)', e)
      loaded = null
    })
  }
  return loaded
}
