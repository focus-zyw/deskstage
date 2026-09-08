// 配置外置：appData/data/config.json。首次运行写入默认值，之后读文件。
// 改配置两条路：编辑该文件后重启，或在应用内设置面板保存（立即生效）。
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'

export interface CharPos {
  /** 角色中心点横向位置(屏宽百分比) */
  xPct: number
  /** 距窗口底部(逻辑像素) */
  bottom: number
}

/** 角色布局:缩放(height)全局一致,位置各自独立 */
export interface CharactersConfig {
  height: number
  A: CharPos
  B: CharPos
}

export interface AppConfig {
  apiKey: string
  /** 各厂商分别记忆的 API Key:键 = 预设厂商 id,自定义端点 = `custom:{baseUrl}`;
   *  apiKey 是当前生效值,切换厂商时从这里带出 */
  apiKeys: Record<string, string>
  baseUrl: string
  model: string
  /** 空闲多少分钟后自动重放历史对话;0 = 关闭 */
  autoReplayMin: number
  /** 角色布局(位置各自独立,缩放共享) */
  characters: CharactersConfig
  /** 隐藏角色开关 */
  charactersHidden: boolean
  /** 手动锁定的聊天主题;null = 从话题池随机 */
  topicOverride: string | null
  /** 控制栏位置(可拖动) */
  ctrlBar: CtrlBarPos
  /** 左上角水印开关 */
  showWatermark: boolean
}

// 默认值（首启写入）。想换端点：改 appData/data/config.json 后重启。
// apiKey 默认空,在设置面板填写;勿将真实 key 提交进仓库
export const DEFAULT_CONFIG: AppConfig = {
  apiKey: '',
  apiKeys: {},
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  autoReplayMin: 10,
  characters: {
    height: 320,
    A: { xPct: 20, bottom: 0 },
    B: { xPct: 80, bottom: 0 },
  },
  charactersHidden: false,
  topicOverride: null,
  ctrlBar: { xPct: 50, top: 10 },
  showWatermark: false,
}

/** 清洗自动重放频率:非法值回退默认,钳位 0~1440 分钟(0=关闭) */
function sanitizeReplayMin(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CONFIG.autoReplayMin
  return Math.min(1440, n)
}

/** 清洗按厂商记忆的 apiKeys:只收字符串键值,限 50 条、键 100/值 500 字符,防膨胀 */
function sanitizeApiKeys(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && k.length > 0 && k.length <= 100) {
      out[k.slice(0, 100)] = val.slice(0, 500)
    }
    if (Object.keys(out).length >= 50) break
  }
  return out
}

/** 控制栏位置:横向屏宽百分比 + 距顶部逻辑像素 */
export interface CtrlBarPos {
  xPct: number
  top: number
}

/** 清洗控制栏位置:非法/缺字段回默认并钳位 */
function sanitizeCtrlBar(v: unknown): CtrlBarPos {
  const d = DEFAULT_CONFIG.ctrlBar
  const o = (v ?? {}) as Record<string, unknown>
  return {
    xPct: clampNum(o.xPct, 2, 98, d.xPct),
    top: clampNum(o.top, 0, 400, d.top),
  }
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

/** 清洗角色布局:非法/缺字段逐项回退默认并钳位 */
function sanitizeCharacters(v: unknown): CharactersConfig {
  const d = DEFAULT_CONFIG.characters
  const o = (v ?? {}) as Record<string, Record<string, unknown>>
  const pos = (p: unknown, dft: CharPos): CharPos => {
    const q = (p ?? {}) as Record<string, unknown>
    return {
      xPct: clampNum(q.xPct, 3, 97, dft.xPct),
      bottom: clampNum(q.bottom, 0, 4000, dft.bottom),
    }
  }
  return {
    // 上下限放宽:真正的屏幕级钳位在 App 内按实际分辨率做
    height: clampNum(o.height, 140, 2000, d.height),
    A: pos(o.A, d.A),
    B: pos(o.B, d.B),
  }
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
            apiKeys: sanitizeApiKeys(obj.apiKeys),
            baseUrl: String(obj.baseUrl || DEFAULT_CONFIG.baseUrl),
            model: String(obj.model || DEFAULT_CONFIG.model),
            autoReplayMin: sanitizeReplayMin(obj.autoReplayMin),
            characters: sanitizeCharacters(obj.characters),
            charactersHidden: obj.charactersHidden === true,
            topicOverride:
              typeof obj.topicOverride === 'string' && obj.topicOverride.trim()
                ? obj.topicOverride.trim()
                : null,
            ctrlBar: sanitizeCtrlBar(obj.ctrlBar),
            showWatermark: obj.showWatermark === true,
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

/** 保存配置：先落盘，成功后刷新内存缓存。下一次生成即用新值，无需重启。
 *  读-改-写进锁:布局保存与设置保存并发时不会互相覆盖 */
export async function saveConfig(update: Partial<AppConfig>): Promise<AppConfig> {
  const next = await withFileLock('config', async () => {
    const current = await getConfig()
    const merged = { ...current, ...update }
    const base = await appDataDir()
    const dir = await join(base, 'data')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    const file = await join(dir, 'config.json')
    await writeTextFile(file, JSON.stringify(merged, null, 2))
    return merged
  })
  cache = Promise.resolve(next)
  return next
}
