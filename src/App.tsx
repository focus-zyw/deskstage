import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen, emitTo } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { invoke } from '@tauri-apps/api/core'
import { CharacterSprite } from './stage/CharacterSprite'
import { Bubble } from './stage/Bubble'
import { startScreenshot, applyScreenshotHotkey } from './capture'
import { applyAppHotkeys, setHotkeyHandler } from './hotkeys'
import { setCharacterGenders, setCharacterNames, setPersonaOverride, nameOf, pronounOf } from './engine/persona'
import { startEnvPolling } from './engine/envAware'
import {
  setCaptureMode,
  initPointerManager,
  registerHitRegion,
  onHoverChange,
  setPanelsOpen,
} from './input/pointerManager'
import { CaptureOverlay } from './CaptureOverlay'
import { SPRITE_SETS, preloadSprites } from './stage/spriteSets'
import { ResidentActor } from './stage/resident/ResidentActor'
import { preloadResident, snackActionNow } from './stage/resident/residentManifest'
import type { DialogLine, Speaker } from './performer/player'
import { useAllModes, type Mode } from './performer/modes'
import { generateShortChat, generateTurnBatch, improvPokeLine, generateUserChatReply, extractFacts, memoReminderLine, generateDailyLinePack } from './engine/llmClient'
import { loadLinePacks, saveLinePack, takePackLine, dayKey, type LineKind } from './storage/linePackStore'
import { pushTurn, chatWindow, type TurnWho } from './dialogue/turnWindow'
import { appendChatTurns } from './storage/chatLogStore'
import { react } from './engine/interactionRules'
import { logInteraction, logInterrupt, resetDismissals } from './storage/interactionStore'
import { ensureMoodLoaded, notePoked } from './storage/moodStore'
import { noteActivity } from './runtime/proactiveScheduler'
import { speak } from './engine/tts'
import { TOPIC_SEEDS } from './engine/topicSeeds'
import { bumpPoke, getMemory, topFacts, mergeFacts, bumpTopicFavored } from './storage/memoryStore'
import { getDueMemos, addMemo, updateMemo } from './storage/memoStore'
import { findEpisodeByEid, toggleFavorite, type Episode } from './storage/historyStore'
import { rateEpisode } from './storage/feedbackStore'
import { TranslationPanel, type TranslationInject } from './translation/TranslationPanel'
import { extractTextFromClipboard } from './translation/ocr'
import { startLiveSession, stopLiveSession, type LiveReply } from './runtime/liveDanmaku'
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
  openOverlayExclusive,
  closeOverlay,
  closeAllOverlays,
  setDnd as setRuntimeDnd,
  setCharHidden as setRuntimeCharHidden,
} from './runtime/runtimeMode'
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
} from './storage/configStore'
import { applyBubbleThemeTo, useBubbleThemes } from './storage/bubbleThemesStore'
import { applyLaunchOnBoot } from './runtime/launchOnBoot'
import { useOverlayHitRegions } from './runtime/useOverlayHitRegion'
import { initSettingsBridgeServer } from './settings/bridgeServer'
import type { SettingsBridge } from './settings/useSettingsSession'
import type { SettingsTab } from './settings/settingsCatalog'
import type { Rarity } from './features/support/pool'
import './App.css'

// 点击反应台词池,按连戳强度分级(60s 滑动窗口计数)
const POKE_LINES = [
  '干嘛点我！',
  '再点要收费了！',
  '诶嘿嘿~',
  '别闹，正聊着呢',
  '摸鱼被发现了？！',
  '（默默挪开半步）',
  '手滑了？再来一次试试',
  '点我有什么好玩的嘛',
]
const SHY_LINES = [
  '（脸红）别、别一直戳啦…',
  '呜…突然这样我会不好意思的',
  '（往后缩了缩）你今天好奇怪',
]
const ANGRY_LINES = [
  '够了！再戳我真的生气了！！',
  '（拍开你的手）烦不烦！',
  '再戳一下试试？信不信我下线！',
]
/** C(团宠)专属戳反应池:小管家的字面认真语气,与甲乙的互怼语气区分开。
 *  函数化:取用时填当前配置名(模块加载早于 setCharacterNames) */
