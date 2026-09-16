// 配置外置:appData/data/config.json,唯一写者是 Rust 统一状态中心(config_service)。
// 两个 WebView 都不直接碰文件:读经 config_get(版本迁移+凭据库密钥回填),写经
// config_set(Rust 进程锁串行化 + 密钥事务 + 临时文件 rename 原子写 + config-changed
// 广播到全部窗口)。字段级 schema 校验/清洗/默认值单源在本文件(FIELD_SANITIZERS 表),
// Rust 不复制 schema。保存失败时磁盘与内存旧值原样保留(回滚)。
// API Key / B站 Cookie 等敏感值不在此文件——只进系统凭据库(见 ./secrets.ts)。
// 浏览器预览(无 Tauri 运行时)降级为 localStorage,保证 dev 调试可用。
import { useSyncExternalStore } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { withFileLock } from './writeLock'
import { readSecret, writeSecret, type SecretId } from './secrets'
import { LANGUAGES, type TranslationStyle } from '../translation/types'
import { defaultPersonaText, type ActorSlot, type PersonaSourceSlot } from '../engine/persona'

/** 是否运行在 Tauri 窗口内(浏览器 dev 预览为 false,文件系统相关 API 不可用) */
export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const LS_KEY = 'vc-config'

export interface CharPos {
  /** 角色中心点横向位置(屏宽百分比) */
  xPct: number
  /** 距窗口底部(逻辑像素) */
  bottom: number
}

/** 常驻角色 C 的布局:视频素材 640×360,与 A/B 立绘不同尺寸体系,独立宽度与启用开关 */
export interface ResidentPos {
  xPct: number
  bottom: number
  /** 视频舞台显示宽度(px);实际身体约占宽度一半高 */
  width: number
  enabled: boolean
}

/** 角色布局:缩放(height)A/B 全局一致,C 独立;位置各自独立 */
export interface CharactersConfig {
  height: number
  A: CharPos
  B: CharPos
  C: ResidentPos
}

/** 语音供应商:硅基流动 CosyVoice2(默认)/ MiniMax Speech 2.8 / GPT-SoVITS 本地自建 / 本地 CosyVoice(预留) */
export const TTS_PROVIDERS = ['siliconflow', 'minimax', 'gptsovits', 'local'] as const
export type TtsProviderId = (typeof TTS_PROVIDERS)[number]

/** 语音合成用的模型档位(MiniMax):turbo 便宜流式 / hd 质量优先 */
export type MiniMaxModel = 'speech-2.8-turbo' | 'speech-2.8-hd'

/** GPT-SoVITS 参考音色:一个"音色" = 服务器本机的一段参考音频 + 它说的话。
 *  GPT-SoVITS 没有内置音色名,音色完全由参考音频决定,所以由用户在设置里维护这张表 */
export interface GptsovitsVoice {
  /** 稳定 id:进角色音色分配与缓存键;编辑路径/参考文本不改 id */
  id: string
  name: string
  /** 服务器本机的参考音频绝对路径(如 D:\gptsovits\refs\ana.wav) */
  refAudioPath: string
  /** 参考音频里说的话,语言须与 promptLang 一致(音色相似度的关键) */
  promptText: string
  /** 参考文本语言:zh/en/ja/ko/yue/auto */
  promptLang: string
}

/** GPT-SoVITS 本地自建服务(api_v2.py)配置 */
export interface GptsovitsConfig {
  /** 服务地址,默认本机 9880(api_v2.py 默认端口);填局域网地址可用别的机器跑推理 */
  url: string
  /** 台词语言,发给 api_v2 的 text_lang;auto = 按台词内容自动检测 */
  textLang: string
  /** 流式档位(api_v2 streaming_mode):1 质量优先首包最慢 / 2 平衡(默认)/ 3 首包最快音质略降 */
  streamMode: 1 | 2 | 3
  voices: GptsovitsVoice[]
}

/** 角色语音:开关 + 当前供应商 + 每供应商各自的角色音色分配(切换供应商互不影响) */
/** 语音对话的识别配置(实时语音闭环用):云端先行,local 留接口给二期 whisper.cpp */
export interface AsrConfig {
  provider: 'siliconflow' | 'local'
  /** OpenAI 兼容转录端点的模型名(官方列表:FunAudioLLM/SenseVoiceSmall、TeleAI/TeleSpeechASR) */
  model: string
  /** 硅基流动 API Key,独立于 TTS 的 key(TTS 用 MiniMax 时 ASR 仍可单独用硅基) */
  apiKey: string
}

export type VoiceChatMode = 'off' | 'ptt' | 'hands-free'

/** 实时语音对话配置:模式/设备/VAD 调参/打断。VAD 语义见 docs/实时语音对话设计方案.md:
 *  起声 = 连续 3 帧超 (噪声底 + vadSensitivityDb);止 = 静音 silenceMs;
 *  打断阈值 = 起声阈值再 + interruptExtraDb(外放回声防护,autoInterrupt 默认关) */
export interface VoiceChatConfig {
  mode: VoiceChatMode
  /** 麦克风设备 id;空串 = 系统默认 */
  deviceId: string
  /** 起声灵敏度:阈值相对噪声底高出多少 dB(小=更灵敏) */
  vadSensitivityDb: number
  /** 静音多久判定一句结束(ms) */
  silenceMs: number
  /** 自动打断(实验项):角色说话时用户开口即打断;外放场景可能误触发,建议耳机 */
  autoInterrupt: boolean
  /** 打断阈值在起声阈值基础上再抬多少 dB(回声防护) */
  interruptExtraDb: number
}

