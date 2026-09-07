// 配置外置：appData/data/config.json。首次运行写入默认值，之后读文件。
// 改配置两条路：编辑该文件后重启，或在应用内设置面板保存（立即生效）。
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'

export interface AppConfig {
  apiKey: string
  baseUrl: string
  model: string
}

// 默认值（首启写入）。想换端点：改 appData/data/config.json 后重启
export const DEFAULT_CONFIG: AppConfig = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
}

let cache: Promise<AppConfig> | null = null

export function getConfig(): Promise<AppConfig> {
  if (!cache) {
    cache = (async () => {
      try {
        const base = await appDataDir()
        const dir = await join(base, 'data')
        if (!(await exists(dir))) await mkdir(dir, { recursive: true })
        const file = await join(dir, 'config.json')
        if (await exists(file)) {
          const obj = JSON.parse(await readTextFile(file))
          return {
            apiKey: String(obj.apiKey || DEFAULT_CONFIG.apiKey),
            baseUrl: String(obj.baseUrl || DEFAULT_CONFIG.baseUrl),
            model: String(obj.model || DEFAULT_CONFIG.model),
          }
        }
        await writeTextFile(file, JSON.stringify(DEFAULT_CONFIG, null, 2))
      } catch (e) {
        console.warn('配置读取失败，使用默认', e)
      }
      return DEFAULT_CONFIG
    })()
  }
  return cache
}

/** 保存配置：先落盘，成功后刷新内存缓存。下一次生成即用新值，无需重启 */
export async function saveConfig(update: Partial<AppConfig>): Promise<AppConfig> {
  const current = await getConfig()
  const next = { ...current, ...update }
  const base = await appDataDir()
  const dir = await join(base, 'data')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  const file = await join(dir, 'config.json')
  await writeTextFile(file, JSON.stringify(next, null, 2))
  cache = Promise.resolve(next)
  return next
}
