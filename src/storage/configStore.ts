// 配置外置：appData/data/config.json。首次运行写入默认值，之后读文件。
// 改配置两条路：编辑该文件后重启，或在应用内设置面板保存（立即生效）。
// 浏览器预览(无 Tauri 运行时)降级为 localStorage,保证 dev 调试可用。
import { useSyncExternalStore } from 'react'
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { LANGUAGES, type TranslationStyle } from '../translation/types'

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

/** 语音供应商:硅基流动 CosyVoice2(默认)/ MiniMax Speech 2.8 / 本地 CosyVoice(预留) */
export const TTS_PROVIDERS = ['siliconflow', 'minimax', 'local'] as const
export type TtsProviderId = (typeof TTS_PROVIDERS)[number]

/** 语音合成用的模型档位(MiniMax):turbo 便宜流式 / hd 质量优先 */
export type MiniMaxModel = 'speech-2.8-turbo' | 'speech-2.8-hd'

/** 角色语音:开关 + 当前供应商 + 每供应商各自的角色音色分配(切换供应商互不影响) */
export interface VoiceConfig {
  enabled: boolean
  /** 当前语音供应商 */
  provider: TtsProviderId
  /** 硅基流动 API key(与 LLM 的 key 相互独立) */
  apiKey: string
  /** MiniMax 独立凭据(key 与 GroupId 都必填) */
  minimax: { apiKey: string; groupId: string; model: MiniMaxModel }
  /** 每供应商的角色音色分配(A/B 主角,C = 场外客串);
   *  旧配置的顶层 A/B/C 是硅基流动音色,清洗时迁移进 assignments.siliconflow */
  assignments: Record<TtsProviderId, { A: string; B: string; C: string }>
  /** 自然语言情感指令:把 deadpan/excited/slow 映射成语气描述(供应商自行表达) */
  emotionHints: boolean
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
  /** 网页版生成:开启后主演出(相声/日常段子)改经隐藏网页窗口由网页模型生成,
   *  失败自动回退 API;其余小调用(记忆提取/演出标注/短聊)仍走 API */
  webchatEnabled: boolean
  /** 网页模型站点 */
  webchatSite: 'deepseek' | 'doubao'
  /** 桌面环境感知(电量/前台应用分类等,仅本机分类不上传) */
  envSense: boolean
  /** 久坐提醒(番茄钟):连续活跃 X 分钟后用角色口吻提醒休息 */
  breakReminder: { enabled: boolean; minutes: number }
  /** 用户自定义人设(甲/乙的生效文本;空串 = 内置默认) */
  persona: { a: string; b: string }
  /** 角色名(名牌与台词称呼) */
  names: { a: string; b: string }
  /** 备忘默认提前提醒分钟数 */
  memo: { advanceMin: number }
  /** 勿扰:一键全静(TTS 静音 + 主动行为暂停;备忘卡片仍弹) */
  dnd: boolean
  /** 主动程度:角色自发说话的频率档位(安静/平衡/热闹) */
  proactivity: 'quiet' | 'balanced' | 'lively'
  /** 翻译面板:语言方向/风格/自动朗读(与演出模块完全隔离,不进对话与记忆) */
  translation: TranslationConfig
  /** 提取文字:AI 视觉模型优先 + 本地 OCR 兜底 */
  ocr: OcrConfig
  /** 主播模式:直播弹幕互动 */
  live: LiveConfig
  /** 开机自启动(Windows 写 HKCU Run 注册表键);默认关。
   *  配置是唯一事实来源:应用启动时按此值与系统注册状态对账 */
  launchOnBoot: boolean
}

/** 翻译面板配置 */
export interface TranslationConfig {
  /** 源语言代码;'auto' = 自动检测 */
  sourceLanguage: string
  /** 目标语言代码 */
  targetLanguage: string
  style: TranslationStyle
  /** 翻译完成后自动朗读结果 */
  autoSpeak: boolean
}

/** 提取文字的 AI 识别配置:视觉模型(OpenAI 兼容)优先,失败自动回退本地 Windows OCR。
 *  与主 LLM 相互独立——主模型可能是纯文本(如 deepseek-chat),发图会直接报错。
 *  默认指向智谱的免费视觉模型,只需在 bigmodel.cn 注册拿个 key */
export interface OcrConfig {
  /** API Key;空 = 未配置,直接走本地识别 */
  apiKey: string
  /** OpenAI 兼容端点根(不含 /chat/completions) */
  baseUrl: string
  /** 视觉模型名 */
  model: string
}