export interface VoiceConfig {
  enabled: boolean
  /** 当前语音供应商 */
  provider: TtsProviderId
  /** 硅基流动 API key(与 LLM 的 key 相互独立) */
  apiKey: string
  /** MiniMax 独立凭据(key 与 GroupId 都必填) */
  minimax: { apiKey: string; groupId: string; model: MiniMaxModel }
  /** GPT-SoVITS 本地服务配置(api_v2) */
  gptsovits: GptsovitsConfig
  /** 每供应商的角色音色分配(A/B 主角,C = 场外客串);
   *  旧配置的顶层 A/B/C 是硅基流动音色,清洗时迁移进 assignments.siliconflow */
  assignments: Record<TtsProviderId, { A: string; B: string; C: string }>
  /** 自然语言情感指令:把 deadpan/excited/slow 映射成语气描述(供应商自行表达) */
  emotionHints: boolean
  /** 语音识别(语音对话用) */
  asr: AsrConfig
  /** 实时语音对话 */
  voiceChat: VoiceChatConfig
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

/** 网页模型站点 id 白名单:与 Rust 侧 src-tauri/src/webchat/sites.rs 的 adapter
 *  注册表一一对应。新增站点 = 这里加一个 id + engine/webchat.ts 加一条 label
 *  + sites.rs 加一个 adapter(三处齐了才可用,缺一处会被下面两个清洗函数挡掉) */
export const WEBCHAT_SITE_IDS = ['deepseek', 'doubao', 'chatgpt', 'gemini', 'qianwen']
/** 站点恢复模式:auto = 自动(停滞时软唤醒→脉冲→必要时独立窗口);
 *  preferTab = 始终标签页(仍软唤醒/脉冲,禁止升级);preferDedicated = 始终独立窗口 */
export type WebchatSiteMode = 'auto' | 'preferTab' | 'preferDedicated'
export const WEBCHAT_SITE_MODES: WebchatSiteMode[] = ['auto', 'preferTab', 'preferDedicated']
export type WebchatSiteId = (typeof WEBCHAT_SITE_IDS)[number]

export function isWebchatSite(v: unknown): v is WebchatSiteId {
  return typeof v === 'string' && (WEBCHAT_SITE_IDS as readonly string[]).includes(v)
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
  /** 手动锁定的聊天主题;null = 从话题池随机(动态话题系统接管后仅作迁移遗留字段) */
  topicOverride: string | null
  /** 话题系统偏好:手动话题默认持续时间/跳跃距离 + AI 后台发现开关(默认关,涉费用) */
  topicPrefs: TopicPrefsConfig
  /** 界面主题:作用于设置窗口与命令/话题/抉择悬浮面板;角色舞台与工具栏不受影响 */
  theme: 'dark' | 'light'
  /** 观众抉择点出现概率:每集演出掷骰 0~1;0 = 不出抉择点(默认 0.3) */
  choiceChance: number
  /** 角色性别:代词/称呼纪律的事实源(默认对齐出厂音色 A=女 B=男 C=女);建议与音色性别一致 */
  genders: { a: '女' | '男'; b: '女' | '男'; c: '女' | '男' }
  /** 控制栏位置(可拖动) */
  ctrlBar: CtrlBarPos
  /** 左上角水印开关 */
  showWatermark: boolean
  /** 截屏配置 */
  screenshot: ScreenshotConfig
  /** 应用动作的全局快捷键 */
  hotkeys: HotkeysConfig
  /** 使用者的兴趣爱好(逗号/顿号/换行分隔);空 = 不介入对话 */
  userInterests: string
  /** 网页版生成:开启后主演出点播(全部模式,含模式工坊自定义)与直播弹幕回复(攒批慢速)
   *  改经隐藏网页窗口由网页模型生成,失败自动回退 API/内置剧本;
   *  其余小调用(记忆提取/演出标注/短聊)仍走 API */
  webchatEnabled: boolean
  /** 网页模型站点 */
  webchatSite: WebchatSiteId
  /** 站点恢复模式覆盖(方案 §十四;缺省 auto = 自动恢复)。
   *  持久化在配置;Hub 是内存态,应用启动时前端回放给 Rust */
  webchatSiteModes: Partial<Record<WebchatSiteId, WebchatSiteMode>>
  /** 桌面环境感知(电量/前台应用分类等,仅本机分类不上传) */
  envSense: boolean
  /** 环境感知注入冷却分钟数:同一条感知在此窗口内不重复进入提示词 */
  envNoteCooldownMin: number
  /** 上下文感知(敏感档,默认关):窗口标题采集 / 桌面文件数摘要。
   *  开启语义是"才向 Rust 请求采集",不是"采了不渲染" */
  contextSense: { windowTitle: boolean; desktopDigest: boolean }
  /** 久坐提醒(番茄钟):连续活跃 X 分钟后用角色口吻提醒休息 */
  breakReminder: { enabled: boolean; minutes: number }
  /** 用户自定义人设(甲/乙/丙的生效文本;空串 = 内置默认) */
  persona: { a: string; b: string; c: string }
  /** 人设来源(结构化事实):编辑文本→custom,清空/还原默认→default。
   *  话题包门控按此判断,不做人设文本比对(改名/旧文案滞留会让比对失真) */
  personaSource: { a: PersonaSourceSlot; b: PersonaSourceSlot; c: PersonaSourceSlot }
  /** 角色名(名牌与台词称呼) */
  names: { a: string; b: string; c: string }
  /** 备忘默认提前提醒分钟数 */
  memo: { advanceMin: number }
  /** 群聊(聊天记录页):群名与是否启用自定义背景图(图本体在 data/group-bg.txt) */
  groupChat: { name: string; bg: boolean }
  /** 勿扰:一键全静(TTS 静音 + 主动行为暂停;备忘卡片仍弹) */
  dnd: boolean
  /** 互动台词每日一换:每天自动生成一整套角色C互动台词(保留最近7天,超出删最早) */
  dailyLinePack: boolean
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
  /** 舞台气泡风格:comic=柔彩角色主题(默认,历史 key 保持兼容);glass=夜色半透明;
   *  custom_ 开头 = 气泡工坊自建主题 id(选中的主题被删除时运行时回退 comic) */
  bubbleStyle: 'comic' | 'glass' | (string & {})
  /** 记忆显示档:off=气泡不显示(聊天记录详情可查)/subtle=气泡底部 🧠N/debug=详情含检索分数与候选 */
  memoryDisplay: 'off' | 'subtle' | 'debug'
  /** 首启向导已完成。老配置升级后该字段缺省 false,但向导只对"零痕迹"用户弹出
   *  (无聊天记录且未填称呼),老用户不会被误打扰 */
  wizardDone: boolean
  /** 角色工具系统:按工具开关与 external 工具的"记住允许"。
   *  键 = 工具注册表 id(src/tools/registry.ts);开关缺省键 = 各工具 defaultEnabled */
  tools: ToolPrefsConfig
  /** AI 剧场(多网页会话即兴):实验开关默认关;甲乙各绑一个网页模型站点
   *  (同站合法——同站点两个会话本就独立,设置页仅提示建议不同模型) */
  aiTheater: AiTheaterConfig
  /** 群聊模型档案(角色可绑独立 API 端点);键须匹配 PROFILE_ID_RE,'main' 保留 */
  modelProfiles: Record<string, ModelProfile>
  /** 档案 Key(明文不落盘:SECRET_FIELDS 改道 'llm:profileKeys',键须同白名单) */
  modelProfileKeys: Record<string, string>
  /** 群聊角色绑定与生成引擎(自由群聊 Actor 系统) */
  groupChatActors: GroupChatActorsConfig
  /** 表达导演(实验):生成前按角色规划"怎么说"(动作/立场/长度/旧梗回收);
   *  灰度默认关,关闭时生成路径与旧版完全一致 */
  expressionV2: boolean
  /** 上下文生命周期(实验):Warm 滚动摘要/集摘要(Pi compaction)+ Mem0 经历记忆
   *  检索注入 + 群聊心情行;灰度默认关,关闭时聊天链路 prompt 与旧版完全一致 */
  contextLifecycle: boolean
  /** 经历记忆(Mem0)的嵌入配置:embedProfile 指向 modelProfiles 的档案(Rust 解析
   *  地址与 Key),embedModel 是嵌入模型名;两者齐全才启用,缺任一整体停用(fail-open) */
  coldMemory: ColdMemoryConfig
}

/** 经历记忆(Mem0)嵌入配置 */
export interface ColdMemoryConfig {
  embedProfile?: string
  embedModel?: string
}

/** AI 剧场配置 */
export interface AiTheaterConfig {
  /** 实验开关:默认关 */
  enabled: boolean
  actorA: WebchatSiteId
  actorB: WebchatSiteId
}

/** 群聊模型档案:每角色可绑定的独立 OpenAI 兼容端点(地址/模型是普通配置;
 *  Key 经 modelProfileKeys 由 SECRET_FIELDS 改道进凭据库 'llm:profileKeys' 一条 map) */
export interface ModelProfile {
  label: string
  baseUrl: string
  model: string
}

/** 档案 id 白名单:Rust 端按对象键读取前同样校验(不拼 JSON Pointer,防路径注入) */
export const PROFILE_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/

/** 群聊角色模型绑定:api 缺省/'main' = 全局主模型;web = 网页站点;disabled 不参与 */
export type GroupModelBinding =
  | { kind: 'api'; profileId?: string }
  | { kind: 'web'; site: WebchatSiteId }
  | { kind: 'disabled' }

export type GroupAutonomy = 'quiet' | 'natural' | 'lively'

export interface GroupActorConfig {
  binding: GroupModelBinding
  autonomy: GroupAutonomy
}

/** 群聊 Actor 配置:engine = 生成引擎(legacy 是保一个版本的旧单飞回退开关)。
 *  迁移默认(控费用):A=主模型+natural、B=主模型+quiet、C=disabled */
export interface GroupChatActorsConfig {
  engine: 'actors' | 'legacy'
  A: GroupActorConfig
  B: GroupActorConfig
  C: GroupActorConfig
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
  /** 打开翻译面板时自动读取剪贴板文字并翻译(关 = 只提示,点「翻译剪贴板」再动手) */
  autoClipboard: boolean
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
  /** 引擎选择:auto=AI 优先本地兜底(默认,含连败熔断);local=仅本地;ai=仅 AI(失败即报错不兜底) */
  engine: 'auto' | 'local' | 'ai'
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
    gptsovits: { url: 'http://127.0.0.1:9880', textLang: 'auto', streamMode: 2, voices: [] },
    assignments: {
      // 女声·轻快 → 便利店店员 / 男声·沉稳 → 程序员 / 女声 → 桌面小管家团宠(C 人设为女,音色性别对齐)
      siliconflow: { A: 'bella', B: 'alex', C: 'anna' },
      minimax: { A: 'female-shaonv', B: 'male-qn-qingse', C: 'female-tianmei' },
      gptsovits: { A: '', B: '', C: '' },
      local: { A: '', B: '', C: '' },
    },
    emotionHints: true,
    asr: { provider: 'siliconflow', model: 'FunAudioLLM/SenseVoiceSmall', apiKey: '' },
    voiceChat: {
      mode: 'off',
      deviceId: '',
      vadSensitivityDb: 12,
      silenceMs: 800,
      autoInterrupt: false,
      interruptExtraDb: 6,
    },
  },
  autoReplayMin: 10,
  characters: {
    height: 320,
    A: { xPct: 20, bottom: 0 },
    B: { xPct: 80, bottom: 0 },
    // C 站在甲乙之间的小型常驻角色:462px 舞台宽时身体约 200px 高
    C: { xPct: 50, bottom: 0, width: 462, enabled: true },
  },
  charactersHidden: false,
  topicOverride: null,
  topicPrefs: {
    defaults: { duration: 'once', distance: 'medium', strict: false },
    sources: { interests: true, characterHistory: true, aiGenerated: false },
    personalPolicy: 'manual-only',
  },
  theme: 'dark',
  choiceChance: 0.3,
  genders: { a: '女', b: '男', c: '女' },
  ctrlBar: { xPct: 50, top: 10, collapsed: false },
  showWatermark: false,
  screenshot: { hotkey: 'Ctrl+Alt+A', enabled: true, hideSelf: true },
  hotkeys: { generate: '', stop: '', replayRandom: '', toggleChars: '', rateUp: '', rateDown: '', rateFav: '', toggleVoice: '', pushToTalk: '' },
  userInterests: '',
  userProfile: { userName: '', occupation: '', likes: '', dislikes: '', banTopics: '' },
  webchatEnabled: false,
  webchatSite: 'deepseek',
  webchatSiteModes: {},
  envSense: true,
  envNoteCooldownMin: 360,
  contextSense: { windowTitle: false, desktopDigest: false },
  breakReminder: { enabled: false, minutes: 45 },
  persona: { a: '', b: '', c: '' },
  personaSource: { a: 'default', b: 'default', c: 'default' },
  names: { a: '甲', b: '乙', c: '丙' },
  memo: { advanceMin: 30 },
  groupChat: { name: '我们的群', bg: false },
  dnd: false,
  dailyLinePack: true,
  proactivity: 'balanced',
  translation: {
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    style: 'natural',
    autoSpeak: false,
    autoClipboard: false,
  },
  ocr: {
    apiKey: '',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6v-flash',
    engine: 'auto',
  },
  live: { platform: 'bilibili', roomId: '', cookie: '', giftReactionsEnabled: true },
  launchOnBoot: false,
  bubbleStyle: 'comic',
  memoryDisplay: 'off',
  wizardDone: false,
  tools: { switches: {}, autoApproved: {} },
  aiTheater: { enabled: false, actorA: 'deepseek', actorB: 'doubao' },
  modelProfiles: {},
  modelProfileKeys: {},
  groupChatActors: {
    engine: 'actors',
    A: { binding: { kind: 'api' }, autonomy: 'natural' },
    B: { binding: { kind: 'api' }, autonomy: 'quiet' },
    C: { binding: { kind: 'disabled' }, autonomy: 'natural' },
  },
  expressionV2: false,
  contextLifecycle: false,
  coldMemory: {},
}

