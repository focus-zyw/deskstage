// 配置外置：appData/data/config.json。首次运行写入默认值，之后读文件。
// 改配置两条路：编辑该文件后重启，或在应用内设置面板保存（立即生效）。
// 浏览器预览(无 Tauri 运行时)降级为 localStorage,保证 dev 调试可用。
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'

/** 是否运行在 Tauri 窗口内(浏览器 dev 预览为 false,文件系统相关 API 不可用) */
export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const LS_KEY = 'vc-config'

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

/** 角色语音(硅基流动 CosyVoice2):开关 + TTS key + 两角色各自音色 */
export interface VoiceConfig {
  enabled: boolean
  /** 硅基流动 API key(与 LLM 的 key 相互独立) */
  apiKey: string
  /** 音色名(如 bella,完整 voice = 模型名:音色名) */
  A: string
  B: string
}

/** 使用者画像:手填的"角色认识你"信息(多值字段逗号/顿号/换行分隔) */
export interface UserProfile {
  /** 称呼,如"小张"(角色会这样叫你) */
  userName: string
  /** 职业/身份,如"在读研究生" */
  occupation: string
  /** 喜欢的话题/事物 */
  likes: string
  /** 讨厌的话题/事物 */
  dislikes: string
  /** 雷区:完全不聊的关键词 */
  banTopics: string
}

export interface AppConfig {
  apiKey: string
  /** 各厂商分别记忆的 API Key:键 = 预设厂商 id,自定义端点 = `custom:{baseUrl}`;
   *  apiKey 是当前生效值,切换厂商时从这里带出 */
  apiKeys: Record<string, string>
  baseUrl: string
  model: string
  /** 使用者画像:手填的"角色认识你"信息,注入所有对话 prompt */
  userProfile: UserProfile
  /** 角色语音 */
  voice: VoiceConfig
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
  /** 截屏配置 */
  screenshot: ScreenshotConfig
  /** 使用者的兴趣爱好(逗号/顿号/换行分隔);空 = 不介入对话 */
  userInterests: string
}

// 默认值（首启写入）。想换端点：改 appData/data/config.json 后重启。
// apiKey 默认空,在设置面板填写;勿将真实 key 提交进仓库
export const DEFAULT_CONFIG: AppConfig = {
  apiKey: '',
  apiKeys: {},
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  voice: {
    enabled: true,
    apiKey: '',
    A: 'bella', // 女声·轻快 → 便利店店员
    B: 'alex', // 男声·沉稳 → 程序员
  },
  autoReplayMin: 10,
  characters: {
    height: 320,
    A: { xPct: 20, bottom: 0 },
    B: { xPct: 80, bottom: 0 },
  },
  charactersHidden: false,
  topicOverride: null,
  ctrlBar: { xPct: 50, top: 10, collapsed: false },
  showWatermark: false,
  screenshot: { hotkey: 'Ctrl+Alt+A', enabled: true, hideSelf: true },
  userInterests: '',
  userProfile: { userName: '', occupation: '', likes: '', dislikes: '', banTopics: '' },
}

/** 清洗使用者画像:逐字段裁剪;likes 为空时回落旧 userInterests 字段(老配置平滑迁移) */
function sanitizeUserProfile(v: unknown, legacyInterests: string): UserProfile {
  const o = (v ?? {}) as Record<string, unknown>
  const str = (x: unknown, cap: number): string =>
    typeof x === 'string' ? x.trim().slice(0, cap) : ''
  const likes = str(o.likes, 200) || legacyInterests.slice(0, 200)
  return {
    userName: str(o.userName, 30),
    occupation: str(o.occupation, 60),
    likes,
    dislikes: str(o.dislikes, 200),
    banTopics: str(o.banTopics, 200),
  }
}

/** 清洗自动重放频率:非法值回退默认,钳位 0~1440 分钟(0=关闭) */
function sanitizeReplayMin(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CONFIG.autoReplayMin
  return Math.min(1440, n)
}

/** 清洗语音配置:开关缺省视为开(老配置平滑升级);音色不在当前音色表内(如
 *  Edge 时代的 zh-CN-* 旧值)自动回落默认,防止把非法音色发给 API 得 400 静默无声。
 *  TTS_VOICE_IDS 由 tts.ts 注入(避免 storage → engine 的反向依赖) */
export let TTS_VOICE_IDS: Set<string> = new Set()

export function registerVoiceIds(ids: string[]): void {
  TTS_VOICE_IDS = new Set(ids)
}

