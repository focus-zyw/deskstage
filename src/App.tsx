import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, Suspense, lazy } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen, emitTo } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { invoke } from '@tauri-apps/api/core'
import { CharacterSprite } from './stage/CharacterSprite'
import { Bubble } from './stage/Bubble'
import { startScreenshot, applyScreenshotHotkey } from './capture'
import { applyAppHotkeys, setHotkeyHandler } from './hotkeys'
import { setCharacterGenders, setCharacterNames, setPersonaOverride, setCEnabled, nameOf } from './engine/persona'
import { startEnvPolling } from './engine/envAware'
import {
  balanceVendorOf,
  cachedBalanceLine,
  formatBalanceLine,
  loadBalanceTrack,
  queryVendorBalance,
  rememberBalance,
  saveBalanceTrack,
  updateBalanceTrack,
  type BalanceInfo,
} from './engine/balance'
import {
  setCaptureMode,
  initPointerManager,
  registerHitRegion,
  onHoverChange,
  setPanelsOpen,
} from './input/pointerManager'
// 截屏浮层与翻译面板只在对应会话里出现,直播链(含 pako/B站协议)只在开播时用:
// 三者都按需拉取,不进启动首屏的关键路径
const CaptureOverlay = lazy(() => import('./CaptureOverlay').then((m) => ({ default: m.CaptureOverlay })))
import { SPRITE_SETS, preloadSprites } from './stage/spriteSets'
import { ResidentActor } from './stage/resident/ResidentActor'
import { preloadResident } from './stage/resident/residentManifest'
import type { Speaker } from './performer/player'
import { useAllModes, modeOf, type Mode } from './performer/modes'
import { generateShortChat, memoReminderLine, generateDailyLinePack } from './engine/llmClient'
import { loadLinePacks, saveLinePack, dayKey } from './storage/linePackStore'
import { createChatSession, type SendResult } from './session/ChatSession'
import { pushTurn, type TurnWho } from './dialogue/turnWindow'
import { appendChatTurns, clearChatLog, listChatTurns } from './storage/chatLogStore'
import { createToolCoordinator } from './tools/coordinator'
import { TOOLS } from './tools/registry'
import { createJsonPromptPlanner, defaultPlannerDeps } from './tools/planner/jsonPromptPlanner'
import { beginUtilityTask, type UtilityTaskHandle } from './runtime/utilityTasks'
import { FirstRunWizard } from './wizard/FirstRunWizard'
import { resetDismissals } from './storage/interactionStore'
import { ensureMoodLoaded } from './storage/moodStore'
import { noteActivity } from './runtime/proactiveScheduler'
import { speak } from './engine/tts'
import { topicDirector } from './topic/director'
import { maybeRestockTopicCandidates, cancelDiscovery } from './topic/discovery'
import { topicCatalog, useTopicSnapshot } from './topic'
import { castSnapshotOf } from './engine/persona'
import { parseBanWords } from './topic/planner'
import type { TopicSuggestion } from './topic/types'
import type { TopicCategory, TopicDistance, TopicDuration, TopicIntent } from './topic/types'
type TopicDraft = { duration: TopicDuration; distance: TopicDistance; strict: boolean }
import { getDueMemos, addMemo, updateMemo } from './storage/memoStore'
import { findEpisodeByEid, toggleFavorite, type Episode } from './storage/historyStore'
import { rateEpisode } from './storage/feedbackStore'
import type { TranslationInject } from './translation/TranslationPanel'
import { extractTextFromClipboard } from './translation/ocr'
const TranslationPanel = lazy(() =>
  import('./translation/TranslationPanel').then((m) => ({ default: m.TranslationPanel })),
)
// 直播链(pako/B站弹幕协议/登录)只开播时才需要:按需拉取,模块缓存在此
import type { LiveReply } from './runtime/liveDanmaku'
type LiveModule = typeof import('./runtime/liveDanmaku')
let liveModPromise: Promise<LiveModule> | null = null
const loadLiveModule = (): Promise<LiveModule> => (liveModPromise ??= import('./runtime/liveDanmaku'))
import { CommandPanel } from './ui/CommandPanel'
import { ChoicePanel } from './ui/ChoicePanel'
import {
  applyMention,
  filterMentionTargets,
  mentionContext,
  mentionTargets,
  type MentionTarget,
} from './ui/mention'
import type { Command } from './features/commands/commands'
import {
  useRuntime,
  getCaps,
  getRuntime,
  beginStreaming,
  beginCapture,
  endCapture,
  beginVoice,
  endVoice,
  openOverlayExclusive,
  closeOverlay,
  closeAllOverlays,
  setDnd as setRuntimeDnd,
  setCharHidden as setRuntimeCharHidden,
} from './runtime/runtimeMode'
import { installVoiceSession, getActiveVoiceSession, getVoiceSnapshot, useVoiceSession } from './session/voiceSession'
import { VoiceStatusChip } from './ui/VoiceStatusChip'
import { runUtilityTask, useUtilityTasks, onUtilityTaskLifecycle } from './runtime/utilityTasks'
import { showProp, dismissProps, clearProps } from './runtime/propEffects'
import { preloadProps } from './stage/props'
import { StageProps } from './stage/StageProps'
import { useCharacterLayout } from './stage/useCharacterLayout'
import { usePerformanceDirector } from './runtime/usePerformanceDirector'
import { useActorPresenter } from './stage/useActorPresenter'
import { ControlBar } from './ui/ControlBar'
import { PANEL_ANCHOR, MENU_LEFT_OFFSET } from './ui/dockLayout'
import type { PerformanceState } from './ui/performButton'
import { RatingChip, type RatingAsk } from './ui/RatingChip'
import { UtilityCards } from './ui/UtilityCard'
import {
  DEFAULT_CONFIG,
  getConfig,
  saveConfig,
  useConfigSnapshot,
  WEBCHAT_SITE_IDS,
} from './storage/configStore'
import { useBubbleThemesV2 } from './storage/bubbleThemesStore'
import {
  BUILT_IN_BUBBLE_THEMES,
  BubbleThemeProvider,
  isBuiltinBubbleThemeId,
  resolveGuestLook,
  syncBubbleCompatVars,
} from './bubble'
import { webchatSetSiteMode } from './engine/webchat'
import { applyLaunchOnBoot } from './runtime/launchOnBoot'
import { useOverlayHitRegions } from './runtime/useOverlayHitRegion'
import { initSettingsBridgeServer } from './settings/bridgeServer'
import type { SettingsBridge } from './settings/useSettingsSession'
import type { SettingsTab } from './settings/settingsCatalog'
import type { Rarity } from './features/support/pool'
import { createCharInteractions, packLine } from './interaction/charInteractions'
import './App.css'

/** 右键点播台词池:台词包(每日一换)优先,这里只做兜底 */
const cJokeLines = () => [
  '从前有座山，山里…啊忘了，总之很好笑！',
  '为什么小管家不会累？因为一直在待机呀。',
  '（一本正经）我的笑话保质期只有三秒，笑晚了作废。',
  '桌面上最勤快的是谁？——是鼠标指针。',
]
const cNapLines = () => [
  '（打哈欠）那…就睡五分钟…',
  '（找了个太阳晒到的位置躺下）Zzz…',
  '（小声）帮我盯着点锅…',
]
const cWorkLines = () => [
  `（撸袖子）包在${nameOf('C')}身上！`,
  '（掏出小本本）今日份勤劳，开始！',
  '（认真）桌面卫生，管家尽责！',
]
const cDanceLines = () => [
  '（活动手腕）音乐呢？没有音乐也要跳！',
  '（转圈）看好了，这是管家特训舞！',
  '（抖肩膀）这支舞叫《 今天也元气满满 》！',
]
const cTrickLines = () => [
  '（神秘兮兮）接下来就是见证奇迹的时刻！',
  '（深吸一口气）绝活有风险，观看请鼓掌。',
  '（搓手）这个绝活，一天只演一次！',
  '（叉腰）看好了，全程高能！',
]
/** 翻译完成后的外围互动(正文保持专业,角色只在外面搭腔);20s 冷却防刷屏 */
const TRANSLATE_QUIPS = [
  { a: '翻好了,我这水平能去做同传。', b: '你只是负责点了个发送。' },
  { a: '这段翻得相当地道,夸我。', b: '行吧,反正是模型翻的。' },
  { a: '又帮你看懂一段外文。', b: '嗯,你出手指,它出脑子。' },
]
const TRANSLATE_QUIP_COOLDOWN_MS = 20_000

type Phase = 'idle' | 'generating' | 'performing' | 'choosing'

/** 语气→说话节奏(秒/循环):deadpan 慢半拍、excited 加速、slow 拖沓;与 TTS 语速同向 */
const DELIVERY_TALK_DUR: Record<string, number> = { deadpan: 1.05, excited: 0.38, slow: 0.9 }