/** 经历记忆嵌入配置清洗:两键都收非空短串,其余丢弃(缺任一键 = 整体停用) */
function sanitizeColdMemory(v: unknown): ColdMemoryConfig {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    ...(typeof o.embedProfile === 'string' && o.embedProfile.trim()
      ? { embedProfile: o.embedProfile.trim().slice(0, 64) }
      : {}),
    ...(typeof o.embedModel === 'string' && o.embedModel.trim()
      ? { embedModel: o.embedModel.trim().slice(0, 120) }
      : {}),
  }
}

/** 角色工具系统偏好 */
export interface ToolPrefsConfig {
  /** 按工具开关;缺省键 = 各工具 defaultEnabled(read 默认开 / external 默认关) */
  switches: Record<string, boolean>
  /** external 工具的"记住允许"(只能由用户在设置页/确认卡写入;模型输出无法触达) */
  autoApproved: Record<string, boolean>
}

/** 话题系统偏好:长期默认值与选题来源策略。演出前的临时调整在话题面板的
 *  本地草稿里,不回写这里——"本次怎么演"与"以后默认怎么选"分层 */
export interface TopicPrefsConfig {
  /** 默认点播方式 */
  defaults: {
    /** 手动话题默认持续时间;once 不建长期会话 */
    duration: 'once' | 'three-episodes' | 'until-cleared'
    /** 默认联想距离(相近/有点意外/天马行空) */
    distance: 'near' | 'medium' | 'far'
    /** 手动输入话题默认严格围绕 */
    strict: boolean
  }
  /** 自动选题来源开关(精选话题是安全兜底,始终启用,不在配置内) */
  sources: {
    /** 使用者兴趣卡进自动候选;同时决定 AI 发现是否上传兴趣词 */
    interests: boolean
    /** 连续剧情通道与角色往事候选;关闭后数据保留,只是不主动使用 */
    characterHistory: boolean
    /** AI 后台扩充候选;关闭=不再调用且旧候选不参与自动选题 */
    aiGenerated: boolean
  }
  /** 个人类话题(健康/失落/关系压力)自动候选策略;sensitive 永远仅手动 */
  personalPolicy: 'manual-only' | 'allow-auto'
}

