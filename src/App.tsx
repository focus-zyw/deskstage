import { useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { CharacterSprite } from './stage/CharacterSprite'
import { Bubble } from './stage/Bubble'
import { startScreenshot, applyScreenshotHotkey } from './capture'
import { setCharacterNames, setPersonaOverride } from './engine/persona'
import { startEnvPolling } from './engine/envAware'
import { setCaptureMode, initPointerManager, registerHitRegion, onHoverChange } from './input/pointerManager'
import { CaptureOverlay } from './CaptureOverlay'
import { SPRITE_SETS, preloadSprites } from './stage/spriteSets'
import type { DialogLine, Speaker } from './performer/player'
import type { Mode } from './performer/modes'
import { generateShortChat, generateTurnBatch, improvPokeLine, generateUserChatReply, extractFacts, memoReminderLine } from './engine/llmClient'
import { pushTurn, chatWindow } from './dialogue/turnWindow'
import { react } from './engine/interactionRules'
import { logInteraction, logInterrupt, resetDismissals } from './storage/interactionStore'
import { noteActivity } from './runtime/proactiveScheduler'
import { speak } from './engine/tts'
import { TOPIC_SEEDS } from './engine/topicSeeds'
import { bumpPoke, getMemory, topFacts, mergeFacts } from './storage/memoryStore'
import { getDueMemos, addMemo, updateMemo } from './storage/memoStore'
import { type Episode } from './storage/historyStore'
import { TranslationPanel, type TranslationInject } from './translation/TranslationPanel'
import { extractTextFromClipboard } from './translation/ocr'
import { startLiveSession, stopLiveSession, type LiveReply } from './runtime/liveDanmaku'
import { CommandPanel } from './ui/CommandPanel'
import { ChoicePanel } from './ui/ChoicePanel'
import type { Command } from './features/commands/commands'
import {
  useRuntime,
  getCaps,
  beginStreaming,
  beginCapture,
  endCapture,
  openOverlayExclusive,
  closeOverlay,
  closeAllOverlays,
  setDnd as setRuntimeDnd,
  setCharHidden as setRuntimeCharHidden,
} from './runtime/runtimeMode'
import { runUtilityTask, useUtilityTasks } from './runtime/utilityTasks'
import { showProp, dismissProps, clearProps } from './runtime/propEffects'
import { preloadProps } from './stage/props'
import { StageProps } from './stage/StageProps'
import { useCharacterLayout } from './stage/useCharacterLayout'
import { usePerformanceDirector } from './runtime/usePerformanceDirector'
import { useActorPresenter } from './stage/useActorPresenter'
import { ControlBar } from './ui/ControlBar'
import { UtilityCards } from './ui/UtilityCard'
import {
  getConfig,
  saveConfig,
  useConfigSnapshot,
} from './storage/configStore'
import { applyLaunchOnBoot } from './runtime/launchOnBoot'
import { useOverlayHitRegions } from './runtime/useOverlayHitRegion'
import { SettingsWindow } from './settings/SettingsWindow'
import type { SettingsBridge } from './settings/useSettingsSession'
import type { SettingsTab } from './settings/settingsCatalog'
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
  // 分段选择器当前选中模式；生成按钮按它点播
  const [mode, setMode] = useState<Mode>('daily')
  const settingsOpen = rt.overlays.includes('settings')
  // 配置事实源:读同一份已落盘配置(任何 saveConfig 成功后即时发布),不再各自维护镜像
  const config = useConfigSnapshot()
  const charNames = { A: config.names.a, B: config.names.b }
  const showWatermark = config.showWatermark
  // 聊天通道:输入框开合/草稿/应答中;用户气泡(区别于角色气泡)
  const chatOpen = rt.overlays.includes('chat')
  const [chatDraft, setChatDraft] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [userBubble, setUserBubble] = useState<string | null>(null)
  const lastChatTarget = useRef<Speaker>('A')
  // 翻译面板:开合由 runtime overlays 管;OCR 链路注入的原文(auto=截图翻译入口,填入即自动翻)
  const translationOpen = rt.overlays.includes('translation')
  const toolsOpen = rt.overlays.includes('tools')
  const overlaysOpen = rt.overlays.length > 0
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
  const panelRef = useRef<HTMLDivElement>(null)
  // 备忘提醒卡容器:热区 getter 用;声明在使用(useMemo 依赖)之前,避免 TDZ
  const memoAlertsRef = useRef<HTMLDivElement>(null)
  const memoAlertsCountRef = useRef(0)
  const topicPanelRef = useRef<HTMLDivElement>(null)
  const chatBoxRef = useRef<HTMLDivElement>(null)
  const cmdPanelRef = useRef<HTMLDivElement>(null)
  const choicePanelRef = useRef<HTMLDivElement>(null)

  // phase 的 ref 镜像:异步回调(LLM 返回)里判断此刻是否仍空闲
  const phaseRef = useRef(phase)

  // 角色舞台布局:拖动/缩放/落盘/距离演出(呈现与戳一戳回调注入)
  const {
    charCfg, ctrlBar, topActor, setTopActor, dragUi, dropFor,
    charA, charB, draggingWho, applyChars, applyCtrlBar, resetLayout,
    onCharPointerDown, onCharPointerMove, onCharPointerUp, onCharWheel,
  } = useCharacterLayout({
    isIdle: () => phaseRef.current === 'idle',
    present: showPoke,
    onPoke: poke,
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
  })
  const { choice } = director

  /** 插话呈现(气泡+动作+到期回收):戳一戳/引导语/报错的统一入口 */
  function showPoke(who: 'A' | 'B', line: string, action: string, ms = 1600, loud = false) {
    presenterSay(who, line, { action, ms, loud, reacting: true })
  }

  // phase 的 ref 镜像:异步回调(LLM 返回)里判断此刻是否仍空闲
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

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
    return () => {
      void start.then((f) => f())
      void fail.then((f) => f())
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

  // ---------- 主播模式:直播弹幕互动 ----------

  /** 弹幕回复呈现:复用聊天通道的气泡+动作+TTS 节奏(stream 通道) */
  function presentLiveReply(r: LiveReply) {
    setTopActor(r.speaker) // 呈现者置顶:气泡与道具不被另一角色压住
    presenterSay(r.speaker, r.text, { action: r.action || 'talk', ms: 2200 + r.text.length * 160, speaking: true })
    pulse(r.speaker === 'A' ? 'B' : 'A')
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
    { id: 'topic', label: '设置聊天主题', keywords: ['话题', '主题'], run: () => openOverlayExclusive('topic') },
    { id: 'toggle-chars', label: charHidden ? '显示角色' : '隐藏角色', keywords: ['隐藏角色', '显示角色'], run: () => setCharsHidden(!charHidden) },
    { id: 'crosstalk', label: '来一段相声', keywords: ['相声'], run: () => performNow('crosstalk') },
    { id: 'daily', label: '来一段日常', keywords: ['日常', '段子'], run: () => performNow('daily') },
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
    preloadProps() // 预热道具 SVG,首次礼物/工具流程不闪
    void getConfig().then((c) => {
      applyChars(c.characters)
      setRuntimeCharHidden(c.charactersHidden)
      setRuntimeDnd(c.dnd) // 勿扰状态进运行时(工具栏按钮/TTS 同步)
      setTopicOverride(c.topicOverride)
      applyCtrlBar(c.ctrlBar)
      // 截屏:应用全局快捷键 + 按配置把本窗口从系统级屏幕捕获中排除
      void applyScreenshotHotkey()
      void invoke('set_capture_excluded', { enable: c.screenshot.hideSelf }).catch(() => {})
      // 用户自定义角色名:先应用(名牌与台词称呼)
      setCharacterNames(c.names.a, c.names.b)
      // 用户自定义人设:先应用,后续所有生成即采纳
      setPersonaOverride(c.persona.a, c.persona.b)
      // 环境感知:按配置低频轮询本机状态(电量/前台应用分类等)
      if (c.envSense) startEnvPolling()
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
          id: 'panel',
          active: settingsOpen,
          activatesWindow: true,
          getRect: () =>
            panelRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
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
        },
      ],
      [settingsOpen, topicOpen, chatOpen, translationOpen, toolsOpen, choice, overlaysOpen],
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

  function replayFromHistory(ep: Episode) {
    closeOverlay('settings')
    director.replay(ep, 'manual')
  }

  /** 聊天通道:解析 @角色 → TurnBatch(被@角色先答,另一位有料才补,共 1~3 句) → 顺序播报。
   *  短期会话窗口入列(下轮聊天/演出插话共用);无 @ 时按上次目标轮换;
   *  演出进行中改为入队插话(P4:句尾安全缝反应后接回剧情);抉择等待仍禁发 */
  async function sendUserChat() {
    const text = chatDraft.trim()
    if (!text || chatBusy) return
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const alt = new RegExp(`^\\s*@?(${esc(charNames.A)}|${esc(charNames.B)}|甲|乙|A|B)\\s*`)
    const m = text.match(alt)
    const who: Speaker = m
      ? m[1] === charNames.A || m[1] === 'A'
        ? 'A'
        : 'B'
      : (lastChatTarget.current = lastChatTarget.current === 'A' ? 'B' : 'A')
    if (phase === 'performing') {
      // P4 演出中插话:入队,当前句结束的安全缝处反应并接回剧情
      director.queueInterjection(text, who)
      setUserBubble(text)
      setChatDraft('')
      noteUserActive()
      pushTurn({ who: 'user', text })
      window.setTimeout(() => {
        setUserBubble((u) => (u === text ? null : u))
      }, 6000)
      return
    }
    if (phase !== 'idle') return
    setUserBubble(text)
    setChatDraft('')
    setChatBusy(true)
    setTopActor(who)
    noteUserActive()
    pushTurn({ who: 'user', text })
    try {
      // TurnBatch:被@角色先答,另一位有料才补;生成失败回落单句应答(原行为)
      let batch: DialogLine[] | null = null
      try {
        batch = await generateTurnBatch({ userText: text, target: who, window: chatWindow() })
      } catch {
        batch = null // 静默回落
      }
      if (!batch || batch.length === 0) {
        const reply = await generateUserChatReply(who, text)
        batch = [{ speaker: who, text: reply, action: 'talk' }]
      }
      for (const l of batch) {
        if (l.speaker !== 'A' && l.speaker !== 'B') continue // 校验层已保证,防御兜底
        presenterSay(l.speaker, l.text, { action: 'talk', ms: 2200 + l.text.length * 160, speaking: true })
        pulse(l.speaker === 'A' ? 'B' : 'A')
        speak(l.speaker, l.text, undefined, 'chat')
        pushTurn({ who: l.speaker, text: l.text })
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
  }

  // 命令直达的分页请求(窗口挂载时读取一次;关闭后复位)
  const [settingsTabRequest, setSettingsTabRequest] = useState<SettingsTab>('general')

  /** 打开设置(tab 直达某分页):草稿回填与各页数据由 SettingsWindow 挂载时自取 */
  function openSettings(tab?: SettingsTab) {
    setSettingsTabRequest(tab ?? 'general')
    openOverlayExclusive('settings')
  }
  useEffect(() => {
    if (!settingsOpen) setSettingsTabRequest('general')
  }, [settingsOpen])

  /** 设置窗口的跨模块行为:只经由这三个回调触碰应用其余部分 */
  const settingsBridge: SettingsBridge = {
    onReplay: replayFromHistory,
    onResetLayout: resetLayout,
    onPrivacyTip: showPrivacyTip,
  }

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
          try {
            speak('C', await memoReminderLine(memo.text), undefined, 'proactive')
          } catch {
            speak('C', `叮——该「${memo.text}」了`, undefined, 'proactive')
          }
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

  function poke(who: 'A' | 'B') {
    noteUserActive()
    setTopActor(who)
    bumpPoke() // 行为信号:互动频率

    // 正在说话的角色被戳:忘词/指责打断(本地即时,优先于连戳分级)
    if (phase === 'performing' && speaking === who) {
      showPoke(who, react(who, 'interrupt'), 'surprise', 2200)
      void logInterrupt(who)
      return
    }
    void logInteraction(who === 'A' ? 'pokeA' : 'pokeB')

    // 连戳分级:滑动窗口计数,生气期内不再响应
    const now = Date.now()
    const arr = (pokeCounts.current[who] = pokeCounts.current[who].filter(
      (t) => now - t < POKE_WINDOW_MS,
    ))
    const count = arr.length + 1
    if (count >= ANGRY_AT) {
      arr.push(now)
      showPoke(who, ANGRY_LINES[Math.floor(Math.random() * ANGRY_LINES.length)], 'angry', 2000)
      return
    }
    arr.push(now)
    const shy = count >= SHY_AT
    const fallback = shy
      ? SHY_LINES[Math.floor(Math.random() * SHY_LINES.length)]
      : POKE_LINES[Math.floor(Math.random() * POKE_LINES.length)]
    const fallbackAction = shy ? 'shy' : Math.random() < 0.3 ? 'laugh' : 'talk'

    // 轻戳小概率走 LLM 即兴(冷却内/演出生成中不触发);失败静默用固定台词
    if (
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
      return
    }
    showPoke(who, fallback, fallbackAction)
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

  return (
    <div
      className="stage"
      onPointerDown={(e) => {
        // 点在面板/工具栏之外 → 收起已打开的面板(穿透窗口下 e.target 即 .stage 本体)
        // 录音中点击外部不收面板(防止丢失停止入口)
        if (rt.mode.type === 'recording' && settingsOpen) return
        if (e.target === e.currentTarget) closeAllOverlays()
      }}
    >
      <ControlBar
        pos={ctrlBar}
        onPosChange={applyCtrlBar}
        mode={mode}
        onModeChange={setMode}
        busy={phase === 'generating' || phase === 'performing'}
        canStop={phase !== 'idle'}
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
          if (settingsOpen) closeOverlay('settings')
          else openSettings()
        }}
      />

      {settingsOpen && (
        <SettingsWindow
          innerRef={panelRef}
          bridge={settingsBridge}
          initialTab={settingsTabRequest}
          onExit={requestExit}
        />
      )}

      {topicOpen && (
        <div
          ref={topicPanelRef}
          className="settings-panel topic-panel"
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
      >
        {bubble.A && <Bubble text={bubble.A} below={charCfg.A.bottom + charCfg.height > window.innerHeight - 110} loud={loudBubble.A} />}
        <CharacterSprite
          ref={charA}
          sprite={SPRITE_SETS.A}
          nameOverride={charNames.A}
          heightOverride={charCfg.height}
          flipped={charCfg.B.xPct < charCfg.A.xPct}
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
      >
        {bubble.B && <Bubble text={bubble.B} below={charCfg.B.bottom + charCfg.height > window.innerHeight - 110} loud={loudBubble.B} />}
        <CharacterSprite
          ref={charB}
          sprite={SPRITE_SETS.B}
          nameOverride={charNames.B}
          heightOverride={charCfg.height}
          flipped={charCfg.B.xPct >= charCfg.A.xPct}
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

      {chatOpen && (
          <div
            ref={chatBoxRef}
            className="chat-box"
            style={{ left: `${ctrlBar.xPct}%`, top: ctrlBar.top + 46 }}
          >
            {userBubble && <div className="user-bubble">你说:{userBubble}</div>}
            <div className="chat-row">
              <input
                type="text"
                placeholder="和角色说话…(@甲/@乙 指定谁回)"
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => {
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

        {bubble.C && (
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