/** 主播模式(直播弹幕互动):平台 + 直播间号 + 登录凭证。
 *  roomId 留空 = 点"开播"时气泡引导去设置;platform v1 只有 bilibili 可用(douyin 为桩)。
 *  cookie 选填:B站任意已登录账号的 SESSDATA(或完整 Cookie 串),不带则观众名被打码
 *  (如"张***"),带了解锁真实用户名与舰长等级;建议用小号。
 *  giftReactionsEnabled = 礼物互动(道具动效与感谢语,一个开关管两者);缺省视为开(老配置平滑升级) */
export interface LiveConfig {
  platform: 'bilibili' | 'douyin'
  roomId: string
  cookie: string
  giftReactionsEnabled?: boolean
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
    provider: 'siliconflow',
    apiKey: '',
    minimax: { apiKey: '', groupId: '', model: 'speech-2.8-turbo' },
    assignments: {
      // 女声·轻快 → 便利店店员 / 男声·沉稳 → 程序员 / 场外客串(房东/快递员等画外音)
      siliconflow: { A: 'bella', B: 'alex', C: 'david' },
      minimax: { A: 'female-shaonv', B: 'male-qn-qingse', C: 'male-qn-jingying' },
      local: { A: '', B: '', C: '' },
    },
    emotionHints: true,
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
  webchatEnabled: false,
  webchatSite: 'deepseek',
  envSense: true,
  breakReminder: { enabled: false, minutes: 45 },
  persona: { a: '', b: '' },
  names: { a: '甲', b: '乙' },
  memo: { advanceMin: 30 },
  dnd: false,
  proactivity: 'balanced',
  translation: { sourceLanguage: 'auto', targetLanguage: 'zh-CN', style: 'natural', autoSpeak: false },
  ocr: {
    apiKey: '',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6v-flash',
  },
  live: { platform: 'bilibili', roomId: '', cookie: '', giftReactionsEnabled: true },
  launchOnBoot: false,
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

/** 清洗语音配置:开关缺省视为开(老配置平滑升级);音色不在对应供应商的注册名单内
 *  自动回落默认,防止把非法音色发给 API 得 400 静默无声。
 *  各供应商的音色名单由 tts 模块注入(避免 storage → engine 的反向依赖);
 *  硅基流动的克隆音色(speech: 开头)是账号侧资源,单独放行不参与名单校正 */
const TTS_VOICE_IDS: Record<TtsProviderId, Set<string>> = {
  siliconflow: new Set(),
  minimax: new Set(),
  local: new Set(),
}

export function registerVoiceIds(provider: TtsProviderId, ids: string[]): void {
  TTS_VOICE_IDS[provider] = new Set(ids)
}

function sanitizeVoice(v: unknown): VoiceConfig {
  const d = DEFAULT_CONFIG.voice
  const o = (v ?? {}) as Record<string, unknown>
  const nameOf = (provider: TtsProviderId, x: unknown, fb: string): string => {
    const s = typeof x === 'string' ? x.trim().slice(0, 200) : ''
    // 克隆音色(speech: 开头,账号侧资源)直接放行;内置音色须在注册名单内
    if (provider === 'siliconflow' && s.startsWith('speech:')) return s
    const allowed = TTS_VOICE_IDS[provider]
    return allowed.size === 0 || allowed.has(s) ? s || fb : fb
  }
  // 旧配置迁移:顶层 A/B/C 就是硅基流动音色;新配置 assignments 优先
  const rawAssign = (o.assignments ?? {}) as Record<string, unknown>
  const slot3 = (provider: TtsProviderId, src: unknown): { A: string; B: string; C: string } => {
    const s = (src ?? {}) as Record<string, unknown>
    const dd = d.assignments[provider]
    return {
      A: nameOf(provider, s.A, dd.A),
      B: nameOf(provider, s.B, dd.B),
      C: nameOf(provider, s.C, dd.C),
    }
  }
  const mm = (o.minimax ?? {}) as Record<string, unknown>
  const str = (x: unknown, cap: number): string =>
    typeof x === 'string' ? x.trim().slice(0, cap) : ''
  return {
    enabled: o.enabled !== false,
    provider: (TTS_PROVIDERS as readonly string[]).includes(String(o.provider))
      ? (o.provider as TtsProviderId)
      : d.provider,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey.slice(0, 200) : d.apiKey,
    minimax: {
      apiKey: str(mm.apiKey, 200),
      groupId: str(mm.groupId, 64),
      model: mm.model === 'speech-2.8-hd' ? 'speech-2.8-hd' : 'speech-2.8-turbo',
    },
    assignments: {
      siliconflow: slot3('siliconflow', rawAssign.siliconflow ?? ('A' in o ? o : undefined)),
      minimax: slot3('minimax', rawAssign.minimax),
      local: slot3('local', rawAssign.local),
    },
    emotionHints: o.emotionHints !== false,
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
    webchatEnabled: o.webchatEnabled === true,
    webchatSite: o.webchatSite === 'doubao' ? 'doubao' : 'deepseek',
    envSense: o.envSense !== false,
    breakReminder: ((): { enabled: boolean; minutes: number } => {
      const b = (o.breakReminder ?? {}) as Record<string, unknown>
      return {
        enabled: b.enabled === true,
        minutes: Math.min(120, Math.max(15, Number(b.minutes) || 45)),
      }
    })(),
    persona: ((): { a: string; b: string } => {
      const pr = (o.persona ?? {}) as Record<string, unknown>
      const cap = (x: unknown): string => (typeof x === 'string' ? x.trim().slice(0, 600) : '')
      return { a: cap(pr.a), b: cap(pr.b) }
    })(),
    names: ((): { a: string; b: string } => {
      const nm = (o.names ?? {}) as Record<string, unknown>
      const name = (x: unknown, dft: string): string => (typeof x === 'string' ? x.trim().slice(0, 12) : '') || dft
      return { a: name(nm.a, '甲'), b: name(nm.b, '乙') }
    })(),
    memo: ((): { advanceMin: number } => {
      const mm = (o.memo ?? {}) as Record<string, unknown>
      const v = Number(mm.advanceMin)
      return { advanceMin: Number.isFinite(v) && v >= 1 ? Math.min(1440, Math.round(v)) : 30 }
    })(),
    dnd: o.dnd === true,
    proactivity:
      o.proactivity === 'quiet' || o.proactivity === 'lively' ? o.proactivity : 'balanced',
    translation: ((): TranslationConfig => {
      const t = (o.translation ?? {}) as Record<string, unknown>
      const code = (x: unknown, dft: string): string => {
        const s = typeof x === 'string' ? x.trim().slice(0, 24) : ''
        // 只放行 auto 与已知语言代码,手改配置文件写进奇怪值时回默认
        return s === 'auto' || LANGUAGES.some((l) => l.code === s) ? s : dft
      }
      return {
        sourceLanguage: code(t.sourceLanguage, DEFAULT_CONFIG.translation.sourceLanguage),
        targetLanguage: code(t.targetLanguage, DEFAULT_CONFIG.translation.targetLanguage),
        style:
          t.style === 'literal' || t.style === 'polished'
            ? t.style
            : DEFAULT_CONFIG.translation.style,
        autoSpeak: t.autoSpeak === true,
      }
    })(),
    ocr: ((): OcrConfig => {
      const d = DEFAULT_CONFIG.ocr
      const c = (o.ocr ?? {}) as Record<string, unknown>
      const str = (x: unknown, cap: number): string =>
        typeof x === 'string' ? x.trim().slice(0, cap) : ''
      // key 留空 = 关闭 AI 识别;地址/模型清空则回默认,防止拼出打不通的端点
      return {
        apiKey: str(c.apiKey, 200),
        baseUrl: str(c.baseUrl, 200) || d.baseUrl,
        model: str(c.model, 100) || d.model,
      }
    })(),
    live: ((): LiveConfig => {
      const c = (o.live ?? {}) as Record<string, unknown>
      // platform 只认白名单值(抖音为桩,v1 恒回 bilibili);roomId 纯数字校验;cookie 截断防膨胀
      const roomId = typeof c.roomId === 'string' ? c.roomId.trim().slice(0, 32) : ''
      return {
        platform: c.platform === 'douyin' ? 'douyin' : 'bilibili',
        roomId: /^\d*$/.test(roomId) ? roomId : '',
        cookie: typeof c.cookie === 'string' ? c.cookie.trim().slice(0, 600) : '',
        giftReactionsEnabled: c.giftReactionsEnabled !== false,
      }
    })(),
    launchOnBoot: o.launchOnBoot === true,
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
  publishConfig(next)
  return next
}

// ---------- 订阅:配置作为可观察事实源 ----------
// 设置窗口/舞台/运行时读同一份已加载配置,不再各自维护镜像 state;
// 首次加载与每次 saveConfig 成功后发布。读取方用 useConfigSnapshot(),
// 非 React 侧用 getConfigSnapshot()(始终可用,未加载完前为 DEFAULT_CONFIG)。

let snapshot: AppConfig = DEFAULT_CONFIG
const configListeners = new Set<() => void>()

function publishConfig(next: AppConfig): void {
  snapshot = next
  configListeners.forEach((l) => l())
}

export function getConfigSnapshot(): AppConfig {
  return snapshot
}

export function subscribeConfig(l: () => void): () => void {
  configListeners.add(l)
  // 订阅即对账一次:若磁盘读取晚于首个订阅者,补一发通知
  void getConfig().then(publishConfig)
  return () => {
    configListeners.delete(l)
  }
}

export function useConfigSnapshot(): AppConfig {
  return useSyncExternalStore(subscribeConfig, getConfigSnapshot)
}