/** 清洗话题偏好:新形逐字段回落;旧扁平形(duration/distance/aiDiscover)
 *  一次性迁移——strict=false、interests/characterHistory=true、
 *  aiGenerated=aiDiscover、personalPolicy=manual-only */
function sanitizeTopicPrefs(v: unknown): TopicPrefsConfig {
  const raw = (v ?? {}) as Record<string, unknown>
  const legacy = typeof raw.defaults !== 'object' || raw.defaults === null
  const defaultsRaw = (legacy ? raw : (raw.defaults ?? {})) as Record<string, unknown>
  const sourcesRaw = (legacy ? { aiDiscover: raw.aiDiscover } : (raw.sources ?? {})) as Record<string, unknown>
  const duration =
    defaultsRaw.duration === 'three-episodes' || defaultsRaw.duration === 'until-cleared'
      ? defaultsRaw.duration
      : 'once'
  const distance =
    defaultsRaw.distance === 'near' || defaultsRaw.distance === 'far' ? defaultsRaw.distance : 'medium'
  const bool = (x: unknown, dft: boolean): boolean => (typeof x === 'boolean' ? x : dft)
  return {
    defaults: { duration, distance, strict: bool(defaultsRaw.strict, false) },
    sources: {
      interests: bool(sourcesRaw.interests, true),
      characterHistory: bool(sourcesRaw.characterHistory, true),
      aiGenerated: bool(sourcesRaw.aiGenerated ?? sourcesRaw.aiDiscover, false),
    },
    personalPolicy: raw.personalPolicy === 'allow-auto' ? 'allow-auto' : 'manual-only',
  }
}

/** 清洗 AI 剧场配置:站点只认白名单值;同站合法(会话本就独立) */
/** 站点恢复模式覆盖清洗:未知站点/未知模式丢弃;'auto' 等价无覆盖也保留 */
export function sanitizeWebchatSiteModes(v: unknown): Partial<Record<WebchatSiteId, WebchatSiteMode>> {
  if (!v || typeof v !== 'object') return {}
  const out: Partial<Record<WebchatSiteId, WebchatSiteMode>> = {}
  for (const [k, m] of Object.entries(v as Record<string, unknown>)) {
    if (!isWebchatSite(k)) continue
    if (typeof m === 'string' && (WEBCHAT_SITE_MODES as string[]).includes(m)) {
      out[k] = m as WebchatSiteMode
    }
  }
  return out
}

function sanitizeAiTheater(v: unknown): AiTheaterConfig {
  const d = DEFAULT_CONFIG.aiTheater
  const o = (v ?? {}) as Record<string, unknown>
  const site = (x: unknown, dft: WebchatSiteId): WebchatSiteId =>
    isWebchatSite(x) ? x : dft
  return {
    enabled: o.enabled === true,
    actorA: site(o.actorA, d.actorA),
    actorB: site(o.actorB, d.actorB),
  }
}

/** 档案 id 是否可用:匹配 PROFILE_ID_RE 且不占保留字 'main'(= 全局主模型) */
export function isUsableProfileId(id: string): boolean {
  return id !== 'main' && PROFILE_ID_RE.test(id)
}

const MAX_MODEL_PROFILES = 12

/** 清洗模型档案:键走 id 白名单,baseUrl 必须是 http(s),model 必填;非法条目整条拒收。
 *  导出供测试(与 sanitizeCharacters 同款测试出口) */
export function sanitizeModelProfiles(v: unknown): Record<string, ModelProfile> {
  const out: Record<string, ModelProfile> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_MODEL_PROFILES) break
    if (!isUsableProfileId(id)) continue
    const o = (raw ?? {}) as Record<string, unknown>
    const baseUrl = typeof o.baseUrl === 'string' ? o.baseUrl.trim() : ''
    const model = typeof o.model === 'string' ? o.model.trim().slice(0, 120) : ''
    if (!/^https?:\/\//i.test(baseUrl) || !model) continue
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, 40) : model
    out[id] = { label, baseUrl, model }
  }
  return out
}

/** 清洗档案 Key 映射(map 型密钥,整组走 llm:profileKeys 凭据):键同档案白名单。导出供测试 */
export function sanitizeModelProfileKeys(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!isUsableProfileId(id)) continue
    if (typeof raw !== 'string') continue
    out[id] = raw.slice(0, 400)
  }
  return out
}