// dev 诊断:全局异常自动收集到 window.__errs(桌面窗口 Console 直接查看)
if (import.meta.env.DEV) {
  window.addEventListener('error', (e) => {
    const w = window as any
    ;(w.__errs = w.__errs || []).push(`error: ${e.message ?? e}`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const w = window as any
    ;(w.__errs = w.__errs || []).push(`rejection: ${String(e.reason?.message ?? e.reason)}`)
  })
}

function App() {
  // 统一运行状态:phase/面板开关全部派生自它,写入走 setRuntimeMode/openOverlayExclusive 等
  const rt = useRuntime()
  // 语音会话细分 phase(状态浮标/命令面板标签直接消费;事实源在 voiceSession)
  const voicePhase = useVoiceSession().phase
  const [hovered, setHovered] = useState<string | null>(null)
  const phase: Phase =
    rt.mode.type === 'generating'
      ? 'generating'
      : rt.mode.type === 'choosing'
        ? 'choosing'
        : rt.mode.type === 'performing' || rt.mode.type === 'streaming'
          ? 'performing'
          : 'idle'
  // 模式菜单当前选中模式；主按钮按它点播
  const [mode, setMode] = useState<Mode>('daily')
  // 内置+自定义模式(模式工坊增删时重渲染,命令注册表随之更新)
  const allModeList = useAllModes()
  // 当前选中的自定义模式被删除时回落日常,避免模式菜单失去选中项
  useEffect(() => {
    if (!allModeList.some((m) => m.id === mode)) setMode('daily')
  }, [allModeList, mode])
  // Dock 主按钮语义态:由 RuntimeMode + 当前模式显式推导(映射表见 ui/performButton.ts)
  const performanceState: PerformanceState =
    rt.mode.type === 'idle'
      ? mode === 'live'
        ? 'idle-live'
        : 'idle'
      : rt.mode.type === 'generating'
        ? 'generating'
        : rt.mode.type === 'performing'
          ? 'performing'
          : rt.mode.type === 'choosing'
            ? 'choosing'
            : rt.mode.type === 'streaming'
              ? 'streaming'
              : 'locked'
  // 模式菜单(dock 下拉):开态进 overlays 栈,享受互斥/Esc/点外部收起
  const modeMenuOpen = rt.overlays.includes('mode-menu')
  const modeMenuRef = useRef<HTMLDivElement>(null)
  function toggleModeMenu() {
    if (modeMenuOpen) closeOverlay('mode-menu')
    else openOverlayExclusive('mode-menu')
  }
  // 角色右键菜单(C 团宠互动 + A/B 工具互动):轻交互浮层(mode-menu 同机制,不激活窗口)。
  // 声明在组件顶部:hit region 注册表(useOverlayHitRegions)要读 cMenuOpen/cMenuRef
  const cMenuOpen = rt.overlays.includes('c-menu')
  const [cMenuFor, setCMenuFor] = useState<'A' | 'B' | 'C'>('C')
  const cMenuPos = useRef({ x: 0, y: 0 })
  const cMenuRef = useRef<HTMLDivElement>(null)
  function openCMenu(who: 'A' | 'B' | 'C', x: number, y: number) {
    // 限位:176 宽菜单贴边不裁切
    cMenuPos.current = {
      x: Math.max(8, Math.min(window.innerWidth - 184, x)),
      y: Math.max(8, Math.min(window.innerHeight - 260, y)),
    }
    setCMenuFor(who)
    openOverlayExclusive('c-menu')
  }
  /** 菜单项动作:演出/生成期间只应一句,不动演出;空闲时执行 */
  function runCMenuAction(who: 'A' | 'B' | 'C', run: () => void) {
    if (phaseRef.current !== 'idle' || director.isPlaying()) {
      showPoke(who, '（摆手）等这集演完再来点我~', 'talk', 1800)
      return
    }
    noteUserActive() // 点播也是主动互动:重置空闲/降频计时
    run()
  }
  const cMenuActions: { id: string; label: string; run: () => void }[] = [
    {
      id: 'joke',
      label: '😆 讲个笑话',
      run: () => showPoke('C', packLine('joke', cJokeLines()), 'happy', 3600),
    },
    {
      id: 'nap',
      label: '😴 睡午觉',
      run: () => showPoke('C', packLine('nap', cNapLines()), 'nap', 3600),
    },
    {
      id: 'work',
      label: '🧹 干点活',
      run: () => showPoke('C', packLine('work', cWorkLines()), 'working', 8000),
    },
    {
      id: 'dance',
      label: '💃 跳个舞',
      run: () => showPoke('C', packLine('dance', cDanceLines()), 'dance', 6000),
    },
    {
      id: 'trick',
      label: '🎪 来个绝活',
      run: () => showPoke('C', packLine('trick', cTrickLines()), 'trick', 8000),
    },
    {
      id: 'feed',
      label: '🍪 投喂零食',
      run: feedC,
    },
  ]
  /** A/B 右键菜单:工具型互动(与 C 的陪玩互动分开) */
  function abMenuActions(who: 'A' | 'B'): { id: string; label: string; run: () => void }[] {
    return [{ id: 'balance', label: '💰 查询余额', run: () => void runBalanceQuery(who) }]
  }
  /** 右键「查询余额」:DeepSeek/Kimi 公开余额接口 + 当日差值记账,角色口吻播报。
   *  引导/失败都先角色开口;查询本体走 UtilityCard(后台处理中的载体) */
  async function runBalanceQuery(who: 'A' | 'B') {
    const cfg = await getConfig()
    if (!cfg.apiKey.trim()) {
      showPoke(who, '还没填 API Key,先到 设置 → 模型服务 里填上~', 'surprise', 3200)
      return
    }
    if (!balanceVendorOf(cfg.baseUrl)) {
      showPoke(who, '这家供应商没有公开的余额接口,查不了~', 'talk', 3000)
      return
    }
    const cached = cachedBalanceLine()
    if (cached) {
      showPoke(who, cached, 'happy', 4200)
      return
    }
    presenterSay(who, '我查查余额哈…', { ms: 2200 })
    await runUtilityTask('tool', '查询余额', who, async (report) => {
      report('连接中…')
      let info: BalanceInfo
      try {
        info = await queryVendorBalance(cfg.baseUrl, cfg.apiKey)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        showPoke(who, `查询失败:${msg}`, 'surprise', 3600)
        return `查询失败:${msg}`
      }
      const { todayUsage, note, track } = updateBalanceTrack(loadBalanceTrack(), { total: info.total })
      saveBalanceTrack(track)
      const line = formatBalanceLine(info, todayUsage, note)
      rememberBalance(info, line)
      showPoke(who, line, 'happy', 4200)
      return line
    })
  }
  // 设置窗:独立 WebView(tauri.conf 预建 label=settings,启动隐藏),主窗只管 show/hide
  // 与开关态同步;窗内表单、保存、Esc/关闭按钮都由设置窗自理(经 settings 事件桥回报)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 配置事实源:读同一份已落盘配置(任何 saveConfig 成功后即时发布),不再各自维护镜像
  const config = useConfigSnapshot()
  const charNames = { A: config.names.a, B: config.names.b, C: config.names.c }
  const showWatermark = config.showWatermark
  // 气泡主题 V2 统一链路:内置 comic/glass 从引擎目录取不可变 V2 数据,自定义主题
  // 读取时经 normalize(旧 V1 主题就地迁移);经 Provider 下发,气泡组件在自身节点上 resolve。
  // 选中的自定义主题不存在(被删)时回落柔彩;根节点只同步群聊/头像消费的兼容变量。
  const bubbleThemes = useBubbleThemesV2()
  const bubbleTheme = useMemo(() => {
    if (isBuiltinBubbleThemeId(config.bubbleStyle)) return BUILT_IN_BUBBLE_THEMES[config.bubbleStyle]
    return bubbleThemes.find((t) => t.id === config.bubbleStyle) ?? null
  }, [config.bubbleStyle, bubbleThemes])
  useEffect(() => {
    syncBubbleCompatVars(document.documentElement, bubbleTheme)
  }, [bubbleTheme])
  // C 画外音横幅固定走 caption 语义(低干扰半透明条),但取色来自当前主题
  const guestLook = useMemo(
    () => resolveGuestLook(bubbleTheme ?? BUILT_IN_BUBBLE_THEMES.comic),
    [bubbleTheme],
  )
  // 聊天通道:输入框开合/草稿/应答中;用户气泡(区别于角色气泡)
  const chatOpen = rt.overlays.includes('chat')
  const [chatDraft, setChatDraft] = useState('')
  const [userBubble, setUserBubble] = useState<string | null>(null)
  // @ 补全(QQ/微信式):输入 @ 唤起候选,随已输文本过滤;面板打开时接管回车/方向键/Esc
  const [mention, setMention] = useState<{ query: string } | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const chatInputRef = useRef<HTMLInputElement>(null)
  const mentionCandidates = useMemo(
    () => mentionTargets({ A: config.names.a, B: config.names.b, C: config.names.c }),
    [config.names.a, config.names.b, config.names.c],
  )
  const mentionMatches = useMemo(
    () => filterMentionTargets(mentionCandidates, mention?.query ?? ''),
    [mentionCandidates, mention],
  )
  // 关闭聊天面板时补全面板一并收起(草稿保留是原有行为)
  useEffect(() => {
    if (!chatOpen) setMention(null)
  }, [chatOpen])
  // 翻译面板:开合由 runtime overlays 管;OCR 链路注入的原文(auto=截图翻译入口,填入即自动翻)
  const translationOpen = rt.overlays.includes('translation')
  const toolsOpen = rt.overlays.includes('tools')
  const overlaysOpen = rt.overlays.length > 0
  // 模式菜单没有输入框，仍由原生钩子派发点击；只有真正的输入面板才让
  // 全屏 WebView 恢复交互，否则展开小菜单也会让底层视频退出硬件合成。
  // C 右键菜单同理(轻交互按钮列表)。
  const interactivePanelsOpen = rt.overlays.some((overlay) => overlay !== 'mode-menu' && overlay !== 'c-menu')
  useEffect(() => {
    setPanelsOpen(interactivePanelsOpen)
  }, [interactivePanelsOpen])
  const [trInject, setTrInject] = useState<TranslationInject | null>(null)
  const trPanelRef = useRef<HTMLDivElement>(null)
  const trQuipAt = useRef(0)
  // 最近打开的面板由 runtime overlays 栈决定(escapeTarget),不再单独记 ref
  // 话题面板:读模型快照(useTopicSnapshot)+ 面板本地态(搜索词/严格围绕/推荐分类)
  const topicOpen = rt.overlays.includes('topic')
  const [topicQuery, setTopicQuery] = useState('')
  // 面板本地草稿:本次点播的持续/联想/严格,打开面板时从长期默认值初始化一次;
  // 打开期间跨窗配置广播不覆盖草稿(只影响下次打开),点播也不回写全局默认
  const [topicDraft, setTopicDraft] = useState<TopicDraft>(() => ({
    duration: 'once',
    distance: 'medium',
    strict: false,
  }))
  const [suggestCat, setSuggestCat] = useState<TopicCategory | null>(null)
  // 推荐批次种子:打开面板时归零,期间保持稳定;「换一批」/点播后 +1 刷新
  const [suggestSeed, setSuggestSeed] = useState(0)
  useEffect(() => {
    if (!topicOpen) return
    setSuggestSeed(0)
    // 仅"关闭→打开"这一次从已提交默认值初始化;打开期间广播不覆盖草稿
    const d = config.topicPrefs.defaults
    setTopicDraft({ duration: d.duration, distance: d.distance, strict: d.strict })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicOpen])
  // 空闲自动重放:频率来自配置,activeTick 用于用户互动后重置计时
  const [activeTick, setActiveTick] = useState(0)
  /** 用户主动互动:重置空闲/自动重放计时 + 清降频连击(还在陪玩的观众不该被降频) */
  function noteUserActive() {
    setActiveTick((t) => t + 1)
    noteActivity()
    void resetDismissals()
  }
  const charHidden = rt.charHidden
  // C 的启用开关独立于全局隐藏:enabled=false 时 C 完全退场(台词回落画外音横幅)
  const cEnabled = config.characters.C.enabled
  // 备忘提醒卡容器:热区 getter 用;声明在使用(useMemo 依赖)之前,避免 TDZ
  const memoAlertsRef = useRef<HTMLDivElement>(null)
  const memoAlertsCountRef = useRef(0)
  // 完播评价:最近自然演完的一集(eid 主键)。ask 驱动评价条浮现;ref 供全局快捷键
  // 随时引用——勿扰/超时收起只压"弹条",不丢"可评的集"
  const [ratingAsk, setRatingAsk] = useState<RatingAsk | null>(null)
  const ratingAskRef = useRef<RatingAsk | null>(null)
  const dismissRating = useCallback(() => setRatingAsk(null), [])
  const topicPanelRef = useRef<HTMLDivElement>(null)
  const chatBoxRef = useRef<HTMLDivElement>(null)
  const cmdPanelRef = useRef<HTMLDivElement>(null)
  const choicePanelRef = useRef<HTMLDivElement>(null)
  // C 的身体命中框:原生热区按它取矩形(而非整个视频矩形,透明区域不能拦截桌面点击)
  const residentHitBox = useRef<HTMLDivElement>(null)

  // phase 的 ref 镜像:异步回调(LLM 返回)里判断此刻是否仍空闲
  const phaseRef = useRef(phase)
  // mode 的 ref 镜像:全局快捷键(生成)读按键瞬间选中的分段,不依赖重渲染时机
  const modeRef = useRef(mode)

  // 角色舞台布局:拖动/缩放/落盘/距离演出(呈现与戳一戳回调注入)
  const {
    charCfg, charCfgRef, ctrlBar, topActor, setTopActor, dragUi, dropFor,
    charA, charB, draggingWho, applyChars, applyCtrlBar, resetLayout,
    onCharPointerDown, onCharPointerMove, onCharPointerUp, onCharWheel, onResidentWheel,
  } = useCharacterLayout({
    isIdle: () => phaseRef.current === 'idle',
    present: showPoke,
    onPoke: poke,
    onLongPress: (who) => {
      // 摸头长按目前只给团宠;甲乙长按回落戳一戳——长按后松手不再走 onPoke,
      // 若这里也不响应,慢速点按(>600ms)就会两头落空
      if (who === 'C') headpatC()
      else poke(who)
    },
  })

  // 角色呈现器:气泡/动作/说话态的唯一归属(演出回调、插话、聊天、直播统一走它)
  const {
    bubble, action, delivery, speaking, pulseFor, reacting, loudBubble,
    showTalk, hush, endLine, pulse, settle, setPose, reset: resetStage, memBadge,
    say: presenterSay,
  } = useActorPresenter()

  // 演出导演:生成/回放/选边/停止/主动行为演出的唯一归属(逐句呈现委托给呈现器)
  const director = usePerformanceDirector({
    presenter: { say: presenterSay, showTalk, hush, endLine, settle, reset: resetStage, setPose },
    isIdle: () => phaseRef.current === 'idle',
    onLive: () => startStreaming(),
    teardown: () => {
      liveStopRef.current?.()
      void loadLiveModule().then((m) => m.stopLiveSession())
      clearProps()
      setUserBubble(null)
    },
    sweepMemos: () => sweepMemos(),
    onEpisodeEnd: (info) => {
      ratingAskRef.current = info // 快捷键随时可评最近一集;勿扰只压弹条,不丢可评的集
      if (!getRuntime().dnd) setRatingAsk(info)
    },
  })
  const { choice } = director

  // 话题系统启动:预热 topic-state 快照 + 旧 config.topicOverride 幂等迁移(一次性);
  // 两分钟后视池量决定是否后台补货(AI 发现默认关,纪律全在 discovery 内)
  useEffect(() => {
    void topicDirector.init()
    const restockTimer = window.setTimeout(() => void maybeRestockTopicCandidates(), 120_000)
    return () => window.clearTimeout(restockTimer)
  }, [])
  // 话题读模型快照:面板渲染专用(纯查询,不耗随机数/不建预约)
  const topicSnap = useTopicSnapshot()

  // ---- 话题目录查询(纯查询,不耗随机数;同 seed 同结果) ----
  const cast = useMemo(() => castSnapshotOf(config), [config])
  const banWords = useMemo(() => parseBanWords(config.userProfile.banTopics), [config.userProfile.banTopics])
  const recentFps = useMemo(() => topicSnap.recent.map((r) => r.fingerprint), [topicSnap.recent])
  const topicQueryCtx = useMemo(
    () => ({ mode: modeOf(mode), cast, banWords, excludeFingerprints: recentFps }),
    [mode, cast, banWords, recentFps],
  )
  // 分类按钮由目录 facets 动态生成:空分类自动隐藏,计数与实际可选同源
  const topicFacets = useMemo(() => topicCatalog.query({ ...topicQueryCtx, limit: 0 }).facets, [topicQueryCtx])
  // 推荐列表:排除最近 20 个话题,优先当前模式与角色;打开期间 seed 稳定
  const suggestions = useMemo(
    () =>
      suggestCat
        ? topicCatalog.query({ ...topicQueryCtx, category: suggestCat, seed: suggestSeed, limit: 4 }).items
        : [],
    [topicQueryCtx, suggestCat, suggestSeed],
  )
  // 搜索:标题/标签/场景预告/角色动力学多字段匹配
  const searchHits = useMemo<TopicSuggestion[]>(
    () => (topicQuery.trim() ? topicCatalog.query({ ...topicQueryCtx, text: topicQuery, limit: 8 }).items : []),
    [topicQueryCtx, topicQuery],
  )

  /** 话题面板的行动按钮:四类动作直接触发下一集演出 */
  function playTopicAction(intent: TopicIntent, distance?: TopicDistance) {
    closeOverlay('topic')
    director.play(mode, distance ? { intent, distance } : { intent })
  }

  /** 显式评价提交(评价条/快捷键共用):落盘 feedback.json + 话题事件(唯一写入口) */
  function submitRating(info: RatingAsk, rating: 'up' | 'down') {
    if (ratingAskRef.current?.eid === info.eid) setRatingAsk(null)
    void rateEpisode(info.eid, { ts: Date.now(), mode: info.mode, topic: info.topic }, rating).catch(() => {})
    void topicDirector.record({ type: 'rating-changed', eid: info.eid, value: rating })
  }

  /** 收藏刚完播的这集:按 eid 找回整集,走与历史页 ★ 同一条收藏通道 */
  function favoriteCurrentEpisode(info: RatingAsk) {
    void (async () => {
      const ep = await findEpisodeByEid(info.eid)
      if (!ep) return
      const nowFav = await toggleFavorite(ep)
      if (nowFav) {
        await topicDirector.record({ type: 'favorite-changed', eid: ep.eid ?? info.eid, favored: true })
      }
    })().catch(() => {})
  }

  /** 插话呈现(气泡+动作+到期回收):戳一戳/引导语/报错的统一入口 */
  function showPoke(who: Speaker, line: string, action: string, ms = 1600, loud = false) {
    presenterSay(who, line, { action, ms, loud, reacting: true })
  }

  /** 漫游步进回调:读布局 ref 的最新值合并——闭包旧值会拿老 A/B 位置整体覆盖 */
  function moveResident(xPct: number) {
    const cur = charCfgRef.current
    applyChars({ ...cur, C: { ...cur.C, xPct } }, 'debounced')
  }

  // phase 的 ref 镜像:异步回调(LLM 返回)里判断此刻是否仍空闲
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  // 新演出开始(生成/播放/选边):撤下未作答的评价条——演出优先,错过可在历史页补评
  useEffect(() => {
    if (phase !== 'idle') setRatingAsk(null)
  }, [phase])

  // C 围观工具任务:任务运行期间进工作姿势,结束(成败都)还原
  useEffect(() => {
    return onUtilityTaskLifecycle(({ phase: p }) => {
      setPose('C', p === 'start' ? 'working' : 'idle')
    })
    // setPose 只依赖稳定的 setState,首帧闭包行为恒定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // mode 的 ref 镜像同步
  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  // 全局快捷键动作:向 hotkeys 模块登记处理器。每次渲染重登记(Map.set 幂等),
  // 让处理器永远持有最新闭包(director.play 会读当轮 deps,如手动锁定的主题);
  // 守卫本身读 getCaps()/getRuntime() 的按键瞬间状态,不依赖渲染时机
  useEffect(() => {
    setHotkeyHandler('generate', () => {
      const m = modeRef.current
      // live 模式不响应生成键:全局快捷键无差别触发,误开播比不响应更糟
      if (m === 'live') return
      if (!getCaps().canStartPerformance) return
      performNow(m)
    })
    setHotkeyHandler('stop', () => {
      if (!getCaps().idle) director.stop()
    })
    setHotkeyHandler('replayRandom', () => {
      const caps = getCaps()
      if (!caps.canStartPerformance || !caps.proactiveAllowed) return
      void director.autoReplay()
    })
    setHotkeyHandler('toggleChars', () => {
      setCharsHidden(!getRuntime().charHidden)
    })
    // 完播评价三动作:对"最近自然演完的一集"生效;还没有可评的集时静默(与 generate 同口径)
    setHotkeyHandler('rateUp', () => {
      const info = ratingAskRef.current
      if (info) submitRating(info, 'up')
    })
    setHotkeyHandler('rateDown', () => {
      const info = ratingAskRef.current
      if (info) submitRating(info, 'down')
    })
    setHotkeyHandler('rateFav', () => {
      const info = ratingAskRef.current
      if (info) favoriteCurrentEpisode(info)
    })
    // 语音对话:toggle 开/关会话;pushToTalk 是 hold 动作(按住收音、松开送识别、
    // 角色说话时按下 = 打断)。pttDown/pttUp 均幂等,自动重复/丢 Released 无害
    setHotkeyHandler('toggleVoice', () => toggleVoiceSession())
    setHotkeyHandler('pushToTalk', (s) => {
      const vs = getActiveVoiceSession()
      if (!vs) return
      if (s === 'down') vs.pttDown()
      else if (s === 'up') vs.pttUp()
    })
  })

  // 截屏流程:capture-start 进入框选模式(主窗恢复交互,CaptureOverlay 铺满冻结图),
  // 失败反馈(capture.ts 内部 catch 后 emit 过来)走气泡
  const [captureShot, setCaptureShot] = useState<string | null>(null)
  useEffect(() => {
    const start = listen('capture-start', ({ payload }) => {
      setCaptureMode(true)
      // 框选是临时态:记住底下正在做的事(演出继续播),结束后恢复;
      // 动作(保存/识字/翻译/复制)由松手后的工具条决定
      beginCapture()
      setCaptureShot(String(payload))
    })
    const fail = listen('capture-error', ({ payload }) => {
      endCapture() // 冻结屏没拿到也恢复底下状态
      presenterSay('A', `截图失败:${String(payload).slice(0, 50)}`, { ms: 5000 })
    })
    // 应用动作快捷键注册失败(组合键被其他程序占用等):气泡告知,不然用户按了没反应无从排查
    const hotkeyErr = listen<{ action: string; shortcut: string }>('hotkey-error', ({ payload }) => {
      presenterSay('A', `快捷键 ${payload.shortcut} 没绑上,可能被其他程序占用了`, { ms: 5000 })
    })
    return () => {
      void start.then((f) => f())
      void fail.then((f) => f())
      void hotkeyErr.then((f) => f())
    }
    // 挂载一次的全局监听;回调里只依赖模块函数与呈现器稳定闭包
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- 翻译:OCR 链路对接与外围互动 ----------

  // ---------- 道具桥:任务/翻译状态 → 角色旁工具卡片道具 ----------
  // 单一 seam:订阅 utilityTasks 与翻译面板 onState,统一映射为 'utility' 单槽道具;
  // 不在各 runUtilityTask 调用点散布 showProp。截图翻译的任务 done 只代表 OCR 完成,
  // 翻译阶段由面板 onState 接力(running=翻译卡),真正完成才上 success。
  const utilityTasks = useUtilityTasks()
  const utilCardsRef = useRef<HTMLDivElement>(null)
  const utilCardsCountRef = useRef(0)
  utilCardsCountRef.current = utilityTasks.length
  const utilPropSeen = useRef(new Map<string, string>())
  useEffect(() => {
    for (const t of utilityTasks) {
      if (utilPropSeen.current.get(t.id) === t.status) continue
      utilPropSeen.current.set(t.id, t.status)
      if (t.kind === 'capture-translate' && t.status === 'done') continue // 翻译还在跑,接力给面板
      if (t.kind === 'live') continue // 直播是常驻状态卡,不挂道具
      if (t.actor === 'C') continue // 工具系统指派 C 时她只有工作姿势(props 桥只认 A/B)
      const prop = t.status === 'running' ? 'magnifier' : t.status === 'error' ? 'question' : 'success'
      showProp(t.actor, prop, { key: 'utility', durationMs: t.status === 'running' ? 0 : undefined })
    }
  }, [utilityTasks])

  /** 翻译面板状态 → 工具卡道具:running=翻译卡(常驻),done=success,error=question,取消=idle 撤卡 */
  function onTranslateState(s: 'running' | 'done' | 'error' | 'idle') {
    if (s === 'idle') {
      dismissProps('utility')
      return
    }
    const prop = s === 'running' ? 'translation-card' : s === 'error' ? 'question' : 'success'
    showProp('A', prop, { key: 'utility', durationMs: s === 'running' ? 0 : undefined })
  }

  /** 剪贴板图片 OCR → 填入翻译面板(工具循环:进度与结果走右上浮层卡,角色气泡不再播报)。
   *  AI 视觉模型优先、本地 OCR 兜底(链路在 translation/ocr.ts)。
   *  auto=true(截图翻译入口)时面板填入后立即翻译;命令/按钮入口只填入,让用户先看/改识别结果 */
  function startOcrIntoTranslation(auto: boolean) {
    void runUtilityTask(auto ? 'capture-translate' : 'ocr', auto ? '截图翻译' : '提取文字', 'A', async (report) => {
      const r = await extractTextFromClipboard(report)
      openOverlayExclusive('translation')
      setTrInject({ text: r.lines.join('\n'), nonce: Date.now(), auto })
      const via = r.via === 'api' ? '(AI)' : '(本地)'
      return auto
        ? `已识别 ${r.lines.length} 行${via},翻译面板处理中`
        : `已识别 ${r.lines.length} 行${via},已填入翻译面板`
    })
  }

  /** 启动框选(快捷键/命令面板/翻译面板共用):松手后出工具条,动作由用户在工具条上选 */
  function startScreenshotFlow() {
    startScreenshot().catch((e) => {
      presenterSay('A', `截图失败:${String((e as Error)?.message ?? e).slice(0, 50)}`, { ms: 2400 })
    })
  }

  /** 勿扰:TTS 全静 + 调度器停发主动行为(备忘卡片照弹);立即落盘 */
  function toggleDnd() {
    const next = !rt.dnd
    setRuntimeDnd(next)
    saveConfig({ dnd: next }).catch((e) => console.warn('勿扰保存失败(静默)', e))
    showPoke(next ? 'B' : 'A', next ? '知道了,我们安静待着' : '欢迎回来~', 'talk', 2000)
  }

  /** 命令面板:点播一段演出。话题一次性传入(不落盘,不永久锁定聊天主题) */
  function performNow(m: Mode, topic?: string) {
    setMode(m)
    void director.play(m, topic)
  }

  /** 旁听惊讶脉冲:挑一个非说话者的角色做反应(三人场景取固定顺序的第一个) */
  function pulseOther(speaker: Speaker) {
    const other = (['A', 'B', 'C'] as const).find((id) => id !== speaker)
    if (other) pulse(other)
  }

  // ---------- 主播模式:直播弹幕互动 ----------

  /** 弹幕回复呈现:复用聊天通道的气泡+动作+TTS 节奏(stream 通道) */
  function presentLiveReply(r: LiveReply) {
    setTopActor(r.speaker) // 呈现者置顶:气泡与道具不被另一角色压住
    presenterSay(r.speaker, r.text, { action: r.action || 'talk', ms: 2200 + r.text.length * 160, speaking: true })
    pulseOther(r.speaker)
    speak(r.speaker, r.text, undefined, 'stream')
  }

  /** 下播句柄:导演 stop() 时结束会话并让直播任务卡落定 */
  const liveStopRef = useRef<(() => void) | null>(null)

  /** 开播:前置校验(直播间号/平台)→ 清场 → streaming 态 → 连接弹幕源 + 启动管线。
   *  API Key 不再拦截:礼物互动完全免 AI,无 Key 照常收礼物;只有弹幕 AI 回复不可用 */
  function startStreaming() {
    void (async () => {
      try {
        const cfg = await getConfig()
        const hasApiKey = Boolean(cfg.apiKey.trim())
        if (!cfg.live.roomId.trim()) {
          presenterSay('A', '先到 设置 → 直播设置 里填直播间号~', { action: 'surprise', ms: 3200 })
          return
        }
        if (cfg.live.platform === 'douyin') {
          presenterSay('A', '抖音弹幕还在路上,先用B站吧~', { ms: 3000 })
          return
        }

        // 进入即提示:开播流程已启动(此前失败全程静默,无法定位卡点)
        presenterSay('A', '正在连接直播间…', { ms: 2500 })

        // 清场(与点播同段):中止生成/演出/语音
        director.abortPending()

        beginStreaming()
      // 无 Key 提示一句:礼物互动照常,弹幕 AI 回复不可用(管线侧同步静默禁用)
      if (!hasApiKey) {
        showPoke('A', '还没填 API Key,读弹幕回复先关掉,礼物互动照常~', 'talk', 3200)
      }
      // 连接状态走常驻任务卡(exec 挂起到下播才落定,done 卡 6s 后自动消失)
      void runUtilityTask('live', '直播', 'A', (report) => {
        return new Promise<string>((resolve) => {
          liveStopRef.current = () => {
            liveStopRef.current = null
            resolve('直播已结束')
          }
          void loadLiveModule().then(({ startLiveSession }) =>
            startLiveSession(cfg.live.platform, cfg.live.roomId, {
              onReply: presentLiveReply,
              onStatus: (s) => {
                report(
                  s.state === 'live'
                    ? '已连接,读弹幕中'
                    : s.state === 'connecting'
                      ? `连接中${s.detail ? `(${s.detail})` : ''}`
                      : s.state === 'error'
                        ? `异常:${s.detail ?? ''}(自动重连)`
                        : (s.detail ?? s.state),
                )
              },
            }),
          )
        })
      })
      } catch (e) {
        // 开播任何一步失败都在气泡里可见,不再静默
        presenterSay('A', `开播失败:${String((e as Error)?.message ?? e).slice(0, 60)}`, { action: 'surprise', ms: 5000 })
      }
    })()
  }

  /** 命令面板:跳到备忘页手填(时间没解析出来时的兜底入口) */
  function openMemoSettings() {
    openSettings('memo')
  }

  /** 命令注册表:新工具 = 注册一条,工具栏不再加按钮 */
  const commands: Command[] = [
    { id: 'clipboard-translate', label: '把剪贴板图片翻译出来(先截屏)', keywords: ['剪贴板'], run: () => startOcrIntoTranslation(true) },
    { id: 'translate', label: '翻译文字(打开翻译面板)', keywords: ['翻译', 'translate'], run: () => openOverlayExclusive('translation') },
    { id: 'ocr', label: '提取文字(剪贴板图片,AI 识别+本地兜底)', keywords: ['提取', '识别', 'ocr'], run: () => startOcrIntoTranslation(false) },
    { id: 'screenshot', label: '截屏(框选→保存/识字/翻译)', keywords: ['截屏', '截图', '截图翻译', '截屏翻译'], run: startScreenshotFlow },
    { id: 'memo', label: '添加提醒(打开备忘页)', keywords: ['备忘页'], run: openMemoSettings },
    { id: 'chatlog', label: '翻聊天记录(打开设置页)', keywords: ['聊天记录', '聊天', '对话回放', '记录'], run: () => openSettings('chatlog') },
    { id: 'topic', label: '选择演出话题', keywords: ['话题', '演出话题', '主题'], run: () => openOverlayExclusive('topic') },
    { id: 'toggle-chars', label: charHidden ? '显示角色' : '隐藏角色', keywords: ['隐藏角色', '显示角色'], run: () => setCharsHidden(!charHidden) },
    // 点播命令从模式注册表生成:内置+自定义(模式工坊)自动进命令面板与 LLM 兜底路由
    ...allModeList
      .filter((m) => m.id !== 'live')
      .map((m) => ({
        id: m.id,
        label: `来一段${m.label}`,
        keywords: [...new Set([...(m.triggers ?? []), m.label])],
        run: () => performNow(m.id),
      })),
    { id: 'live', label: '开播(直播弹幕互动,设置里填直播间号)', keywords: ['开播', '直播', '弹幕'], run: () => performNow('live') },
    { id: 'live-stop', label: '下播(结束直播弹幕互动)', keywords: ['下播'], run: () => director.stop() },
    { id: 'voice', label: voicePhase === 'off' ? '开启语音对话(和角色说话)' : '关闭语音对话', keywords: ['语音', '语音对话', '麦克风', '说话'], run: () => toggleVoiceSession() },
  ]

  /** 翻译成功后的角色搭腔:甲吹一句乙拆台,只在空闲时插话,20s 冷却 */
  function translateQuip() {
    if (phaseRef.current !== 'idle' || director.isPlaying()) return
    if (Date.now() - trQuipAt.current < TRANSLATE_QUIP_COOLDOWN_MS) return
    trQuipAt.current = Date.now()
    const q = TRANSLATE_QUIPS[Math.floor(Math.random() * TRANSLATE_QUIPS.length)]
    showPoke('A', q.a, 'happy', 2400)
    window.setTimeout(() => {
      // 2.5s 内开演了就不插话,别顶掉台词气泡
      if (phaseRef.current !== 'idle' || director.isPlaying()) return
      showPoke('B', q.b, 'talk', 2400)
    }, 2500)
  }
  useEffect(() => {
    void initPointerManager()
    preloadSprites(Object.values(SPRITE_SETS)) // 预热立绘,演出中切换动作零延迟
    preloadResident() // 预热 C 的 WebM 片段,首次切换零等待
    preloadProps() // 预热道具 SVG,首次礼物/工具流程不闪
    void ensureMoodLoaded() // 情绪档预载:presenter 待机染色要同步读
    void loadLinePacks() // 台词包存档预载:takePackLine 同步取句前必须先载入
    void getConfig().then((c) => {
      applyChars(c.characters)
      setRuntimeCharHidden(c.charactersHidden)
      setRuntimeDnd(c.dnd) // 勿扰状态进运行时(工具栏按钮/TTS 同步)
      applyCtrlBar(c.ctrlBar)
      // 截屏:应用全局快捷键 + 按配置把本窗口从系统级屏幕捕获中排除
      void applyScreenshotHotkey()
      void invoke('set_capture_excluded', { enable: c.screenshot.hideSelf }).catch(() => {})
      // 应用动作快捷键(生成/停止/随机回放/隐藏角色):配置驱动的全局注册
      void applyAppHotkeys()
      // 用户自定义角色名:先应用(名牌与台词称呼)
      setCharacterNames(c.names.a, c.names.b, c.names.c)
      // 用户自定义角色性别:代词/称呼纪律的事实源
      setCharacterGenders(c.genders.a, c.genders.b, c.genders.c)
      // 用户自定义人设:先应用,后续所有生成即采纳(来源一并采纳,供话题包门控)
      setPersonaOverride(c.persona.a, c.persona.b, c.persona.c, c.personaSource)
      // C 的启用态:关闭后新演出不再出现 C,话题包/缓存同步收窄
      setCEnabled(c.characters.C.enabled !== false)
      // 环境感知:按配置低频轮询本机状态(电量/前台应用分类等)
      // 环境感知或久坐提醒任一开启都需要轮询(久坐依赖键鼠空闲传感器,与环境感知解耦)
      if (c.envSense || c.breakReminder.enabled) startEnvPolling()
      // 开机自启动:按配置对账系统注册状态(默认关;手改配置文件后重启同样生效)
      void applyLaunchOnBoot(c.launchOnBoot)
    })
    const unsubs = [
      onHoverChange(setHovered),
      // 拖动中的角色命中区膨胀为全窗口:快速拖动时光标冲出角色矩形,
      // 否则穿透窗口会立刻恢复 ignoreCursorEvents,拖拽被中断
      registerHitRegion('charA', {
        getRect: () =>
          draggingWho.current === 'A'
            ? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
            : charA.current!.getBoundingClientRect(),
        nativePointerTarget: () => charA.current,
      }),
      registerHitRegion('charB', {
        getRect: () =>
          draggingWho.current === 'B'
            ? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
            : charB.current!.getBoundingClientRect(),
        nativePointerTarget: () => charB.current,
      }),
      // C 的热区按身体命中框取矩形(透明区域不拦截桌面点击);C 禁用/隐藏时组件不渲染,
      // ref 为空 → 零矩形 → 不注册。排在 A/B 之后:漫游重叠时 A/B 优先
      registerHitRegion('charC', {
        getRect: () =>
          draggingWho.current === 'C'
            ? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
            : (residentHitBox.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0)),
        nativePointerTarget: () => residentHitBox.current,
      }),
      // 工具栏按钮的热区由 ui/ControlBar 自行注册
    ]
    return () => unsubs.forEach((u) => u())
    // 挂载一次:命中区矩形经 getter 动态取,布局函数行为恒定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 面板命中区统一注册:抉择面板优先(观众投票即时),面板本就互斥,全屏兜底必须在最后
  // (穿透窗口里面板外的屏幕点击也能送达 DOM,"点外部收起"才生效)
  useOverlayHitRegions(
    useMemo(
      () => [
        {
          id: 'choice-panel',
          active: choice != null,
          getRect: () =>
            choicePanelRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
        },
        {
          id: 'topic-panel',
          active: topicOpen,
          activatesWindow: true,
          getRect: () =>
            topicPanelRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
        },
        {
          id: 'chat-box',
          active: chatOpen,
          activatesWindow: true,
          getRect: () =>
            chatBoxRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
        },
        {
          id: 'tr-panel',
          active: translationOpen,
          activatesWindow: true,
          getRect: () =>
            trPanelRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
        },
        {
          id: 'cmd-panel',
          active: toolsOpen,
          activatesWindow: true,
          getRect: () =>
            cmdPanelRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
        },
        {
          // 模式菜单:轻交互,无输入框,始终由原生钩子派发事件。
          id: 'mode-menu',
          active: modeMenuOpen,
          getRect: () =>
            modeMenuRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
          nativePointerTarget: () => modeMenuRef.current,
        },
        {
          // C 右键点播菜单:同 mode-menu 的轻交互机制,穿透窗口下按钮可点
          id: 'c-menu',
          active: cMenuOpen,
          getRect: () =>
            cMenuRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
          nativePointerTarget: () => cMenuRef.current,
        },
        {
          // 备忘提醒卡:右下角弹窗,不注册则点击穿透桌面,"知道了"永远点不到。
          // active 经 ref 读(声明在使用之后,直接进依赖数组会 TDZ 崩溃整个 App)
          id: 'memo-alert',
          active: true,
          getRect: () =>
            memoAlertsCountRef.current > 0
              ? (memoAlertsRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0))
              : new DOMRect(0, 0, 0, 0),
        },
        {
          // 工具任务卡:同备忘卡,不注册则错误卡的"知道了"点不到(卡永远关不掉)
          id: 'util-cards',
          active: true,
          getRect: () =>
            utilCardsCountRef.current > 0
              ? (utilCardsRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0))
              : new DOMRect(0, 0, 0, 0),
        },
        {
          id: 'outside',
          active: overlaysOpen,
          getRect: () => new DOMRect(0, 0, window.innerWidth, window.innerHeight),
          // 模式菜单/C菜单单独打开时，兜底区也走原生事件；点击空白处只负责收起菜单，
          // 不把整个透明 WebView 切成可点击窗口。
          nativePointerTarget: modeMenuOpen || cMenuOpen
            ? () => document.querySelector<HTMLElement>('.stage')
            : undefined,
        },
      ],
      // settingsOpen 不进依赖:设置已是独立 WebView,主窗命中区不随它变化
      [topicOpen, chatOpen, translationOpen, toolsOpen, choice, overlaysOpen, modeMenuOpen, cMenuOpen],
    ),
  )

  // Escape 只关最后打开的面板(runtime overlays 栈顶;语音录制中锁定:先停止录制才能关闭)
  useEffect(() => {
    if (!overlaysOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (getCaps().recording && settingsOpen) return
      const target = getCaps().escapeTarget
      if (target) closeOverlay(target)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlaysOpen, settingsOpen])

  // ---------- 每日台词包:后台生成调度 ----------
  // 开关开启时,启动约 1 分钟后(idle 预热完)生成今日包;失败 10 分钟后重试;
  // 每 30 分钟对一次日期,应用跨天开着也能换新。生成不阻塞任何交互,失败全程静默。
  useEffect(() => {
    if (!config.dailyLinePack) return
    let stopped = false
    let retry = 0
    const attempt = () => {
      if (stopped) return
      void (async () => {
        const today = dayKey()
        const packs = await loadLinePacks()
        if (packs.some((p) => p.date === today)) return
        try {
          const lines = await generateDailyLinePack()
          if (stopped) return
          // 生成成功才落盘:失败明天再试,今天用内置/存档兜底
          if (lines) await saveLinePack({ date: today, lines })
        } catch {
          retry = window.setTimeout(attempt, 10 * 60_000)
        }
      })()
    }
    const first = window.setTimeout(attempt, 60_000)
    const tick = window.setInterval(attempt, 30 * 60_000)
    return () => {
      stopped = true
      window.clearTimeout(first)
      window.clearInterval(tick)
      window.clearTimeout(retry)
    }
  }, [config.dailyLinePack])

  function replayFromHistory(ep: Episode) {
    void WebviewWindow.getByLabel('settings').then((w) => w?.hide().catch(() => {}))
    setSettingsOpen(false)
    director.replay(ep, 'manual')
  }

  /** 选中 @ 候选:替换光标前的 "@过滤词" 为 "@全名␣",光标落到空格后,面板收起 */
  function pickMention(c: MentionTarget) {
    const input = chatInputRef.current
    const caret = input?.selectionStart ?? chatDraft.length
    const { text, caret: nextCaret } = applyMention(chatDraft, caret, c.name)
    setChatDraft(text)
    setMention(null)
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  // 落盘双轨(备忘提醒等主动插话链使用;用户聊天链的双轨在 session 内部)
  function recordTurn(who: TurnWho, text: string) {
    pushTurn({ who, text })
    void appendChatTurns([{ who, text }])
  }

  // 聊天会话深模块:用户聊天链路的唯一入口(呈现/演出状态经回调交还,
  // 行为矩阵见 tests/chatSession.test.mjs)。App 只留 DOM 侧适配器,
  // LLM/落盘双轨/事实提取/busy 全在 session 内部
  const presenterSayRef = useRef(presenterSay)
  useEffect(() => {
    presenterSayRef.current = presenterSay
  })
  const pulseOtherRef = useRef(pulseOther)
  useEffect(() => {
    pulseOtherRef.current = pulseOther
  })
  const charNamesRef = useRef(charNames)
  useEffect(() => {
    charNamesRef.current = charNames
  })
  const directorRef = useRef(director)
  useEffect(() => {
    directorRef.current = director
  })
  const noteUserActiveRef = useRef(noteUserActive)
  useEffect(() => {
    noteUserActiveRef.current = noteUserActive
  })

  // ---------- 角色工具系统:协调器(终生一次)+ 宿主桥(确认卡/任务卡/pendingText) ----------
  // 铁律在协调器里;这里只做呈现适配:确认走角色风格卡(45s 无应答按拒绝),
  // pendingText 走插话气泡,进度与结果走右上浮层卡
  const [toolAsk, setToolAsk] = useState<{
    id: number
    title: string
    detail: string
    rememberable: boolean
    toolId: string
    resolve: (allowed: boolean) => void
  } | null>(null)
  const toolAskSeq = useRef(0)
  const toolCards = useRef(new Map<string, UtilityTaskHandle>())
  const webchatPrefRef = useRef(config.webchatEnabled === true)
  useEffect(() => {
    webchatPrefRef.current = config.webchatEnabled === true
  }, [config.webchatEnabled])
  const toolCoordinator = useMemo(
    () =>
      createToolCoordinator({
        registry: TOOLS,
        planner: createJsonPromptPlanner(defaultPlannerDeps(() => webchatPrefRef.current)),
        settings: async () => (await getConfig()).tools,
        facts: async () => ({ isLive: modeRef.current === 'live', phase: phaseRef.current }),
        host: {
          confirm: (req) =>
            new Promise<boolean>((resolve) => {
              const id = ++toolAskSeq.current
              const timer = window.setTimeout(() => {
                setToolAsk((cur) => (cur?.id === id ? null : cur))
                resolve(false) // 久未应答按拒绝:聊天回合不能被一张卡永远挂住
              }, 45_000)
              setToolAsk({
                id,
                title: req.title,
                detail: req.detail,
                rememberable: req.rememberable === true,
                toolId: req.toolId,
                resolve: (v) => {
                  window.clearTimeout(timer)
                  setToolAsk((cur) => (cur?.id === id ? null : cur))
                  resolve(v)
                },
              })
            }),
          presentPending: (m) => {
            const p = m.presentation
            if (p) presenterSayRef.current(p.actor, p.pendingText, { action: p.action, ms: 2200, reacting: true })
          },
          onToolStart: (m) => {
            toolCards.current.set(m.id, beginUtilityTask(m.label, m.presentation?.actor ?? 'C'))
          },
          onToolProgress: (m, detail) => toolCards.current.get(m.id)?.report(detail),
          onToolEnd: (m, result) => {
            const card = toolCards.current.get(m.id)
            if (!card) return
            toolCards.current.delete(m.id)
            if (result.ok) card.succeed(result.summary.split('\n')[0])
            else card.fail(result.summary)
          },
        },
      }),
    // 动态事实(阶段/直播态/开关)全部经 ref 与 getConfig 读取:协调器终生一次
    [],
  )

  const chatSession = useMemo(
    () =>
      createChatSession(
        {
          names: () => charNamesRef.current,
          isPerforming: () => phaseRef.current === 'performing',
          queueInterjection: (text, who) => directorRef.current.queueInterjection(text, who),
          presentTurn: ({ speaker, text, holdMs, memoryRefs }) => {
            presenterSayRef.current(speaker, text, {
              action: 'talk',
              ms: holdMs,
              speaking: true,
              memoryCount: memoryRefs?.length ?? 0,
            })
            pulseOtherRef.current(speaker)
          },
          presentUser: (text, who) => {
            setUserBubble(text)
            if (who) setTopActor(who)
          },
          clearUser: (text) => setUserBubble((u) => (u === text ? null : u)),
          presentFallback: ({ speaker, text }) =>
            presenterSayRef.current(speaker, text, { ms: 2200 }),
          onUserActive: () => noteUserActiveRef.current(),
          onTurnSpeechStart: () => getActiveVoiceSession()?.notifyTurnSpeechStart(),
        },
        // 工具协调挂在引擎侧:用户回合先问一句"这话要不要动手",观察块随生成注入
        { tools: (input, signal) => toolCoordinator.prepareTurn(input, signal) },
      ),
    // 两者均为 useState setter(稳定):session 终生只创建一次,其余回调经 ref 取最新
    [setUserBubble, setTopActor, toolCoordinator],
  )
  // busy 消费走外部 store:演出/抉择等待不算忙(session 与导演状态分界)
  const chatBusy = useSyncExternalStore(chatSession.subscribe, () => chatSession.getSnapshot().busy)

  // 启动引导:把 chatlog 尾部注入群聊运行时——重启/刷新后角色接续同一会话
  // (复用已有窗口),不再拿空 journal 每次从零开新场;用户先发话则本次引导放弃
  useEffect(() => {
    void (async () => {
      const turns = await listChatTurns(60).catch(() => [])
      if (turns.length === 0) return
      chatSession.bootstrapHistory(turns.map((t) => ({ who: t.who, text: t.text, ts: t.ts })))
    })()
  }, [chatSession])

  // 站点恢复模式回放:配置是持久事实源,Hub 是内存态(方案 §十四)。
  // 非 auto 的覆盖在启动时推给 Rust;Hub 侧自动升级判断不持久化,重启重新评估
  useEffect(() => {
    void (async () => {
      const cfg = await getConfig()
      for (const site of WEBCHAT_SITE_IDS) {
        const mode = cfg.webchatSiteModes?.[site]
        if (mode && mode !== 'auto') {
          await webchatSetSiteMode(site, mode).catch(() => {})
        }
      }
    })()
  }, [config.wizardDone])

  // 群聊页(设置窗)角色状态条:主窗节流推送快照(P4 可观测性;设置窗无会话实例)
  let lastActorPush = 0
  chatSession.subscribe(() => {
    const now = Date.now()
    if (now - lastActorPush < 400) return
    lastActorPush = now
    const snap = chatSession.getSnapshot()
    void emitTo('settings', 'group-actor-status', {
      actors: {
        A: { status: snap.actors.A.status, queueDepth: snap.actors.A.queueDepth },
        B: { status: snap.actors.B.status, queueDepth: snap.actors.B.queueDepth },
        C: { status: snap.actors.C.status, queueDepth: snap.actors.C.queueDepth },
      },
    }).catch(() => {})
  })

  /** 聊天通道核心(主聊天框与群聊页共用)。返回受理结果供 UI 提示:
   *  'empty' 空文本 / 'busy' 仅旧引擎回退 / 'backpressure' 运行时销毁中 /
   *  'accepted' 已受理(自由群聊下回应期间也照常受理) */
  async function sendUserChatText(raw: string): Promise<SendResult> {
    return chatSession.send(raw)
  }

  /** 语音对话开关(命令面板/全局热键共用):按设置里的对话模式启动,开着就关 */
  function toggleVoiceSession() {
    const vs = getActiveVoiceSession()
    if (!vs) return
    if (getVoiceSnapshot().phase !== 'off') {
      void vs.stop()
      return
    }
    void (async () => {
      const c = await getConfig()
      const m = c.voice.voiceChat.mode
      if (m === 'off') {
        presenterSayRef.current('A', '语音对话还没配置:到 设置 → 角色语音 → 语音对话 里选「按键说话」或「免按键」', { ms: 5000 })
        return
      }
      await vs.start(m)
    })()
  }

  // 语音会话安装(终生一次):真实依赖在此闭合,动态事实经稳定闭包取最新。
  // phase → 呈现映射:思考 = A/B 想姿势;回到收音 = 闭嘴 + 姿势复位(打断后气泡动画回收)
  useEffect(() => {
    installVoiceSession({
      chat: chatSession,
      loadConfig: async () => {
        const c = await getConfig()
        return { voiceChat: c.voice.voiceChat, asr: c.voice.asr }
      },
      mode: {
        prepare: () => {
          const caps = getCaps()
          if (caps.capturing) return false // 框选中不打断截图
          if (caps.performing || caps.streaming) directorRef.current.stop()
          return true
        },
        enter: () => beginVoice(),
        exit: () => endVoice(),
      },
      onPhase: (p, prev) => {
        if (p === 'thinking') {
          setPose('A', 'thinking')
          setPose('B', 'thinking')
        } else if (p === 'listening' && (prev === 'speaking' || prev === 'thinking')) {
          hush('A')
          hush('B')
          settle()
        } else if (p === 'off' || p === 'mic-lost') {
          settle()
        }
      },
      log: (m) => console.info('[voice]', m),
    })
    // chatSession 与 presenter 回调均稳定:终生安装一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 主聊天框入口:草稿走核心通道,受理后清空草稿 */
  async function sendUserChat() {
    const res = await sendUserChatText(chatDraft)
    if (res === 'accepted') setChatDraft('')
  }

  /** 打开设置(tab 直达某分页):show 常驻设置窗并通知其切页;设置窗自居舞台之上 */
  async function openSettings(tab?: SettingsTab) {
    const win = await WebviewWindow.getByLabel('settings')
    if (!win) return
    await win.show().catch(() => {})
    await win.setFocus().catch(() => {})
    await emitTo('settings', 'settings-goto', { tab: tab ?? 'general' }).catch(() => {})
    setSettingsOpen(true)
  }

  /** 隐藏设置窗(不销毁;窗内 Esc/关闭按钮同样只隐藏,经 settings-closed 事件同步到这里) */
  function closeSettings() {
    setSettingsOpen(false)
    void WebviewWindow.getByLabel('settings').then((w) => w?.hide().catch(() => {}))
  }

  /** 恢复 C 的默认位置(设置-基础设置入口);A/B 布局不动 */
  function resetResidentLayout() {
    applyChars({ ...charCfg, C: { ...DEFAULT_CONFIG.characters.C } }, 'now')
  }

  /** 设置窗口的跨模块行为:只经由这些回调触碰应用其余部分 */
  const settingsBridge: SettingsBridge = {
    onReplay: replayFromHistory,
    onResetLayout: resetLayout,
    onResetC: resetResidentLayout,
    onPrivacyTip: showPrivacyTip,
    onSupportThanks: showSupportThanks,
    onGroupSend: (text) => sendUserChatText(text),
    // 统一清空(评审①):只有主窗写文件——清 chatlog 的同时重置群聊运行时
    // (journal/队列/待播与网页会话 generation 全部重建)
    onClearChatlog: async () => {
      await clearChatLog()
      chatSession.reset()
    },
  }
  // 设置窗(独立 WebView)的事件桥服务端:动作回放/复位/群聊发送、代落盘配置、
  // 退出请求、关闭同步。bridge 与退出流程随渲染重建,监听只注册一次,经 ref 取最新
  const settingsBridgeRef = useRef(settingsBridge)
  settingsBridgeRef.current = settingsBridge
  const exitRequestRef = useRef<() => void>(requestExit)
  exitRequestRef.current = requestExit
  const settingsClosedRef = useRef(setSettingsOpen)
  settingsClosedRef.current = setSettingsOpen
  useEffect(() => {
    const un = initSettingsBridgeServer({
      getBridge: () => settingsBridgeRef.current,
      onExitRequest: () => exitRequestRef.current(),
      onClosed: () => settingsClosedRef.current(false),
    })
    return () => {
      void un.then((fns) => fns.forEach((f) => f()))
    }
  }, [])

  // ---------- 备忘录:调度与常驻提醒 ----------
  const [memoAlerts, setMemoAlerts] = useState<{ id: string; text: string }[]>([])
  useEffect(() => {
    memoAlertsCountRef.current = memoAlerts.length
  }, [memoAlerts])
  const memoSweepBusy = useRef(false)
  const privacyTipIdx = useRef(0)
  const PRIVACY_TIPS = [
    '提醒一句:密码、验证码、身份证这种,可别往备忘录里写!',
    '备忘录我们会拿来说的——银行账号、密码之类,嘴下留情也别笔下留!',
    '写待办没问题,敏感信息就免了,我们嘴快,怕说漏!',
  ]
  function showPrivacyTip() {
    const who: Speaker = privacyTipIdx.current % 2 === 0 ? 'A' : 'B'
    const tip = PRIVACY_TIPS[privacyTipIdx.current % PRIVACY_TIPS.length]
    privacyTipIdx.current += 1
    showPoke(who, tip, 'surprise', 3600)
  }

  // ---------- 支持作者:抽奖答谢演出 ----------
  // 稀有度定规格:普通/稀有插一句话,史诗加道具,传说 A→B→C 全员谢幕。
  // 连抽时旧演出被新答谢顶掉(token 失配的定时器自弃),感谢语由设置页解析好 {name} 再交进来
  const supportThanksToken = useRef(0)
  const SUPPORT_UR_LINES = [
    { b: '传说级心意!老板大气!', c: '已将这位老板记入荣誉名册!' },
    { b: '这排面,全体起立鼓掌!', c: '老板的名字,小管家刻进功劳簿了!' },
  ]
  function showSupportThanks(content: { rarity: Rarity; text: string }) {
    const token = ++supportThanksToken.current
    // token 失配即自弃:连点抽奖时上一轮的 B/C 跟话不再插进来
    const later = (ms: number, fn: () => void) =>
      window.setTimeout(() => {
        if (supportThanksToken.current === token) fn()
      }, ms)
    const who: 'A' | 'B' = Math.random() < 0.5 ? 'A' : 'B'
    if (content.rarity === 'legendary') {
      const lines = SUPPORT_UR_LINES[Math.floor(Math.random() * SUPPORT_UR_LINES.length)]
      showProp('A', 'microphone')
      presenterSay('A', content.text, { action: 'happy', ms: 3200 })
      pulseOther('A')
      later(3400, () => {
        presenterSay('B', lines.b, { action: 'laugh', ms: 2800 })
        pulseOther('B')
      })
      later(6300, () => presenterSay('C', lines.c, { ms: 2600 }))
    } else if (content.rarity === 'epic') {
      showProp(who, 'milk-tea')
      presenterSay(who, content.text, { action: 'happy', ms: 3200 })
      pulseOther(who)
    } else {
      presenterSay(who, content.text, {
        action: content.rarity === 'rare' ? 'laugh' : 'happy',
        ms: 2800,
      })
    }
  }


  /** 到点备忘扫描(调度器每 tick 调一次,内部幂等):卡片永远即时;
   *  画外音与甲乙讨论仅在空闲时追加,勿扰时 TTS 自静、卡片照弹 */
  async function sweepMemos(): Promise<void> {
    if (memoSweepBusy.current) return
    memoSweepBusy.current = true
    try {
      const cfg = await getConfig()
      const due = await getDueMemos(Date.now(), cfg.memo.advanceMin)
      for (const memo of due) {
        await updateMemo(memo.id, { fired: true })
        setMemoAlerts((list) => [...list, { id: memo.id, text: memo.text }])
        if (phaseRef.current === 'idle') {
          let line: string
          try {
            line = await memoReminderLine(memo.text)
          } catch {
            line = `叮——该「${memo.text}」了`
          }
          speak('C', line, undefined, 'proactive')
          // 小管家的提醒进聊天记录:C 也是群成员(与 @C 应答同一条落盘链,失败静默)
          recordTurn('C', line)
        }
        try {
          const lines = await generateShortChat('memo', director.recentLines(), memo.text)
          director.discuss(lines)
        } catch { /* 讨论失败静默 */ }
      }
    } finally {
      memoSweepBusy.current = false
    }
  }


  /** 隐藏/显示角色(立即落盘) */
  function setCharsHidden(v: boolean) {
    setRuntimeCharHidden(v)
    saveConfig({ charactersHidden: v }).catch((e) => console.warn('显示开关保存失败(静默)', e))
  }

  /** 手动话题即点即演:点卡传 pinCardId(展示 hook 与实际演出同源),自由输入传文本 */
  function playManualTopic(card?: { id: string; title: string }, text?: string) {
    const norm = (card?.title ?? text ?? '').trim()
    if (!norm) return
    closeOverlay('topic')
    director.play(mode, {
      ...(card ? { pinCardId: card.id, topic: norm } : { topic: norm }),
      strict: topicDraft.strict,
      duration: topicDraft.duration,
    })
    setTopicQuery('')
    setSuggestSeed((s) => s + 1) // 点播后刷新推荐,避免同一批反复出现
  }

  /** 面板"清除当前话题":结束活跃会话,回到动态选题(旧预生成缓存随之作废) */
  function clearTopicSession() {
    void topicDirector.clearSession()
  }

  /** 退出程序:两段确认的"已武装"态在 SettingsWindow 内,这里真正退干净。
   *  必须先销毁设置窗再销毁主窗——只关主窗会留下孤儿设置窗,进程不退出
   *  (角色消失但应用还活着,真实事故);全部窗口关闭后 Tauri 才会退出进程 */
  async function requestExit() {
    cancelDiscovery() // 在途的话题发现请求一并中止
    const settings = await WebviewWindow.getByLabel('settings')
    await settings?.destroy().catch(() => {})
    await getCurrentWindow().destroy().catch(() => {})
  }

  // 角色互动深模块:戳/摸头/投喂的唯一入口(连戳分级/即兴/吃撑冷却全在模块内,
  // 行为矩阵见 tests/charInteractions.test.mjs)。App 只留舞台事实与呈现适配
  const speakingRef = useRef(speaking)
  useEffect(() => {
    speakingRef.current = speaking
  })
  const showPokeRef = useRef(showPoke)
  useEffect(() => {
    showPokeRef.current = showPoke
  })
  const interactions = useMemo(
    () =>
      createCharInteractions({
        present: (who, line, action, ms) => showPokeRef.current(who, line, action, ms),
        focus: setTopActor,
        onUserActive: () => noteUserActiveRef.current(),
        isSpeaking: (who) => speakingRef.current === who,
        isPerforming: () => phaseRef.current === 'performing',
        isIdle: () => phaseRef.current === 'idle',
        isDirectorBusy: () => directorRef.current.isPlaying(),
        recentLines: () => directorRef.current.recentLines(),
      }),
    [setTopActor],
  )

  /** 戳任意角色:打断/连戳分级/即兴全在模块内 */
  function poke(who: Speaker) {
    interactions.poke(who)
  }

  /** 摸头长按(仅团宠):连摸害羞分级在模块内 */
  function headpatC() {
    interactions.headpatC()
  }

  /** 投喂(仅团宠):吃撑窗口与冷却在模块内 */
  function feedC() {
    interactions.feedC()
  }

  // 空闲 3 分钟无互动 → 角色打瞌睡(sleepy);任何互动/演出/面板恢复
  // 首启向导:只对"零痕迹"用户弹——老配置升级(wizardDone 缺省 false)但已有
  // 聊天记录或称呼的用户不弹;新用户完成/跳过后 wizardDone 落盘,不再出现。
  // "第一次成功互动"本地判定:发送 → 任一通道回复 → 气泡呈现 → 聊天落盘一条。
  const [wizardOpen, setWizardOpen] = useState(false)
  const wizardConfigRef = useRef(config)
  useEffect(() => {
    wizardConfigRef.current = config
  })
  useEffect(() => {
    void (async () => {
      const cfg = wizardConfigRef.current
      if (cfg.wizardDone) return
      const turns = await listChatTurns(1).catch(() => [])
      if (turns.length === 0 && !cfg.userProfile.userName.trim()) setWizardOpen(true)
    })()
  }, [config.wizardDone])
  const [sleepyOn, setSleepyOn] = useState(false)
  useEffect(() => {
    if (phase !== 'idle' || settingsOpen || topicOpen || chatOpen || charHidden) return
    const t = window.setTimeout(() => setSleepyOn(true), 180_000)
    return () => {
      window.clearTimeout(t)
      setSleepyOn(false)
    }
  }, [phase, settingsOpen, topicOpen, chatOpen, charHidden, activeTick])

  // 显示用动作:打瞌睡仅覆盖 idle 态,任何明确动作优先
  const displayAction = (who: Speaker) =>
    sleepyOn && action[who] === 'idle' ? 'sleepy' : action[who]
  // 立绘镜像与气泡尾巴必须读取同一方向事实,角色交换左右后两者同帧一起翻。
  const aFacesLeft = charCfg.B.xPct < charCfg.A.xPct
  const bFacesLeft = charCfg.B.xPct >= charCfg.A.xPct

  return (
    <BubbleThemeProvider theme={bubbleTheme}>
      <div
      className="stage"
      onPointerDown={(e) => {
        // 点在面板/工具栏之外 → 收起已打开的面板(穿透窗口下 e.target 即 .stage 本体)
        // 录音中点击外部不收面板(防止丢失停止入口)
        if (rt.mode.type === 'recording' && settingsOpen) return
        if (e.target === e.currentTarget) closeAllOverlays()
        // 点在C菜单外(其他角色/工具)也收起C菜单;但点在菜单项上绝不能在
        // pointerdown 就收起——原生钩子的 click 补发在 pointerup 之后,
        // 菜单先卸载会让 click 落在游离节点上,onClick 永远不触发(菜单关了、动作没了)
        else if (
          cMenuOpen &&
          !(cMenuRef.current && cMenuRef.current.contains(e.target as Node))
        ) {
          closeOverlay('c-menu')
        }
      }}
    >
      <VoiceStatusChip />
      <ControlBar
        pos={ctrlBar}
        onPosChange={applyCtrlBar}
        mode={mode}
        performanceState={performanceState}
        onGenerate={() => void director.play(mode)}
        onStop={director.stop}
        toolsOpen={toolsOpen}
        onTools={() => {
          if (toolsOpen) closeOverlay('tools')
          else openOverlayExclusive('tools')
        }}
        chatOpen={chatOpen}
        onChat={() => {
          if (chatOpen) closeOverlay('chat')
          else openOverlayExclusive('chat')
        }}
        dnd={rt.dnd}
        onDnd={toggleDnd}
        settingsOpen={settingsOpen}
        onSettings={() => {
          if (settingsOpen && rt.mode.type === 'recording') return // 录音中锁定
          if (settingsOpen) closeSettings()
          else void openSettings()
        }}
        modeMenuOpen={modeMenuOpen}
        onModeMenuToggle={toggleModeMenu}
        onMenuClose={() => {
          if (modeMenuOpen) closeOverlay('mode-menu')
        }}
      />

      {modeMenuOpen && (
        <div
          ref={modeMenuRef}
          className="mode-menu"
          style={{
            left: Math.max(
              12,
              Math.min(window.innerWidth - 272, (ctrlBar.xPct / 100) * window.innerWidth + MENU_LEFT_OFFSET),
            ),
            top: ctrlBar.top + PANEL_ANCHOR,
          }}
        >
          {allModeList.map((m) => (
            <button
              key={m.id}
              className={`mode-menu-item${mode === m.id ? ' on' : ''}`}
              title={m.label}
              onClick={() => {
                setMode(m.id)
                closeOverlay('mode-menu')
              }}
            >
              <span className="mode-menu-label">{m.label}</span>
              {mode === m.id && <span className="mode-menu-check">✓</span>}
            </button>
          ))}
        </div>
      )}

      {/* 角色右键点播菜单(C 团宠互动 / A/B 工具互动):锚在右键位置,轻交互浮层(点击项经原生钩子派发) */}
      {cMenuOpen && !charHidden && (cMenuFor === 'C' ? cEnabled : true) && (
        <div
          ref={cMenuRef}
          className="mode-menu c-menu"
          style={{ left: cMenuPos.current.x, top: cMenuPos.current.y }}
        >
          {(cMenuFor === 'C' ? cMenuActions : abMenuActions(cMenuFor)).map((a) => (
            <button
              key={a.id}
              className="mode-menu-item"
              onClick={() => {
                closeOverlay('c-menu')
                runCMenuAction(cMenuFor, a.run)
              }}
            >
              <span className="mode-menu-label">{a.label}</span>
            </button>
          ))}
        </div>
      )}

      {topicOpen && (
        <div
          ref={topicPanelRef}
          className={`settings-panel topic-panel${config.theme === 'light' ? ' light' : ''}`}
          style={{ left: `${Math.min(88, Math.max(12, ctrlBar.xPct))}%`, top: ctrlBar.top + 46 }}
        >
          <div className="panel-head">
            <span>当前演出话题</span>
            {(topicSnap.session || topicSnap.currentTitle) && (
              <button className="panel-btn" onClick={clearTopicSession}>
                清除当前话题
              </button>
            )}
          </div>
          <div className="topic-current">
            <div className="topic-current-title">
              {topicSnap.currentTitle || '暂无锁定话题，点「来一段演出」随机开讲'}
            </div>
            {topicSnap.session && (
              <div className="topic-current-meta">
                {topicSnap.session.duration === 'until-cleared'
                  ? '持续'
                  : `还剩 ${topicSnap.session.remainingEpisodes ?? 0} 集`}
                {' · '}
                {topicSnap.session.stage === 'open'
                  ? '开场'
                  : topicSnap.session.stage === 'deepen'
                    ? '深化'
                    : topicSnap.session.stage === 'escalate'
                      ? '升级'
                      : '收尾'}
                {topicSnap.currentHook ? ` · ${topicSnap.currentHook}` : ''}
              </div>
            )}
          </div>
          <div className="topic-actions">
            <button
              className="panel-btn"
              disabled={!topicSnap.currentTitle}
              onClick={() => playTopicAction('continue')}
            >
              继续
            </button>
            <button
              className="panel-btn"
              disabled={!topicSnap.currentTitle}
              onClick={() => playTopicAction('change-angle')}
            >
              换个角度
            </button>
            <button className="panel-btn" onClick={() => playTopicAction('pivot', 'medium')}>
              顺着联想
            </button>
            <button className="panel-btn" onClick={() => playTopicAction('pivot', 'far')}>
              完全换台
            </button>
          </div>
          <div className="topic-opts">
            <span className="topic-opts-label">本次持续</span>
            {(
              [
                ['once', '只聊一集'],
                ['three-episodes', '三集'],
                ['until-cleared', '持续'],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="topic-opt">
                <input
                  type="radio"
                  name="topic-duration"
                  checked={topicDraft.duration === v}
                  onChange={() => setTopicDraft((d) => ({ ...d, duration: v }))}
                />
                {label}
              </label>
            ))}
          </div>
          <div className="topic-opts">
            <span className="topic-opts-label">本次联想</span>
            {(
              [
                ['near', '相近'],
                ['medium', '有点意外'],
                ['far', '天马行空'],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="topic-opt">
                <input
                  type="radio"
                  name="topic-distance"
                  checked={topicDraft.distance === v}
                  onChange={() => setTopicDraft((d) => ({ ...d, distance: v }))}
                />
                {label}
              </label>
            ))}
          </div>
          <div className="topic-opts">
            <span className="topic-opts-label">推荐</span>
            {topicFacets.map((f) => (
              <button
                key={f.id}
                className={`panel-btn${suggestCat === f.id ? ' on' : ''}`}
                onClick={() => setSuggestCat(suggestCat === f.id ? null : f.id)}
              >
                {f.label}·{f.count}
              </button>
            ))}
            {suggestCat && (
              <button className="panel-btn" onClick={() => setSuggestSeed((s) => s + 1)}>
                换一批
              </button>
            )}
          </div>
          {suggestCat && (
            <div className="topic-list">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  className="topic-item"
                  onClick={() => playManualTopic({ id: s.id, title: s.title })}
                >
                  <span className="topic-item-title">{s.title}</span>
                  <span className="topic-item-hook">{s.hook}</span>
                </button>
              ))}
            </div>
          )}
          <input
            className="topic-search"
            value={topicQuery}
            placeholder="搜索话题,或输入自定义主题,回车开演…"
            onChange={(e) => setTopicQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') playManualTopic(undefined, topicQuery)
            }}
          />
          <label className="topic-strict">
            <input
              type="checkbox"
              checked={topicDraft.strict}
              onChange={(e) => setTopicDraft((d) => ({ ...d, strict: e.target.checked }))}
            />
            严格围绕该话题（不要偏题）
          </label>
          <div className="topic-list">
            {topicQuery.trim() === '' && (
              <div className="topic-empty">输入关键词搜索,回车即以此话题开演</div>
            )}
            {topicQuery.trim() !== '' &&
              !searchHits.some((s) => s.title.includes(topicQuery.trim())) && (
                <button className="topic-item" onClick={() => playManualTopic(undefined, topicQuery)}>
                  用『{topicQuery.trim()}』作为话题
                </button>
              )}
            {searchHits.map((s) => (
              <button
                key={s.id}
                className="topic-item"
                onClick={() => playManualTopic({ id: s.id, title: s.title })}
              >
                <span className="topic-item-title">{s.title}</span>
                <span className="topic-item-hook">{s.hook}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className={`actor${charCfg.A.bottom + charCfg.height > window.innerHeight - 110 ? ' flip' : ''}`}
        style={{
          left: `${charCfg.A.xPct}%`,
          bottom: charCfg.A.bottom,
          zIndex: topActor === 'A' ? 2 : 1,
          display: charHidden ? 'none' : undefined,
        }}
        onPointerDown={(e) => onCharPointerDown(e, 'A')}
        onPointerMove={(e) => onCharPointerMove(e, 'A')}
        onPointerUp={() => onCharPointerUp('A')}
        onWheel={(e) => onCharWheel(e)}
        onContextMenu={(e) => {
          e.preventDefault()
          openCMenu('A', e.clientX, e.clientY)
        }}
      >
        <Bubble
          text={bubble.A}
          speaker="A"
          below={charCfg.A.bottom + charCfg.height > window.innerHeight - 110}
          loud={loudBubble.A}
          tailSide={aFacesLeft ? 'left' : 'right'}
          action={displayAction('A')}
          delivery={delivery.A}
          memoryCount={memBadge.A}
        />
        <CharacterSprite
          ref={charA}
          sprite={SPRITE_SETS.A}
          nameOverride={charNames.A}
          heightOverride={charCfg.height}
          flipped={aFacesLeft}
          action={displayAction('A')}
          delivery={delivery.A}
          talkDuration={
            bubble.A
              ? (delivery.A ? DELIVERY_TALK_DUR[delivery.A] : 0.3 + Math.min(0.7, bubble.A.length * 0.04))
              : undefined
          }
          lean={speaking === 'B' ? (charCfg.A.xPct <= charCfg.B.xPct ? 'right' : 'left') : undefined}
          listening={speaking === 'B'}
          pulsing={pulseFor === 'A'}
          dropped={dropFor === 'A'}
          dragging={dragUi === 'A'}
          hot={hovered === 'charA'}
          reacting={reacting.A}
        />
        <StageProps
          who="A"
          charH={charCfg.height}
          below={charCfg.A.bottom + charCfg.height > window.innerHeight - 110}
        />
      </div>

      <div
        className={`actor${charCfg.B.bottom + charCfg.height > window.innerHeight - 110 ? ' flip' : ''}`}
        style={{
          left: `${charCfg.B.xPct}%`,
          bottom: charCfg.B.bottom,
          zIndex: topActor === 'B' ? 2 : 1,
          display: charHidden ? 'none' : undefined,
        }}
        onPointerDown={(e) => onCharPointerDown(e, 'B')}
        onPointerMove={(e) => onCharPointerMove(e, 'B')}
        onPointerUp={() => onCharPointerUp('B')}
        onWheel={(e) => onCharWheel(e)}
        onContextMenu={(e) => {
          e.preventDefault()
          openCMenu('B', e.clientX, e.clientY)
        }}
      >
        <Bubble
          text={bubble.B}
          speaker="B"
          below={charCfg.B.bottom + charCfg.height > window.innerHeight - 110}
          loud={loudBubble.B}
          tailSide={bFacesLeft ? 'left' : 'right'}
          action={displayAction('B')}
          delivery={delivery.B}
          memoryCount={memBadge.B}
        />
        <CharacterSprite
          ref={charB}
          sprite={SPRITE_SETS.B}
          nameOverride={charNames.B}
          heightOverride={charCfg.height}
          flipped={bFacesLeft}
          action={displayAction('B')}
          delivery={delivery.B}
          talkDuration={
            bubble.B
              ? (delivery.B ? DELIVERY_TALK_DUR[delivery.B] : 0.3 + Math.min(0.7, bubble.B.length * 0.04))
              : undefined
          }
          lean={speaking === 'A' ? (charCfg.B.xPct <= charCfg.A.xPct ? 'right' : 'left') : undefined}
          listening={speaking === 'A'}
          pulsing={pulseFor === 'B'}
          dropped={dropFor === 'B'}
          dragging={dragUi === 'B'}
          hot={hovered === 'charB'}
          reacting={reacting.B}
        />
        <StageProps
          who="B"
          charH={charCfg.height}
          below={charCfg.B.bottom + charCfg.height > window.innerHeight - 110}
        />
      </div>

      {/* 常驻角色 C:独立 WebM 视频模块,站在甲乙之间;拖拽/漫游经同一布局管线 */}
      <div
        className="actor"
        style={{
          left: `${charCfg.C.xPct}%`,
          bottom: charCfg.C.bottom,
          zIndex: topActor === 'C' ? 2 : 1,
          display: charHidden || !cEnabled ? 'none' : undefined,
        }}
        onPointerDown={(e) => onCharPointerDown(e, 'C')}
        onPointerMove={(e) => onCharPointerMove(e, 'C')}
        onPointerUp={() => onCharPointerUp('C')}
        onWheel={(e) => onResidentWheel(e)}
        onContextMenu={(e) => {
          e.preventDefault()
          openCMenu('C', e.clientX, e.clientY)
        }}
      >
        <ResidentActor
          hitBoxRef={residentHitBox}
          action={displayAction('C')}
          bubble={bubble.C}
          loud={loudBubble.C}
          speaking={speaking === 'C'}
          dragging={dragUi === 'C'}
          active={cEnabled && !charHidden}
          calm={rt.dnd}
          hidden={charHidden || !cEnabled}
          width={charCfg.C.width}
          below={charCfg.C.bottom + charCfg.C.width * 0.5625 > window.innerHeight - 110}
          xPct={charCfg.C.xPct}
          onMove={moveResident}
          hot={hovered === 'charC'}
          name={charNames.C}
        />
      </div>

      {chatOpen && (
          <div
            ref={chatBoxRef}
            className="chat-box"
            style={{ left: `${ctrlBar.xPct}%`, top: ctrlBar.top + 46 }}
          >
            {userBubble && <div className="user-bubble">你说:{userBubble}</div>}
            {/* @ 补全面板:在流子元素撑高容器,原生热区矩形自动覆盖,穿透下可点选 */}
            {mention && mentionMatches.length > 0 && (
              <div className="mention-pop">
                {mentionMatches.map((c: MentionTarget, i: number) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`mention-item${i === mentionIdx % mentionMatches.length ? ' on' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault() // 保持输入框焦点
                      pickMention(c)
                    }}
                  >
                    @{c.name}
                    <span className="mention-key">{c.key}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="chat-row">
              <input
                ref={chatInputRef}
                type="text"
                placeholder="和角色说话…(@甲/@乙/@丙 指定谁回)"
                value={chatDraft}
                onChange={(e) => {
                  const v = e.target.value
                  setChatDraft(v)
                  const caret = e.target.selectionStart ?? v.length
                  setMention(mentionContext(v.slice(0, caret)))
                  setMentionIdx(0)
                }}
                onKeyDown={(e) => {
                  if (mention && mentionMatches.length > 0) {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      const step = e.key === 'ArrowDown' ? 1 : mentionMatches.length - 1
                      setMentionIdx((i) => (i + step) % mentionMatches.length)
                      return
                    }
                    if (e.key === 'Enter' || e.key === 'Tab') {
                      e.preventDefault()
                      pickMention(mentionMatches[mentionIdx % mentionMatches.length])
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation() // 只收起补全,不连带关掉聊天面板
                      setMention(null)
                      return
                    }
                  }
                  if (e.key === 'Enter') void sendUserChat()
                }}
              />
              <button
                className="panel-btn primary"
                disabled={phase !== 'idle' || !chatDraft.trim()}
                title={phase !== 'idle' ? '演出/生成进行中,稍后再说' : chatBusy ? '角色正在回应,可继续输入' : ''}
                onClick={() => void sendUserChat()}
              >
                {chatBusy ? '回应中…' : '发送'}
              </button>
            </div>
          </div>
        )}

        {choice && (
          <ChoicePanel
            innerRef={choicePanelRef}
            choice={choice}
            left={`${Math.min(88, Math.max(12, ctrlBar.xPct))}%`}
            top={Math.min(window.innerHeight - 180, Math.max(12, ctrlBar.top + 46))}
            onPick={director.choose}
          />
        )}

        {/* 工具确认卡(角色演绎确认):敏感工具执行前问一句;45s 无应答按拒绝 */}
        {toolAsk && (
          <div
            className="settings-panel choice-panel"
            style={{
              left: `${Math.min(88, Math.max(12, ctrlBar.xPct))}%`,
              top: Math.min(window.innerHeight - 200, Math.max(12, ctrlBar.top + 46)),
            }}
            role="group"
            aria-label="工具确认"
          >
            <div className="choice-prompt">{toolAsk.title}</div>
            {toolAsk.detail && (
              <div style={{ fontSize: 12, opacity: 0.75, whiteSpace: 'pre-wrap', margin: '2px 0 8px' }}>
                {toolAsk.detail}
              </div>
            )}
            <div className="choice-opts">
              <button className="panel-btn primary" onClick={() => toolAsk.resolve(true)}>
                允许
              </button>
              {toolAsk.rememberable && (
                <button
                  className="panel-btn"
                  onClick={() => {
                    // 记住允许:写进配置 autoApproved,此后该工具不再弹确认(设置页可清除)
                    void getConfig()
                      .then((c) =>
                        saveConfig({
                          tools: {
                            ...c.tools,
                            autoApproved: { ...c.tools.autoApproved, [toolAsk.toolId]: true },
                          },
                        }),
                      )
                      .catch(() => {})
                    toolAsk.resolve(true)
                  }}
                >
                  允许并不再问
                </button>
              )}
              <button className="panel-btn" onClick={() => toolAsk.resolve(false)}>
                这次不行
              </button>
            </div>
          </div>
        )}

        {/* C 已是常驻身体,台词气泡在角色头顶;仅在设置里禁用 C 时回落画外音横幅(取色随主题) */}
        {bubble.C && !cEnabled && (
          <div
            className="guest-bubble"
            style={{ background: guestLook.surface, borderColor: guestLook.edge, color: guestLook.text }}
          >
            <span className="guest-tag">📞 画外音</span>
            {bubble.C}
          </div>
        )}

        {memoAlerts.length > 0 && (
          <div className="memo-alerts" ref={memoAlertsRef}>
            {memoAlerts.map((a) => (
              <div key={a.id} className="memo-alert">
                <span className="memo-tag">⏰ 备忘提醒</span>
                <div className="memo-alert-text">{a.text}</div>
                <button
                  className="memo-ok"
                  onClick={() => setMemoAlerts((list) => list.filter((x) => x.id !== a.id))}
                >
                  知道了
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 完播评价条:锚在工具栏正上方,一键 👍/👎/★ + 话题轻操作。面板开着时不现身——
            全屏 outside 热区(点外部收面板)会抢走点击,等面板关掉再弹出并从头计时 */}
        <RatingChip
          ask={overlaysOpen ? null : ratingAsk}
          style={{ left: `${ctrlBar.xPct}%`, top: Math.max(12, ctrlBar.top - 52) }}
          onRate={(r) => {
            const info = ratingAskRef.current
            if (info) submitRating(info, r)
          }}
          onFav={() => {
            const info = ratingAskRef.current
            if (info) favoriteCurrentEpisode(info)
          }}
          onContinueTopic={() => {
            const info = ratingAskRef.current
            if (info) {
              setRatingAsk(null)
              director.play(info.mode, { intent: 'continue' })
            }
          }}
          onChangeAngle={() => {
            const info = ratingAskRef.current
            if (info) {
              setRatingAsk(null)
              director.play(info.mode, { intent: 'change-angle' })
            }
          }}
          onBanTopic={() => {
            const info = ratingAskRef.current
            if (info) {
              void topicDirector.record({ type: 'rating-changed', eid: info.eid, value: 'down' })
              setRatingAsk(null)
            }
          }}
          onDismiss={dismissRating}
        />

        <div ref={utilCardsRef}>
          <UtilityCards />
        </div>

        {captureShot && (
          <Suspense fallback={null}>
            <CaptureOverlay
            path={captureShot}
            onDone={(ok, action, savedPath) => {
              endCapture() // 无论成败都恢复框选前的演出态
              setCaptureMode(false)
              setCaptureShot(null)
              if (!ok) return
              noteUserActive()
              // 工具条选的动作:识字只填面板,识字+翻译自动翻,保存上报路径卡片
              if (action === 'translate') {
                startOcrIntoTranslation(true)
              } else if (action === 'ocr') {
                startOcrIntoTranslation(false)
              } else if (action === 'save' && savedPath) {
                void runUtilityTask('save', '保存截图', 'A', async () => `已保存:${savedPath}`)
              }
            }}
            />
          </Suspense>
        )}

        {translationOpen && (
          <Suspense fallback={null}>
            <TranslationPanel
              innerRef={trPanelRef}
              pos={ctrlBar}
              inject={trInject}
              onClose={() => closeOverlay('translation')}
              onScreenshotTranslate={startScreenshotFlow}
              onTranslated={translateQuip}
              onState={onTranslateState}
            />
          </Suspense>
        )}

        {toolsOpen && (
          <CommandPanel
            innerRef={cmdPanelRef}
            pos={ctrlBar}
            commands={commands}
            onClose={() => closeOverlay('tools')}
            onAddMemo={(text, dueAt) => {
              showPrivacyTip()
              void addMemo(text, dueAt, null)
            }}
            onPerform={performNow}
          />
        )}

        {showWatermark && (
          <div className="watermark">空闲时自动重放历史 · 选模式点 ▶ 生成一集 · 拖精灵球移动工具栏</div>
        )}

      </div>
      {wizardOpen && (
        <FirstRunWizard
          onDone={(skipped) => {
            setWizardOpen(false)
            if (skipped) {
              presenterSay('A', '演示模式开启!▶ 里全是内置剧目,填了 Key 更有料~', {
                action: 'happy',
                ms: 4200,
              })
            } else {
              presenterSay('A', '都连好了,来聊两句试试?点下面的输入框就行~', {
                action: 'happy',
                ms: 4200,
              })
            }
          }}
        />
      )}
    </BubbleThemeProvider>
  )
}

export default App