const cPokeLines = () => [
  `（掏出小本本）此人今日戳${nameOf('C')}一次`,
  `哼，${nameOf('C')}可生气了（并没有）`,
  '（歪头）你的手…是在打招呼吗？',
  `（认真脸）再戳${nameOf('C')}就要预约了`,
  '（被戳得晃了晃）哇啊——',
]
const cShyLines = () => [
  `（鼓脸）再、再戳${nameOf('C')}就把家务全做完了！`,
  '（往后缩）你们两个都笑话我…',
  '呜…（小声）其实也没有不开心…',
]
const cAngryLines = () => [
  `（傲娇鼓脸）哼！${nameOf('C')}真的生气了！这次是真的！`,
  `（叉腰）再戳就把${nameOf('A')}${nameOf('B')}的零食全部收缴！`,
  '（转身背对，肩膀微微在抖）不理你们了！',
]
/** 摸头(长按)反应池:受用又不好意思,与"被戳"的惊讶语气区分 */
const cHeadpatLines = () => [
  '（眯眼）唔…再摸一下也不是不可以…',
  '（咯咯笑）痒、痒啦！',
  `（蹭了蹭）${nameOf('C')}的头很神奇吧`,
  '（耳朵红了）谢、谢谢夸奖…？',
  '（开心到冒泡）今天的头也是甲级！',
]
const cHeadpatShyLines = () => [
  `（脸鼓成包子）再摸要摸秃啦！${nameOf('C')}头发量有限的！`,
  '（捂头蹲下）呜哇，头要被摸平了啦…',
  '（小声）其实…可以再摸一小会儿…',
]
/** 投喂反应池:按时段端出的点心各配一句通用感谢 */
const cFeedLines = () => [
  '（双手接过）开动啦！',
  '（眼睛发亮）哇——是给我的？！',
  `（小口小口）${nameOf('C')}会好好吃完的！`,
  '（腮帮鼓鼓）唔唔…好吃…',
  '（认真）点心和快乐一起收下了！',
]
/** 连喂吃撑:中性撒娇,不进账本不记仇 */
const cStuffedLines = () => [
  '（抱着圆滚滚的肚子）唔…吃不下了，剩下的存起来…',
  '（瘫住）肚子已经变成方形了…让我缓缓…',
  '（摆手）再喂就要滚着走路了！',
]
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
/** 台词包优先取句:今日包/存档里有就弹一句(不重复),没有回内置池 */
function packLine(kind: LineKind, pool: string[]): string {
  return takePackLine(kind) ?? pool[Math.floor(Math.random() * pool.length)]
}
/** 戳团宠时另一角色起哄的概率:三人舞台感(甲乙是"同伙") */
const TEASE_HYPE_CHANCE = 0.3
const teaseHypeLines = () => {
  const t = pronounOf('C')
  return [
    `哈哈，${t}又把小本本掏出来了`,
    `别逗了，${t}连生气都是圆的`,
    '（憋笑）你继续，我就看看',
    '哎哎，团宠被你戳蔫了，赔！',
  ]
}
/** 连戳计数窗口与阈值 */
const POKE_WINDOW_MS = 60_000
const SHY_AT = 2 // 窗口内第 2~4 次戳 → 害羞
const ANGRY_AT = 5 // 第 5 次起 → 生气,并不再响应直到窗口清空
/** LLM 即兴吐槽:轻戳时的触发概率与冷却 */
const IMPROV_CHANCE = 0.3
const IMPROV_COOLDOWN_MS = 30_000

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
  // C 右键菜单:轻交互浮层(mode-menu 同机制,不激活窗口)。
  // 声明在组件顶部:hit region 注册表(useOverlayHitRegions)要读 cMenuOpen/cMenuRef
  const cMenuOpen = rt.overlays.includes('c-menu')
  const cMenuPos = useRef({ x: 0, y: 0 })
  const cMenuRef = useRef<HTMLDivElement>(null)
  function openCMenu(x: number, y: number) {
    // 限位:176 宽菜单贴边不裁切
    cMenuPos.current = {
      x: Math.max(8, Math.min(window.innerWidth - 184, x)),
      y: Math.max(8, Math.min(window.innerHeight - 260, y)),
    }
    openOverlayExclusive('c-menu')
  }
  /** 菜单项动作:演出/生成期间只应一句,不动演出;空闲时执行 */
  function runCMenuAction(run: () => void) {
    if (phaseRef.current !== 'idle' || director.isPlaying()) {
      showPoke('C', '（摆手）等这集演完再来点我~', 'talk', 1800)
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
  // 设置窗:独立 WebView(tauri.conf 预建 label=settings,启动隐藏),主窗只管 show/hide
  // 与开关态同步;窗内表单、保存、Esc/关闭按钮都由设置窗自理(经 settings 事件桥回报)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 配置事实源:读同一份已落盘配置(任何 saveConfig 成功后即时发布),不再各自维护镜像
  const config = useConfigSnapshot()
  const charNames = { A: config.names.a, B: config.names.b, C: config.names.c }
  const showWatermark = config.showWatermark
  // 气泡主题落地到根节点:内置 comic/glass 走 data-bubble 变量集;
  // 气泡工坊自建主题走 inline style 变量(优先级更高),主题增删改即时生效。
  // 选中的自定义主题不存在(被删)时回退柔彩。
  const bubbleThemes = useBubbleThemes()
  useEffect(() => {
    const root = document.documentElement
    if (config.bubbleStyle === 'comic' || config.bubbleStyle === 'glass') {
      applyBubbleThemeTo(root, null)
      root.dataset.bubble = config.bubbleStyle === 'glass' ? 'glass' : 'comic'
      return
    }
    const theme = bubbleThemes.find((t) => t.id === config.bubbleStyle)
    if (!theme) {
      applyBubbleThemeTo(root, null)
      root.dataset.bubble = 'comic'
      return
    }
    root.dataset.bubble = 'comic' // 自定义以 inline 变量为准,清理内置 data 钩子语义
    applyBubbleThemeTo(root, theme)
  }, [config.bubbleStyle, bubbleThemes])
  // 聊天通道:输入框开合/草稿/应答中;用户气泡(区别于角色气泡)
  const chatOpen = rt.overlays.includes('chat')
  const [chatDraft, setChatDraft] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [userBubble, setUserBubble] = useState<string | null>(null)
  const lastChatTarget = useRef<Speaker>('A')
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
  // 手动锁定主题;null = 随机。主题面板弹/收与搜索词
  const [topicOverride, setTopicOverride] = useState<string | null>(null)
  const topicOpen = rt.overlays.includes('topic')
  const [topicQuery, setTopicQuery] = useState('')
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
    showTalk, hush, endLine, pulse, settle, setPose, reset: resetStage,
    say: presenterSay,
  } = useActorPresenter()

  // 演出导演:生成/回放/选边/停止/主动行为演出的唯一归属(逐句呈现委托给呈现器)
  const director = usePerformanceDirector({
    presenter: { say: presenterSay, showTalk, hush, endLine, settle, reset: resetStage, setPose },
    isIdle: () => phaseRef.current === 'idle',
    getTopicOverride: () => topicOverride,
    getInterests: () =>
      config.userProfile.likes
        .split(/[,，、;；\n]/)
        .map((x) => x.trim())
        .filter(Boolean),
    onLive: () => startStreaming(),
    teardown: () => {
      liveStopRef.current?.()
      stopLiveSession()
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

  /** 显式评价提交(评价条/快捷键共用):落盘 feedback.json + 口味权重 ± 记账 */
  function submitRating(info: RatingAsk, rating: 'up' | 'down') {
    if (ratingAskRef.current?.eid === info.eid) setRatingAsk(null)
    void rateEpisode(info.eid, { ts: Date.now(), mode: info.mode, topic: info.topic }, rating).catch(() => {})
  }

  /** 收藏刚完播的这集:按 eid 找回整集,走与历史页 ★ 同一条收藏通道 */
  function favoriteCurrentEpisode(info: RatingAsk) {
    void (async () => {
      const ep = await findEpisodeByEid(info.eid)
      if (!ep) return
      const nowFav = await toggleFavorite(ep)
      if (nowFav) bumpTopicFavored(ep.topic)
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
  const utilPropSeen = useRef(new Map<string, string>())
  useEffect(() => {
    for (const t of utilityTasks) {
      if (utilPropSeen.current.get(t.id) === t.status) continue
      utilPropSeen.current.set(t.id, t.status)
      if (t.kind === 'capture-translate' && t.status === 'done') continue // 翻译还在跑,接力给面板
      if (t.kind === 'live') continue // 直播是常驻状态卡,不挂道具
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
          void startLiveSession(cfg.live.platform, cfg.live.roomId, {
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
          })
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
    { id: 'topic', label: '设置聊天主题', keywords: ['话题', '主题'], run: () => openOverlayExclusive('topic') },
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
      setTopicOverride(c.topicOverride)
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
      // 用户自定义人设:先应用,后续所有生成即采纳
      setPersonaOverride(c.persona.a, c.persona.b, c.persona.c)
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

  /** 聊天记录双轨:短期窗口入列(内存,喂 LLM)与永久落盘(chatlog.jsonl,供「聊天记录」页回看)同源走这一处;落盘失败静默 */
  function recordTurn(who: TurnWho, text: string) {
    pushTurn({ who, text })
    void appendChatTurns([{ who, text }])
  }

  /** 聊天通道核心(主聊天框与群聊页共用,显式文本入列)。返回受理结果供 UI 提示:
   *  'empty' 空文本 / 'busy' 忙碌(应答在飞,或演出生成/抉择等待;演出进行中不算)/ 'accepted' 已受理。
   *  解析 @角色 → TurnBatch(被@角色先答,其他人有料才补,共 1~3 句) → 顺序播报;
   *  短期会话窗口入列(下轮聊天/演出插话共用);无 @ 时在甲乙间轮换(丙需显式点名);
   *  演出进行中改为入队插话(句尾安全缝反应后接回剧情) */
  async function sendUserChatText(raw: string): Promise<'accepted' | 'busy' | 'empty'> {
    const text = raw.trim()
    if (!text) return 'empty'
    if (chatBusy) return 'busy'
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const targetOf: Record<string, Speaker> = {
      [charNames.A]: 'A',
      [charNames.B]: 'B',
      [charNames.C]: 'C',
      甲: 'A',
      乙: 'B',
      丙: 'C',
      A: 'A',
      B: 'B',
      C: 'C',
    }
    const alt = new RegExp(
      `^\\s*@?(${esc(charNames.A)}|${esc(charNames.B)}|${esc(charNames.C)}|甲|乙|丙|A|B|C)\\s*`,
    )
    const m = text.match(alt)
    const who: Speaker = m
      ? (targetOf[m[1]] ?? 'A')
      : (lastChatTarget.current = lastChatTarget.current === 'A' ? 'B' : 'A')
    if (phase === 'performing') {
      // P4 演出中插话:入队,当前句结束的安全缝处反应并接回剧情
      director.queueInterjection(text, who)
      setUserBubble(text)
      noteUserActive()
      recordTurn('user', text)
      window.setTimeout(() => {
        setUserBubble((u) => (u === text ? null : u))
      }, 6000)
      return 'accepted'
    }
    if (phase !== 'idle') return 'busy'
    setUserBubble(text)
    setChatBusy(true)
    setTopActor(who)
    noteUserActive()
    recordTurn('user', text)
    // 应答全程不阻塞受理返回:调用方发完即清输入,应答靠消息落盘订阅实时冒出
    void (async () => {
      try {
        // TurnBatch:默认只由被@角色回答;明确同时问三人才放开三句。生成失败回落单句应答(原行为)
        const groupAsk = /你们|大家|各位|三位|每人|各自|都怎么|都说说/.test(text)
        let batch: DialogLine[] | null = null
        try {
          batch = await generateTurnBatch({ userText: text, target: who, window: chatWindow(), groupAsk })
        } catch {
          batch = null // 静默回落
        }
        if (!batch || batch.length === 0) {
          const reply = await generateUserChatReply(who, text)
          batch = [{ speaker: who, text: reply, action: 'talk' }]
        }
        for (const l of batch) {
          presenterSay(l.speaker, l.text, { action: 'talk', ms: 2200 + l.text.length * 160, speaking: true })
          pulseOther(l.speaker)
          speak(l.speaker, l.text, undefined, 'chat')
          recordTurn(l.speaker, l.text)
          await new Promise((r) => window.setTimeout(r, 2200 + l.text.length * 160))
        }
        window.setTimeout(() => {
          setUserBubble((u) => (u === text ? null : u)) // 应答结束,你说的这句一并收走
        }, 400)
      } catch {
        setUserBubble(null)
        presenterSay(who, '（信号不好，没听清…再说一遍？）', { ms: 2200 })
      } finally {
        setChatBusy(false)
      }
      // 后台记忆提取:不阻塞、失败静默
      void (async () => {
        try {
          const mem = await getMemory()
          const known = topFacts(mem, 8)
          const candidates = await extractFacts(text, known)
          if (candidates.length > 0) await mergeFacts(candidates)
        } catch {
          // 静默
        }
      })()
    })()
    return 'accepted'
  }

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

  /** 手动锁定主题:立即落盘 + 按新主题预生成一单(旧缓冲保留,无主题时照常消费) */
  function applyTopic(topic: string) {
    const norm = topic.trim()
    setTopicOverride(norm)
    closeOverlay('topic')
    void saveConfig({ topicOverride: norm }).catch((e) => console.warn('主题保存失败(静默)', e))
    if (norm) director.rearmPrefetch(mode, norm)
  }

  /** 清除主题,回到话题池随机 */
  function clearTopic() {
    setTopicOverride(null)
    closeOverlay('topic')
    void saveConfig({ topicOverride: null }).catch((e) => console.warn('主题清除失败(静默)', e))
    director.rearmPrefetch(mode, null) // 重新随机补一单
  }

  /** 退出程序:两段确认的"已武装"态在 SettingsWindow 内,这里只真正关窗 */
  function requestExit() {
    void getCurrentWindow().close()
  }

  /** 连戳计数(60s 滑动窗口),决定反应强度 */
  const pokeCounts = useRef<Record<Speaker, number[]>>({ A: [], B: [], C: [] })
  const improvLastAt = useRef(0)

  function poke(who: Speaker) {
    noteUserActive()
    setTopActor(who)
    bumpPoke() // 行为信号:互动频率

    // 正在说话的角色被戳:忘词/指责打断(本地即时,优先于连戳分级)
    if (phase === 'performing' && speaking === who) {
      showPoke(who, react(who, 'interrupt'), 'surprise', 2200)
      void logInterrupt(who)
      void notePoked(who)
      return
    }
    void logInteraction(who === 'A' ? 'pokeA' : who === 'B' ? 'pokeB' : 'pokeC')
    void notePoked(who)

    // 连戳分级:滑动窗口计数,生气期内不再响应
    const now = Date.now()
    const arr = (pokeCounts.current[who] = pokeCounts.current[who].filter(
      (t) => now - t < POKE_WINDOW_MS,
    ))
    const count = arr.length + 1
    // 丙走团宠专属池(台词包优先),甲乙保持互怼语气池
    const pools = who === 'C'
      ? { poke: [packLine('poke', cPokeLines())], shy: cShyLines(), angry: cAngryLines() }
      : { poke: POKE_LINES, shy: SHY_LINES, angry: ANGRY_LINES }
    if (count >= ANGRY_AT) {
      arr.push(now)
      showPoke(who, pools.angry[Math.floor(Math.random() * pools.angry.length)], 'angry', 2000)
      scheduleHype(who)
      return
    }
    arr.push(now)
    const shy = count >= SHY_AT
    const fallback = shy
      ? pools.shy[Math.floor(Math.random() * pools.shy.length)]
      : pools.poke[Math.floor(Math.random() * pools.poke.length)]
    const fallbackAction = shy ? 'shy' : Math.random() < 0.3 ? 'laugh' : 'talk'

    // 轻戳小概率走 LLM 即兴(冷却内/演出生成中不触发);失败静默用固定台词。
    // C 不参与即兴:她的台词由每日台词包+存档+预置池闭环供给,来源可预期
    if (
      who !== 'C' &&
      !shy &&
      phase === 'idle' &&
      Math.random() < IMPROV_CHANCE &&
      now - improvLastAt.current >= IMPROV_COOLDOWN_MS
    ) {
      improvLastAt.current = now
      improvPokeLine(who, director.recentLines())
        .then((line) => {
          // 返回时已超窗或开始正式演出 → 丢弃,防止顶掉台词气泡
          if (Date.now() - now >= 4500) return
          if (phaseRef.current !== 'idle' || director.isPlaying()) return
          showPoke(who, line, 'talk', 2200)
        })
        .catch(() => {
          if (phaseRef.current !== 'idle' || director.isPlaying()) return
          showPoke(who, fallback, fallbackAction)
        })
      // 先给一个占位反应,LLM 返回后替换
      showPoke(who, '（被戳得一激灵）', 'surprise', 1200)
      scheduleHype(who)
      return
    }
    showPoke(who, fallback, fallbackAction)
    scheduleHype(who)
  }

  /** 戳团宠时另一角色延迟起哄:甲乙是"同伙",三人舞台感。
   *  只在空闲时插话,触发时再次校验阶段,不顶掉演出台词 */
  function scheduleHype(who: Speaker) {
    if (who !== 'C' || Math.random() >= TEASE_HYPE_CHANCE) return
    const other: Speaker = Math.random() < 0.5 ? 'A' : 'B'
    window.setTimeout(() => {
      if (phaseRef.current !== 'idle' || director.isPlaying()) return
      showPoke(other, teaseHypeLines()[Math.floor(Math.random() * teaseHypeLines().length)], 'laugh', 2000)
    }, 1100)
  }

  // ---------- 角色C 互动:摸头长按 / 右键点播 / 投喂 ----------
  // 都是轻量即时反应(本地动画+台词),不进 interactionStore 账本(与"拖拽不是冒犯"
  // 同一原则);台词包(dailyLinePack)优先,内置池兜底。

  /** 摸头连摸窗口(60s):第 3 次起害羞 */
  const HEADPAT_SHY_AT = 3
  const headpatTimes = useRef<number[]>([])
  function headpatC() {
    noteUserActive()
    setTopActor('C')
    bumpPoke()
    const now = Date.now()
    const arr = headpatTimes.current = headpatTimes.current.filter((t) => now - t < POKE_WINDOW_MS)
    arr.push(now)
    const shy = arr.length >= HEADPAT_SHY_AT
    const line = shy
      ? cHeadpatShyLines()[Math.floor(Math.random() * cHeadpatShyLines().length)]
      : packLine('headpat', cHeadpatLines())
    showPoke('C', line, 'headpat', 2200)
  }

  /** 投喂:5 分钟窗口内喂 3 次即吃撑,冷却 60s(冷却期内再点仍是撑) */
  const FEED_WINDOW_MS = 5 * 60_000
  const FEED_FULL_AT = 3
  const FEED_FULL_COOLDOWN_MS = 60_000
  const feedTimes = useRef<number[]>([])
  const feedFullUntil = useRef(0)
  function feedC() {
    noteUserActive()
    setTopActor('C')
    bumpPoke()
    const now = Date.now()
    if (now < feedFullUntil.current) {
      showPoke('C', cStuffedLines()[Math.floor(Math.random() * cStuffedLines().length)], 'stuffed', 2200)
      return
    }
    const arr = feedTimes.current = feedTimes.current.filter((t) => now - t < FEED_WINDOW_MS)
    arr.push(now)
    if (arr.length >= FEED_FULL_AT) {
      feedFullUntil.current = now + FEED_FULL_COOLDOWN_MS
      showPoke('C', cStuffedLines()[Math.floor(Math.random() * cStuffedLines().length)], 'stuffed', 2400)
      return
    }
    // 按当下时段/季节端点心:早上早餐、午间午餐、夏天冷饮、冬天火锅(与待机时段池同口味)
    showPoke('C', packLine('feed', cFeedLines()), snackActionNow(), 2600)
  }

  // 空闲 3 分钟无互动 → 角色打瞌睡(sleepy);任何互动/演出/面板恢复
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

      {/* C 右键点播菜单:锚在右键位置,轻交互浮层(点击项经原生钩子派发) */}
      {cMenuOpen && !charHidden && cEnabled && (
        <div
          ref={cMenuRef}
          className="mode-menu c-menu"
          style={{ left: cMenuPos.current.x, top: cMenuPos.current.y }}
        >
          {cMenuActions.map((a) => (
            <button
              key={a.id}
              className="mode-menu-item"
              onClick={() => {
                closeOverlay('c-menu')
                runCMenuAction(a.run)
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
            <span>聊天主题</span>
            {topicOverride && (
              <button className="panel-btn" onClick={clearTopic}>
                清除主题（回到随机）
              </button>
            )}
          </div>
          <input
            className="topic-search"
            value={topicQuery}
            placeholder="搜索内置话题,或输入自定义主题…"
            onChange={(e) => setTopicQuery(e.target.value)}
          />
          <div className="topic-list">
            {topicQuery.trim() === '' && (
              <div className="topic-empty">输入关键词搜索,或直接点下方话题</div>
            )}
            {topicQuery.trim() !== '' &&
              !TOPIC_SEEDS.some((t) => t.includes(topicQuery.trim())) && (
                <button
                  className="topic-item"
                  onClick={() => applyTopic(topicQuery)}
                >
                  用『{topicQuery.trim()}』作为话题
                </button>
              )}
            {TOPIC_SEEDS.filter((t) => t.includes(topicQuery.trim())).map((t) => (
              <button
                key={t}
                className={`topic-item${topicOverride === t ? ' on' : ''}`}
                onClick={() => applyTopic(t)}
              >
                {t}
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
        onContextMenu={(e) => e.preventDefault()}
      >
        <Bubble
          text={bubble.A}
          speaker="A"
          below={charCfg.A.bottom + charCfg.height > window.innerHeight - 110}
          loud={loudBubble.A}
          tailSide={aFacesLeft ? 'left' : 'right'}
          action={displayAction('A')}
          delivery={delivery.A}
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
        onContextMenu={(e) => e.preventDefault()}
      >
        <Bubble
          text={bubble.B}
          speaker="B"
          below={charCfg.B.bottom + charCfg.height > window.innerHeight - 110}
          loud={loudBubble.B}
          tailSide={bFacesLeft ? 'left' : 'right'}
          action={displayAction('B')}
          delivery={delivery.B}
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
          openCMenu(e.clientX, e.clientY)
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
                disabled={chatBusy || phase !== 'idle' || !chatDraft.trim()}
                title={phase !== 'idle' ? '演出/生成进行中,稍后再说' : ''}
                onClick={() => void sendUserChat()}
              >
                {chatBusy ? '…' : '发送'}
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

        {/* C 已是常驻身体,台词气泡在角色头顶;仅在设置里禁用 C 时回落画外音横幅 */}
        {bubble.C && !cEnabled && (
          <div className="guest-bubble">
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

        {/* 完播评价条:锚在工具栏正上方,一键 👍/👎/★。面板开着时不现身——
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
          onDismiss={dismissRating}
        />

        <UtilityCards />

        {captureShot && (
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
        )}

        {translationOpen && (
          <TranslationPanel
            innerRef={trPanelRef}
            pos={ctrlBar}
            inject={trInject}
            onClose={() => closeOverlay('translation')}
            onScreenshotTranslate={startScreenshotFlow}
            onTranslated={translateQuip}
            onState={onTranslateState}
          />
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
  )
}

export default App