/** 清洗单角色绑定:api 收敛 profileId('main'/非法 → 缺省=主模型);web 站点白名单;其余 disabled */
function sanitizeGroupActor(v: unknown): GroupActorConfig {
  const o = (v ?? {}) as Record<string, unknown>
  const b = (o.binding ?? {}) as Record<string, unknown>
  let binding: GroupModelBinding
  if (b.kind === 'api') {
    const pid =
      typeof b.profileId === 'string' && isUsableProfileId(b.profileId) ? b.profileId : undefined
    binding = pid ? { kind: 'api', profileId: pid } : { kind: 'api' }
  } else if (b.kind === 'web') {
    binding = { kind: 'web', site: isWebchatSite(b.site) ? b.site : 'deepseek' }
  } else {
    binding = { kind: 'disabled' }
  }
  const autonomy: GroupAutonomy =
    o.autonomy === 'quiet' || o.autonomy === 'lively' ? o.autonomy : 'natural'
  return { binding, autonomy }
}

function sanitizeGroupChatActors(v: unknown): GroupChatActorsConfig {
  const o = (v ?? {}) as Record<string, unknown>
  const d = DEFAULT_CONFIG.groupChatActors
  // 旧配置缺整个条目 → 该角色回迁移默认(而非误算成 disabled)
  const actor = (x: unknown, fallback: GroupActorConfig): GroupActorConfig =>
    x && typeof x === 'object' ? sanitizeGroupActor(x) : structuredClone(fallback)
  return {
    engine: o.engine === 'legacy' ? 'legacy' : 'actors',
    A: actor(o.A, d.A),
    B: actor(o.B, d.B),
    C: actor(o.C, d.C),
  }
}
// 导出供测试(FIELD_SANITIZERS 消费同源)
export { sanitizeGroupChatActors }

/** 清洗工具偏好:只收布尔值,键数封顶(注册表一共个位数工具,32 足够防脏数据膨胀) */
function sanitizeToolPrefs(v: unknown): ToolPrefsConfig {
  const pickBools = (raw: unknown): Record<string, boolean> => {
    const out: Record<string, boolean> = {}
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof val === 'boolean') out[k.slice(0, 40)] = val
        if (Object.keys(out).length >= 32) break
      }
    }
    return out
  }
  const o = (v ?? {}) as Record<string, unknown>
  return { switches: pickBools(o.switches), autoApproved: pickBools(o.autoApproved) }
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
  // GPT-SoVITS 不在启动时注册:音色表是用户配置的,清洗时按当次配置的表校正
  gptsovits: new Set(),
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
    // GPT-SoVITS 的合法音色 = 当次配置的参考音色表,注册名单不适用
    const allowed = provider === 'gptsovits' ? new Set(gptVoices.map((x) => x.id)) : TTS_VOICE_IDS[provider]
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
  const gp = (o.gptsovits ?? {}) as Record<string, unknown>
  // 参考音色表:逐条裁剪,无 id/无路径的丢弃,id 去重,上限 20 条防配置膨胀
  const gptLangs = new Set(['zh', 'en', 'ja', 'ko', 'yue', 'auto'])
  const gptVoices: GptsovitsVoice[] = (() => {
    if (!Array.isArray(gp.voices)) return []
    const out: GptsovitsVoice[] = []
    const seen = new Set<string>()
    for (const raw of gp.voices) {
      const r = (raw ?? {}) as Record<string, unknown>
      const id = str(r.id, 64)
      const path = str(r.refAudioPath, 500)
      if (!id || !path || seen.has(id)) continue
      seen.add(id)
      const lang = str(r.promptLang, 8)
      out.push({
        id,
        name: str(r.name, 50) || id,
        refAudioPath: path,
        promptText: str(r.promptText, 300),
        promptLang: gptLangs.has(lang) ? lang : 'zh',
      })
      if (out.length >= 20) break
    }
    return out
  })()
  const gptTextLang = str(gp.textLang, 8)
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
    gptsovits: {
      url: str(gp.url, 200) || d.gptsovits.url,
      textLang: gptLangs.has(gptTextLang) ? gptTextLang : d.gptsovits.textLang,
      streamMode: gp.streamMode === 1 || gp.streamMode === 3 ? gp.streamMode : 2,
      voices: gptVoices,
    },
    assignments: {
      siliconflow: slot3('siliconflow', rawAssign.siliconflow ?? ('A' in o ? o : undefined)),
      minimax: slot3('minimax', rawAssign.minimax),
      gptsovits: slot3('gptsovits', rawAssign.gptsovits),
      local: slot3('local', rawAssign.local),
    },
    emotionHints: o.emotionHints !== false,
    asr: sanitizeAsr(o.asr),
    voiceChat: sanitizeVoiceChat(o.voiceChat),
  }
}

/** 清洗语音识别配置:模型名截断回默认;密钥走凭据库映射,这里只做占位字段裁剪 */
function sanitizeAsr(v: unknown): AsrConfig {
  const d = DEFAULT_CONFIG.voice.asr
  const o = (v ?? {}) as Record<string, unknown>
  return {
    provider: o.provider === 'local' ? 'local' : 'siliconflow',
    model: (typeof o.model === 'string' ? o.model.trim().slice(0, 120) : '') || d.model,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey.slice(0, 200) : d.apiKey,
  }
}

/** 清洗语音对话配置:模式白名单,数值钳位(迟滞参数越界 = VAD 语义失效,必须收口) */
function sanitizeVoiceChat(v: unknown): VoiceChatConfig {
  const d = DEFAULT_CONFIG.voice.voiceChat
  const o = (v ?? {}) as Record<string, unknown>
  return {
    mode: o.mode === 'ptt' || o.mode === 'hands-free' ? o.mode : 'off',
    deviceId: typeof o.deviceId === 'string' ? o.deviceId.trim().slice(0, 200) : '',
    vadSensitivityDb: clampNum(o.vadSensitivityDb, 6, 24, d.vadSensitivityDb),
    silenceMs: Math.round(clampNum(o.silenceMs, 400, 1500, d.silenceMs)),
    autoInterrupt: o.autoInterrupt === true,
    interruptExtraDb: clampNum(o.interruptExtraDb, 3, 12, d.interruptExtraDb),
  }
}

/** 清洗视频生成配置:provider/时长/比例/分辨率只认白名单;Key 与模型覆盖限量防膨胀。
 *  导出供测试(与 sanitizeCharacters 同惯例) */
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

/** 应用动作的全局快捷键(global-shortcut 格式,如 Ctrl+Alt+G);空串 = 未设置。
 *  默认全空,不抢占任何系统按键;与截屏快捷键(screenshot.hotkey)独立演进 */
export interface HotkeysConfig {
  /** 生成:按分段选择器当前模式点播一段演出(live 模式不响应,防误开播) */
  generate: string
  /** 停止:结束当前演出或下播 */
  stop: string
  /** 随机回放一段历史(收藏加权) */
  replayRandom: string
  /** 隐藏/显示角色 */
  toggleChars: string
  /** 赞最近一集(自然演完的那集;影响话题挑选) */
  rateUp: string
  /** 踩最近一集(影响话题挑选) */
  rateDown: string
  /** 收藏最近一集(不会被清理,重放权重更高) */
  rateFav: string
  /** 开启/关闭语音对话(按下生效) */
  toggleVoice: string
  /** 按键说话:按住说话、松开送识别;角色说话时按下 = 打断(hold 语义,吃 Released) */
  pushToTalk: string
}