function sanitizeVoice(v: unknown): VoiceConfig {
  const d = DEFAULT_CONFIG.voice
  const o = (v ?? {}) as Record<string, unknown>
  const name = (x: unknown, fb: string): string => {
    const s = typeof x === 'string' ? x.trim().slice(0, 200) : ''
    // 克隆音色(speech: 开头,账号侧资源)直接放行;内置音色须在注册名单内
    if (s.startsWith('speech:')) return s
    return TTS_VOICE_IDS.size === 0 || TTS_VOICE_IDS.has(s) ? s || fb : fb
  }
  return {
    enabled: o.enabled !== false,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey.slice(0, 200) : d.apiKey,
    A: name(o.A, d.A),
    B: name(o.B, d.B),
  }
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

/** 控制栏位置:横向屏宽百分比 + 距顶部逻辑像素;collapsed = 收起只剩把手 */
export interface CtrlBarPos {
  xPct: number
  top: number
  collapsed: boolean
}

/** 截屏(ShareX 式框选)配置 */
export interface ScreenshotConfig {
  /** 全局快捷键(global-shortcut 格式,如 Ctrl+Alt+A);空串 = 不设 */
  hotkey: string
  /** 是否启用全局快捷键 */
  enabled: boolean
  /** 系统级把本窗口从屏幕捕获中排除(WDA_EXCLUDEFROMCAPTURE,Win10 2004+):
   *  角色不出现在任何截图/录屏里 */
  hideSelf: boolean
}

/** 清洗控制栏位置:非法/缺字段回默认并钳位 */
function sanitizeCtrlBar(v: unknown): CtrlBarPos {
  const d = DEFAULT_CONFIG.ctrlBar
  const o = (v ?? {}) as Record<string, unknown>
  return {
    xPct: clampNum(o.xPct, 2, 98, d.xPct),
    top: clampNum(o.top, 0, 400, d.top),
    collapsed: o.collapsed === true,
  }
}

/** 清洗截屏配置:快捷键截断,开关缺省视为开(与"角色不需要额外操作即有截图"的预期一致) */
function sanitizeScreenshot(v: unknown): ScreenshotConfig {
  const o = (v ?? {}) as Record<string, unknown>
  const hotkey = typeof o.hotkey === 'string' ? o.hotkey.trim().slice(0, 60) : ''
  return {
    hotkey,
    enabled: o.enabled !== false,
    hideSelf: o.hideSelf !== false,
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

/** 从任意 JSON 对象构造合法配置(字段级清洗,文件与 localStorage 共用) */
function sanitizeConfig(obj: unknown): AppConfig {
  const o = (obj ?? {}) as Record<string, unknown>
  return {
    apiKey: String(o.apiKey || DEFAULT_CONFIG.apiKey),
    apiKeys: sanitizeApiKeys(o.apiKeys),
    voice: sanitizeVoice(o.voice),
    baseUrl: String(o.baseUrl || DEFAULT_CONFIG.baseUrl),
    model: String(o.model || DEFAULT_CONFIG.model),
    autoReplayMin: sanitizeReplayMin(o.autoReplayMin),
    characters: sanitizeCharacters(o.characters),
    charactersHidden: o.charactersHidden === true,
    topicOverride:
      typeof o.topicOverride === 'string' && o.topicOverride.trim()
        ? o.topicOverride.trim()
        : null,
    ctrlBar: sanitizeCtrlBar(o.ctrlBar),
    showWatermark: o.showWatermark === true,
    screenshot: sanitizeScreenshot(o.screenshot),
    userInterests: typeof o.userInterests === 'string' ? o.userInterests.trim() : '',
    userProfile: sanitizeUserProfile(o.userProfile, typeof o.userInterests === 'string' ? o.userInterests : ''),
  }
}

export function getConfig(): Promise<AppConfig> {
  if (!cache) {
    cache = (async () => {
      if (!inTauri) {
        // 浏览器预览:localStorage 有则用,否则默认
        try {
          const raw = localStorage.getItem(LS_KEY)
          if (raw) return sanitizeConfig(JSON.parse(raw))
        } catch (e) {
          console.warn('浏览器配置读取失败，使用默认', e)
        }
        return DEFAULT_CONFIG
      }
      try {
        const base = await appDataDir()
        const dir = await join(base, 'data')
        if (!(await exists(dir))) await mkdir(dir, { recursive: true })
        const file = await join(dir, 'config.json')
        if (await exists(file)) {
          return sanitizeConfig(JSON.parse(await readTextFile(file)))
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
    if (!inTauri) {
      localStorage.setItem(LS_KEY, JSON.stringify(merged))
      return merged
    }
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