/** 清洗应用动作快捷键:逐字段截断,非法值回空串(= 未设置,不生效) */
function sanitizeHotkeys(v: unknown): HotkeysConfig {
  const o = (v ?? {}) as Record<string, unknown>
  const key = (x: unknown): string => (typeof x === 'string' ? x.trim().slice(0, 60) : '')
  return {
    generate: key(o.generate),
    stop: key(o.stop),
    replayRandom: key(o.replayRandom),
    toggleChars: key(o.toggleChars),
    rateUp: key(o.rateUp),
    rateDown: key(o.rateDown),
    rateFav: key(o.rateFav),
    toggleVoice: key(o.toggleVoice),
    pushToTalk: key(o.pushToTalk),
  }
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

/** 清洗群聊设置(导出供配置迁移测试):群名截断回默认,bg 只认布尔(图本体存 group-bg.txt) */
export function sanitizeGroupChat(v: unknown): { name: string; bg: boolean } {
  const o = (v ?? {}) as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 20) : ''
  return { name: name || DEFAULT_CONFIG.groupChat.name, bg: o.bg === true }
}

/** 清洗角色布局:非法/缺字段逐项回退默认并钳位(导出供配置迁移测试)。
 *  老配置缺少 C 时补默认值,A/B 原值完全不动 */
export function sanitizeCharacters(v: unknown): CharactersConfig {
  const d = DEFAULT_CONFIG.characters
  const o = (v ?? {}) as Record<string, Record<string, unknown>>
  const pos = (p: unknown, dft: CharPos): CharPos => {
    const q = (p ?? {}) as Record<string, unknown>
    return {
      xPct: clampNum(q.xPct, 3, 97, dft.xPct),
      bottom: clampNum(q.bottom, 0, 4000, dft.bottom),
    }
  }
  const cq = (o.C ?? {}) as Record<string, unknown>
  return {
    // 上下限放宽:真正的屏幕级钳位在 App 内按实际分辨率做
    height: clampNum(o.height, 140, 2000, d.height),
    A: pos(o.A, d.A),
    B: pos(o.B, d.B),
    C: {
      xPct: clampNum(cq.xPct, 3, 97, d.C.xPct),
      bottom: clampNum(cq.bottom, 0, 4000, d.C.bottom),
      width: clampNum(cq.width, 160, 1200, d.C.width),
      enabled: cq.enabled !== false,
    },
  }
}

/** 清洗锁定的聊天主题:空/非法回 null(从话题池随机) */
function sanitizeTopicOverride(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** 清洗性别纪律:只认'男'/'女',逐槽回落出厂默认 */
function sanitizeGenders(v: unknown): { a: '女' | '男'; b: '女' | '男'; c: '女' | '男' } {
  const g = (v: unknown, dft: '女' | '男'): '女' | '男' => (v === '男' || v === '女' ? v : dft)
  const gd = (v ?? {}) as Record<string, unknown>
  return { a: g(gd.a, '女'), b: g(gd.b, '男'), c: g(gd.c, '女') }
}

/** 清洗环境感知冷却:10 分钟(防刷屏)~ 1440 分钟(一天);非法/缺省回 6 小时(历史行为) */
function sanitizeEnvNoteCooldownMin(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(1440, Math.max(10, Math.round(n))) : 360
}

/** 清洗久坐提醒:时长钳位 15~120 分钟,非法回 45 */
function sanitizeBreakReminder(v: unknown): { enabled: boolean; minutes: number } {
  const b = (v ?? {}) as Record<string, unknown>
  return {
    enabled: b.enabled === true,
    minutes: Math.min(120, Math.max(15, Number(b.minutes) || 45)),
  }
}

/** 清洗上下文感知开关:窗口标题/桌面摘要属敏感档,默认关、只认显式 true(不认"非 false") */
function sanitizeContextSense(v: unknown): AppConfig['contextSense'] {
  const c = (v ?? {}) as Record<string, unknown>
  return { windowTitle: c.windowTitle === true, desktopDigest: c.desktopDigest === true }
}

/** 清洗人设:与设置页 textarea 的 maxLength 一致(8000,容纳酒馆角色卡分区烘焙体量),写超长在这里被截断 */
function sanitizePersona(v: unknown): { a: string; b: string; c: string } {
  const pr = (v ?? {}) as Record<string, unknown>
  const cap = (x: unknown): string => (typeof x === 'string' ? x.trim().slice(0, 8000) : '')
  return { a: cap(pr.a), b: cap(pr.b), c: cap(pr.c) }
}

/** 清洗人设来源:已持久化的结构化来源直接信任(来源是权威事实);
 *  缺失(旧配置)时一次性迁移——空文本→default;与内置默认全文一致(含按当前
 *  名字替换的变体)→default;其他非空→custom */
function sanitizePersonaSource(
  v: unknown,
  all: Record<string, unknown>,
): { a: PersonaSourceSlot; b: PersonaSourceSlot; c: PersonaSourceSlot } {
  const slot = (x: unknown): PersonaSourceSlot | null => (x === 'default' || x === 'custom' ? x : null)
  const o = (v ?? {}) as Record<string, unknown>
  if (slot(o.a) && slot(o.b) && slot(o.c)) {
    return { a: slot(o.a)!, b: slot(o.b)!, c: slot(o.c)! }
  }
  const text = sanitizePersona(all.persona)
  const names = sanitizeNames(all.names)
  // canonical 用模块默认名拼装;named 复刻 defaultPersonaText 的改名替换,识别
  // "还原默认人设"旧按钮存进盘里的那份全文
  const recognize = (t: string, id: ActorSlot): PersonaSourceSlot => {
    if (!t) return 'default'
    const canonical = defaultPersonaText(id)
    if (t === canonical) return 'default'
    const named = canonical.replace(/甲/g, names.a).replace(/乙/g, names.b).replace(/丙/g, names.c)
    return t === named ? 'default' : 'custom'
  }
  return {
    a: recognize(text.a, 'A'),
    b: recognize(text.b, 'B'),
    c: recognize(text.c, 'C'),
  }
}

/** 清洗角色名:截断 12 字,空回落出厂名 */
function sanitizeNames(v: unknown): { a: string; b: string; c: string } {
  const nm = (v ?? {}) as Record<string, unknown>
  const name = (x: unknown, dft: string): string => (typeof x === 'string' ? x.trim().slice(0, 12) : '') || dft
  return { a: name(nm.a, '甲'), b: name(nm.b, '乙'), c: name(nm.c, '丙') }
}

/** 清洗备忘提前量:1~1440 分钟,非法回 30 */
function sanitizeMemo(v: unknown): { advanceMin: number } {
  const mm = (v ?? {}) as Record<string, unknown>
  const v2 = Number(mm.advanceMin)
  return { advanceMin: Number.isFinite(v2) && v2 >= 1 ? Math.min(1440, Math.round(v2)) : 30 }
}

/** 清洗翻译面板:语言代码只放行 auto 与已知语言(手改配置写进奇怪值时回默认) */
function sanitizeTranslation(v: unknown): TranslationConfig {
  const t = (v ?? {}) as Record<string, unknown>
  const code = (x: unknown, dft: string): string => {
    const s = typeof x === 'string' ? x.trim().slice(0, 24) : ''
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
    autoClipboard: t.autoClipboard === true,
  }
}

/** 清洗 AI 识别配置:key 留空 = 关闭 AI 识别;地址/模型清空则回默认,防止拼出打不通的端点 */
function sanitizeOcr(v: unknown): OcrConfig {
  const d = DEFAULT_CONFIG.ocr
  const c = (v ?? {}) as Record<string, unknown>
  const str = (x: unknown, cap: number): string =>
    typeof x === 'string' ? x.trim().slice(0, cap) : ''
  return {
    apiKey: str(c.apiKey, 200),
    baseUrl: str(c.baseUrl, 200) || d.baseUrl,
    model: str(c.model, 100) || d.model,
    engine: c.engine === 'local' || c.engine === 'ai' ? c.engine : 'auto',
  }
}

/** 清洗直播配置:platform 只认白名单值(抖音为桩,v1 恒回 bilibili);
 *  roomId 纯数字校验;cookie 截断防膨胀 */
function sanitizeLive(v: unknown): LiveConfig {
  const c = (v ?? {}) as Record<string, unknown>
  const roomId = typeof c.roomId === 'string' ? c.roomId.trim().slice(0, 32) : ''
  return {
    platform: c.platform === 'douyin' ? 'douyin' : 'bilibili',
    roomId: /^\d*$/.test(roomId) ? roomId : '',
    cookie: typeof c.cookie === 'string' ? c.cookie.trim().slice(0, 600) : '',
    giftReactionsEnabled: c.giftReactionsEnabled !== false,
  }
}

/** 清洗气泡风格:内置白名单 ∪ 气泡工坊自建主题 id;其他值(手改配置写错)回 comic */
function sanitizeBubbleStyle(v: unknown): AppConfig['bubbleStyle'] {
  return v === 'glass' || v === 'comic'
    ? v
    : typeof v === 'string' && /^custom_[a-z0-9_-]{1,32}$/.test(v)
      ? v
      : 'comic'
}

/** 顶层字段清洗器表——schema 校验的单源。sanitizeConfig 全量套表(读路径);
 *  sanitizePartial 只套出现的键(写路径,invoke 前最后一道闸)。新增配置字段
 *  只改 AppConfig 接口 + DEFAULT_CONFIG + 这张表,读写两条路自动一致 */
const FIELD_SANITIZERS: { [K in keyof AppConfig]: (v: unknown, all: Record<string, unknown>) => AppConfig[K] } = {
  apiKey: (v) => String(v || DEFAULT_CONFIG.apiKey),
  apiKeys: sanitizeApiKeys,
  baseUrl: (v) => String(v || DEFAULT_CONFIG.baseUrl),
  model: (v) => String(v || DEFAULT_CONFIG.model),
  userProfile: (v, all) => sanitizeUserProfile(v, typeof all.userInterests === 'string' ? all.userInterests : ''),
  voice: sanitizeVoice,
  autoReplayMin: sanitizeReplayMin,
  characters: sanitizeCharacters,
  charactersHidden: (v) => v === true,
  topicOverride: sanitizeTopicOverride,
  topicPrefs: sanitizeTopicPrefs,
  theme: (v) => (v === 'light' ? 'light' : 'dark'),
  choiceChance: (v) => clampNum(v, 0, 1, DEFAULT_CONFIG.choiceChance),
  genders: sanitizeGenders,
  ctrlBar: sanitizeCtrlBar,
  showWatermark: (v) => v === true,
  screenshot: sanitizeScreenshot,
  hotkeys: sanitizeHotkeys,
  userInterests: (v) => (typeof v === 'string' ? v.trim() : ''),
  webchatEnabled: (v) => v === true,
  webchatSite: (v) => (isWebchatSite(v) ? v : 'deepseek'),
  webchatSiteModes: sanitizeWebchatSiteModes,
  envSense: (v) => v !== false,
  envNoteCooldownMin: sanitizeEnvNoteCooldownMin,
  contextSense: sanitizeContextSense,
  breakReminder: sanitizeBreakReminder,
  persona: sanitizePersona,
  personaSource: sanitizePersonaSource,
  names: sanitizeNames,
  memo: sanitizeMemo,
  groupChat: sanitizeGroupChat,
  dnd: (v) => v === true,
  dailyLinePack: (v) => v !== false,
  proactivity: (v) => (v === 'quiet' || v === 'lively' ? v : 'balanced'),
  translation: sanitizeTranslation,
  ocr: sanitizeOcr,
  live: sanitizeLive,
  launchOnBoot: (v) => v === true,
  wizardDone: (v) => v === true,
  tools: sanitizeToolPrefs,
  aiTheater: sanitizeAiTheater,
  modelProfiles: sanitizeModelProfiles,
  modelProfileKeys: sanitizeModelProfileKeys,
  groupChatActors: sanitizeGroupChatActors,
  expressionV2: (v) => v === true,
  contextLifecycle: (v) => v === true,
  coldMemory: sanitizeColdMemory,
  bubbleStyle: sanitizeBubbleStyle,
  memoryDisplay: (v) => (v === 'subtle' || v === 'debug' ? v : 'off'),
}

/** 从任意 JSON 对象构造合法配置(全量套清洗器表;文件与 localStorage 共用;导出供测试) */
export function sanitizeConfig(obj: unknown): AppConfig {
  const o = (obj ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(FIELD_SANITIZERS) as (keyof AppConfig)[]) {
    out[key] = FIELD_SANITIZERS[key](o[key], o)
  }
  return out as unknown as AppConfig
}

/** 写前校验:只清洗 update 里出现的顶层键,表外键(UNKNOWN 字段)拒绝——
 *  schema 外的数据不落盘。saveConfig 在 invoke('config_set') 前调用,
 *  Rust 侧不复制 schema,这里是落盘前最后一道闸。导出供测试 */
export function sanitizePartial(update: Partial<AppConfig>): Partial<AppConfig> {
  const o = (update ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(o)) {
    if (!(key in FIELD_SANITIZERS)) continue
    out[key] = FIELD_SANITIZERS[key as keyof AppConfig](o[key], o)
  }
  return out as Partial<AppConfig>
}

let cache: Promise<AppConfig> | null = null

// ---------- 密钥通道:配置文件不落明文,敏感值只进系统凭据库 ----------
// 内存快照(AppConfig)里仍是真实值:所有 cfg.apiKey.trim() 判空与设置页回显
// 行为不变;变化只在两处——读取末尾经 resolveSecrets 回填,落盘前经 stripSecrets 剥离。

/** 密钥字段 → SecretId(与 src-tauri/src/secrets.rs 白名单一致);map = 整组 JSON 一条 */
const SECRET_FIELDS: { path: string[]; id: SecretId; map?: boolean }[] = [
  { path: ['apiKey'], id: 'llm:apiKey' },
  { path: ['apiKeys'], id: 'llm:apiKeys', map: true },
  { path: ['voice', 'apiKey'], id: 'tts:voice' },
  { path: ['voice', 'minimax', 'apiKey'], id: 'tts:minimax' },
  { path: ['voice', 'asr', 'apiKey'], id: 'asr:siliconflow' },
  { path: ['ocr', 'apiKey'], id: 'ocr:apiKey' },
  { path: ['live', 'cookie'], id: 'live:cookie' },
  { path: ['modelProfileKeys'], id: 'llm:profileKeys', map: true },
]

function getByPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

function setByPath(obj: unknown, path: string[], value: unknown): void {
  let cur = obj as Record<string, unknown>
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {}
    cur = cur[key] as Record<string, unknown>
  }
  cur[path[path.length - 1]] = value
}

function removeByPath(obj: unknown, path: string[]): void {
  let cur: unknown = obj
  for (let i = 0; i < path.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return
    cur = (cur as Record<string, unknown>)[path[i]]
  }
  if (!cur || typeof cur !== 'object') return
  delete (cur as Record<string, unknown>)[path[path.length - 1]]
}

/** 落盘前剥离全部密钥字段(导出供测试):config.json 与 localStorage 永不存明文 */
export function stripSecrets<T>(obj: T): T {
  const out = structuredClone(obj) as unknown as Record<string, unknown>
  for (const f of SECRET_FIELDS) removeByPath(out, f.path)
  return out as T
}

/** 读取末尾回填:凭据库有条目则覆盖(空串 = 已清除);无条目则保留 sanitize
 *  读到的历史值——迁移失败或浏览器预览下的兜底路径,不因缺条目而丢配置 */
async function resolveSecrets(source: AppConfig): Promise<AppConfig> {
  const cfg = structuredClone(source) as unknown as Record<string, unknown>
  await Promise.all(
    SECRET_FIELDS.map(async (f) => {
      const stored = await readSecret(f.id)
      if (stored === null) return
      if (!f.map) {
        setByPath(cfg, f.path, stored)
        return
      }
      try {
        setByPath(cfg, f.path, JSON.parse(stored))
      } catch {
        /* 凭据内容损坏:保留原值,别把整份配置打挂 */
      }
    }),
  )
  return cfg as unknown as AppConfig
}

export function getConfig(): Promise<AppConfig> {
  if (!cache) {
    cache = (async () => {
      if (!inTauri) {
        // 浏览器预览:localStorage 有则用,否则默认
        try {
          const raw = localStorage.getItem(LS_KEY)
          if (raw) return resolveSecrets(sanitizeConfig(JSON.parse(raw)))
        } catch (e) {
          console.warn('浏览器配置读取失败，使用默认', e)
        }
        return resolveSecrets(DEFAULT_CONFIG)
      }
      try {
        // Rust 统一状态中心:首读单飞加载(明文迁移→版本迁移→凭据库密钥回填),
        // 返回值已含真实密钥;sanitizeConfig 兜底(读路径 schema 校验)并剥掉 version 戳
        return sanitizeConfig(await invoke<unknown>('config_get'))
      } catch (e) {
        // 磁盘抖动等瞬时失败:回退默认且不缓存失败结果,下次 getConfig 重试磁盘
        console.warn('配置读取失败，使用默认', e)
        cache = null
        return DEFAULT_CONFIG
      }
    })()
  }
  return cache
}

/** 保存配置：Rust 侧成功落盘后才返回(失败则磁盘与内存旧值原样保留 = 回滚)。
 *  串行化/密钥写库/原子写/config-changed 广播全部在 Rust 状态中心完成,
 *  两个窗口(乃至任何调用方)并发保存都在同一把进程锁内排队,不会互相覆盖。
 *  update 按顶层键清洗(schema 外字段拒绝);嵌套对象须整节提交(浅合并语义) */
export async function saveConfig(update: Partial<AppConfig>): Promise<AppConfig> {
  if (!inTauri) {
    // 浏览器预览降级:密钥经 localStorage 通道改道,剥离后快照落 localStorage
    await Promise.all(
      SECRET_FIELDS.map(async (f) => {
        const v = getByPath(update, f.path)
        if (v === undefined) return
        await writeSecret(f.id, f.map ? JSON.stringify(v ?? {}) : String(v ?? ''))
      }),
    )
    const next = await withFileLock('config', async () => {
      const current = await getConfig()
      const snapshot = { ...current, ...update }
      localStorage.setItem(LS_KEY, JSON.stringify(stripSecrets(snapshot)))
      return snapshot
    })
    cache = Promise.resolve(next)
    publishConfig(next)
    return next
  }
  // 写前最后一道 schema 闸:顶层键白名单清洗(与读路径同一张 FIELD_SANITIZERS 表)
  const clean = sanitizePartial(update)
  const next = sanitizeConfig(await invoke<unknown>('config_set', { update: clean }))
  cache = Promise.resolve(next)
  publishConfig(next)
  return next
}

if (inTauri) {
  // Rust 状态中心的广播是唯一同步通路(config_set 成功后发给全部窗口,含写者,
  // 幂等采纳):直接采纳载荷并发布,不再弃缓存重读文件——旧实现每条广播
  // 触发 7 次凭据库读取,现在零额外 IO
  void listen<{ config?: unknown }>('config-changed', (e) => {
    if (!e.payload || typeof e.payload !== 'object' || !('config' in e.payload)) return
    const next = sanitizeConfig(e.payload.config)
    cache = Promise.resolve(next)
    publishConfig(next)
  })
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
  // 第三参 getServerSnapshot:快照是模块级缓存值,SSR(renderToStaticMarkup 测试)下同值可用
  return useSyncExternalStore(subscribeConfig, getConfigSnapshot, getConfigSnapshot)
}
