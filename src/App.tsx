import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { CharacterSprite } from './stage/CharacterSprite'
import { Bubble } from './stage/Bubble'
import { EyeIcon, EyeOffIcon, PlayIcon, StopIcon, GearIcon, PowerIcon, TargetIcon } from './stage/icons'
import { SPRITE_SETS, preloadSprites } from './stage/spriteSets'
import {
  initPointerManager,
  registerHitRegion,
  onHoverChange,
} from './input/pointerManager'
import {
  PerformancePlayer,
  type DialogLine,
  type Speaker,
} from './performer/player'
import { MODES, modeList, modeOf, type Mode } from './performer/modes'
import { generateDialog, describeLlmError } from './engine/llmClient'
import { speak, prefetchVoice, stopSpeaking, VOICES } from './engine/tts'
import { prefetchNext } from './engine/dialogPrefetch'
import { TOPIC_SEEDS, pickTopic } from './engine/topicSeeds'
import { VENDORS, CUSTOM_VENDOR_ID, vendorIdOfBaseUrl } from './engine/vendors'
import { takePrefetch } from './storage/prefetchStore'
import { appendHistory, loadRecentHistory, listEpisodes, deleteEpisodes, toggleFavorite, type Episode } from './storage/historyStore'
import {
  getConfig,
  saveConfig,
  DEFAULT_CONFIG,
  type AppConfig,
  type CharactersConfig,
  type CharPos,
  type CtrlBarPos,
} from './storage/configStore'
import './App.css'

// 点击反应台词池（后续可改为 LLM 即兴生成）
const POKE_LINES = [
  '干嘛点我！',
  '再点要收费了！',
  '诶嘿嘿~',
  '别闹，正聊着呢',
  '摸鱼被发现了？！',
  '（默默挪开半步）',
]

type Phase = 'idle' | 'generating' | 'performing'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** apiKeys 的存储键:预设厂商用 id,自定义端点按 baseUrl 区分(与 configStore 注释约定一致) */
function vendorKeyOf(id: string, baseUrl: string): string {
  return id === CUSTOM_VENDOR_ID ? `custom:${baseUrl.trim()}` : id
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function App() {
  const [hovered, setHovered] = useState<string | null>(null)
  const [reacting, setReacting] = useState<Record<Speaker, boolean>>({
    A: false,
    B: false,
  })
  const [bubble, setBubble] = useState<Record<Speaker, string | null>>({
    A: null,
    B: null,
  })
  const [action, setAction] = useState<Record<Speaker, string>>({
    A: 'idle',
    B: 'idle',
  })
  const [phase, setPhase] = useState<Phase>('idle')
  // 分段选择器当前选中模式；生成按钮按它点播
  const [mode, setMode] = useState<Mode>('daily')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [form, setForm] = useState<AppConfig>(DEFAULT_CONFIG)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  // 设置面板分页:常规 / 历史
  const [settingsTab, setSettingsTab] = useState<'general' | 'history'>('general')
  // 设置面板当前选中的厂商(custom = 本地/自定义,baseUrl/model 自由输入)
  const [vendorId, setVendorId] = useState(CUSTOM_VENDOR_ID)
  // 面板内各厂商 key 的草稿:切换厂商时把输入存回旧键、从新键带出,保存时合并落盘
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  // 手动锁定主题;null = 随机。主题面板弹/收与搜索词
  const [topicOverride, setTopicOverride] = useState<string | null>(null)
  const [topicOpen, setTopicOpen] = useState(false)
  const [topicQuery, setTopicQuery] = useState('')
  // 空闲自动重放:频率来自配置,activeTick 用于用户互动后重置计时
  const [autoReplayMin, setAutoReplayMin] = useState(DEFAULT_CONFIG.autoReplayMin)
  const [activeTick, setActiveTick] = useState(0)
  const [episodes, setEpisodes] = useState<Episode[]>([])
  // 角色布局(位置各自独立/缩放共享)与隐藏开关;ref 供拖动/滚轮事件读最新值
  const [charCfg, setCharCfg] = useState<CharactersConfig>(DEFAULT_CONFIG.characters)
  const charCfgRef = useRef(charCfg)
  const [charHidden, setCharHidden] = useState(DEFAULT_CONFIG.charactersHidden)
  const charSaveTimer = useRef(0)
  // 退出两段确认:第一次点亮,3 秒内再点才真正退出
  const [exitArmed, setExitArmed] = useState(false)
  const exitTimer = useRef(0)
  // 控制栏位置(可拖动);ref 供拖动事件读最新值
  const [ctrlBar, setCtrlBar] = useState<CtrlBarPos>(DEFAULT_CONFIG.ctrlBar)
  const ctrlBarRef = useRef(ctrlBar)
  const ctrlBarTimer = useRef(0)
  const ctrlDragRef = useRef<{ startX: number; startY: number; orig: CtrlBarPos; moved: boolean } | null>(null)
  // 左上角水印开关
  const [showWatermark, setShowWatermark] = useState(DEFAULT_CONFIG.showWatermark)
  // 角色语音配置(开关 + 双角色音色,改即落盘)
  const [voice, setVoice] = useState(DEFAULT_CONFIG.voice)
  // 使用者的兴趣爱好(设置面板填写,随机话题时按模式概率介入)
  const [userInterests, setUserInterests] = useState(DEFAULT_CONFIG.userInterests)
  // 最近交互的角色显示在上层(z-order)
  const [topActor, setTopActor] = useState<Speaker>('A')
  // 活人感:当前说话者/听者惊讶脉冲/拖动落地回弹/拖动中的角色
  const [speaking, setSpeaking] = useState<Speaker | null>(null)
  const [pulseFor, setPulseFor] = useState<Speaker | null>(null)
  const pulseTimer = useRef(0)
  const [dropFor, setDropFor] = useState<Speaker | null>(null)
  const dropTimer = useRef(0)
  const [dragUi, setDragUi] = useState<Speaker | null>(null)
  const dragRef = useRef<{ who: Speaker; startX: number; startY: number; orig: CharPos; moved: boolean } | null>(null)
  const draggingWho = useRef<Speaker | null>(null)

  const charA = useRef<HTMLDivElement>(null)
  const charB = useRef<HTMLDivElement>(null)
  const segCtl = useRef<HTMLDivElement>(null)
  const btnGen = useRef<HTMLButtonElement>(null)
  const btnStop = useRef<HTMLButtonElement>(null)
  const btnGear = useRef<HTMLButtonElement>(null)
  const btnEye = useRef<HTMLButtonElement>(null)
  const btnTopic = useRef<HTMLButtonElement>(null)
  const btnExit = useRef<HTMLButtonElement>(null)
  const gripRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const topicPanelRef = useRef<HTMLDivElement>(null)
  const timers = useRef<Record<Speaker, number>>({ A: 0, B: 0 })

  // 演出播放器：LLM 生成的 DialogLine[] 与硬编码脚本走同一条路
  const player = useRef<PerformancePlayer | null>(null)
  // 当前正在播放的台词数组,供 onLine 回调预合成下一句语音
  const playingLines = useRef<DialogLine[]>([])
  if (!player.current) {
    player.current = new PerformancePlayer({
      onLine: (line, index) => {
        setBubble((b) => ({ ...b, [line.speaker]: line.text }))
        setAction((a) => ({ ...a, [line.speaker]: line.action || 'talk' }))
        setSpeaking(line.speaker)
        speak(line.speaker, line.text) // 语音失败静默,不影响气泡
        const next = playingLines.current[index + 1]
        if (next) prefetchVoice(next.speaker, next.text)
        // 台词带感叹/问号 → 听者惊讶脉冲
        const listener: Speaker = line.speaker === 'A' ? 'B' : 'A'
        if (/[!?！？]/.test(line.text)) {
          setPulseFor(listener)
          window.clearTimeout(pulseTimer.current)
          pulseTimer.current = window.setTimeout(() => setPulseFor(null), 600)
        }
      },
      onLineEnd: (speaker) => {
        setBubble((b) => ({ ...b, [speaker]: null }))
        setAction((a) => ({ ...a, [speaker]: 'idle' }))
        setSpeaking(null)
      },
      onDone: () => {
        setPhase('idle')
        setSpeaking(null)
      },
    })
  }
  const generateAbort = useRef<AbortController | null>(null)
  // 上一段台词（内存中），续播时喂给 LLM 做衔接
  const lastLines = useRef<DialogLine[]>([])
  // 上一次自动重放的集,连续重放时避开
  const lastReplayTs = useRef(0)

  useEffect(() => {
    void initPointerManager()
    preloadSprites(Object.values(SPRITE_SETS)) // 预热立绘,演出中切换动作零延迟
    void getConfig().then((c) => {
      setAutoReplayMin(c.autoReplayMin)
      applyChars(c.characters)
      setCharHidden(c.charactersHidden)
      setTopicOverride(c.topicOverride)
      applyCtrlBar(c.ctrlBar)
      setShowWatermark(c.showWatermark)
      setVoice(c.voice)
      setUserInterests(c.userInterests)
    })
    // 启动恢复：读最近历史，续集生成时衔接上次聊到的内容
    void loadRecentHistory(20).then((entries) => {
      if (entries.length > 0) {
        lastLines.current = entries.map(({ ts: _ts, mode: _m, ...l }) => l)
      }
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
      }),
      registerHitRegion('charB', {
        getRect: () =>
          draggingWho.current === 'B'
            ? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
            : charB.current!.getBoundingClientRect(),
      }),
      registerHitRegion('eye', {
        getRect: () => btnEye.current!.getBoundingClientRect(),
      }),
      registerHitRegion('modes', {
        getRect: () => segCtl.current!.getBoundingClientRect(),
      }),
      registerHitRegion('gen', {
        getRect: () => btnGen.current!.getBoundingClientRect(),
      }),
      registerHitRegion('stop', {
        getRect: () => btnStop.current!.getBoundingClientRect(),
      }),
      registerHitRegion('settings', {
        getRect: () => btnGear.current!.getBoundingClientRect(),
      }),
      registerHitRegion('topic', {
        getRect: () => btnTopic.current!.getBoundingClientRect(),
      }),
      registerHitRegion('exit', {
        getRect: () => btnExit.current!.getBoundingClientRect(),
      }),
      registerHitRegion('grip', {
        getRect: () => gripRef.current!.getBoundingClientRect(),
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // 设置面板打开期间整体可命中（否则穿透窗口里输入框点不进去）
  useEffect(() => {
    if (!settingsOpen) return
    return registerHitRegion('panel', {
      getRect: () =>
        panelRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
    })
  }, [settingsOpen])

  // 主题面板打开期间整体可命中
  useEffect(() => {
    if (!topicOpen) return
    return registerHitRegion('topic-panel', {
      getRect: () =>
        topicPanelRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
    })
  }, [topicOpen])

  // Escape 关闭任一打开的面板
  useEffect(() => {
    if (!settingsOpen && !topicOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsOpen(false)
        setTopicOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, topicOpen])

  /** 播放指定的一集(自动重放与历史行点击共用):不调 LLM、不写历史 */
  function playEpisode(ep: Episode) {
    generateAbort.current?.abort() // 若有生成在途,直接作废
    player.current!.stop()
    stopSpeaking()
    lastReplayTs.current = ep.ts
    lastLines.current = ep.lines // 衔接后续手动生成
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })
    setPhase('performing')
    playingLines.current = ep.lines
    player.current!.play(ep.lines, { gap: modeOf(ep.mode).gap })
  }

  /** 加权随机抽一集历史重放(收藏权重 5):不调 LLM、不写历史 */
  async function autoReplay() {
    if (player.current!.playing) return
    const eps = await listEpisodes(100)
    if (eps.length === 0) return
    const pool = eps.length > 1 ? eps.filter((e) => e.ts !== lastReplayTs.current) : eps
    const bag: Episode[] = []
    for (const e of pool) {
      for (let i = 0; i < (e.fav ? 5 : 1); i++) bag.push(e)
    }
    const ep = bag[Math.floor(Math.random() * bag.length)]
    playEpisode(ep)
  }

  /** 点击历史行:关闭面板并回放该集 */
  function replayFromHistory(ep: Episode) {
    setSettingsOpen(false)
    playEpisode(ep)
  }

  /** 空闲自动重放:仅在没有生成/演出、没开设置面板、角色未隐藏时计时;任何依赖变化都会重置计时 */
  useEffect(() => {
    if (phase !== 'idle' || settingsOpen || charHidden || autoReplayMin <= 0) return
    const t = window.setTimeout(() => void autoReplay(), autoReplayMin * 60_000)
    return () => window.clearTimeout(t)
  }, [phase, settingsOpen, charHidden, autoReplayMin, activeTick])

  /** 单次点播：优先消费预生成(秒开,使用后移入 history);
   *  未命中则生成当前轮,开播后后台再静默预生成下一轮(共两轮) */
  async function playMode(m: Mode) {
    // 未配置 API Key:不进生成流程,气泡引导去设置
    const { apiKey } = await getConfig()
    if (!apiKey.trim()) {
      setBubble({ A: '还没填 API Key,点 ⚙ 去设置里填一下~', B: null })
      setAction({ A: 'surprise', B: 'idle' })
      window.setTimeout(() => {
        setBubble((b) => (b.A?.startsWith('还没填') ? { A: null, B: null } : b))
        setAction((a) => ({ ...a, A: 'idle' }))
      }, 2600)
      return
    }

    generateAbort.current?.abort()
    player.current!.stop()
    stopSpeaking()
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })

    // 主题:手动锁定 > 按模式概率聊使用者兴趣 > 话题池随机
    const fixedTopic = topicOverride
    const interests = userInterests.split(/[,，、;；\n]/).map((x) => x.trim()).filter(Boolean)
    const actualTopic =
      fixedTopic ??
      (interests.length > 0 && Math.random() < (modeOf(m).interestTopicChance ?? 0)
        ? `使用者感兴趣的事:${interests[Math.floor(Math.random() * interests.length)]}`
        : pickTopic(modeOf(m)))

    // 预生成命中:有主题时只取同主题条目,无主题时 FIFO 任意条目
    const hit = await takePrefetch(m, fixedTopic ?? undefined)
    if (hit) {
      lastLines.current = hit.lines
      void appendHistory(hit.lines, hit.mode, hit.topic) // 使用后移入 history(fire-and-forget)
      setPhase('performing')
      playingLines.current = hit.lines
      player.current!.play(hit.lines, { gap: modeOf(hit.mode).gap })
      void prefetchNext(m, hit.lines, fixedTopic ?? undefined) // 补货下一轮(静默)
      return
    }

    // 未命中：生成当前轮
    setPhase('generating')
    const ctrl = new AbortController()
    generateAbort.current = ctrl
    const topic = actualTopic
    try {
      const lines = await generateDialog(m, topic, lastLines.current, ctrl.signal, fixedTopic != null)
      if (ctrl.signal.aborted) return
      lastLines.current = lines
      void appendHistory(lines, m, topic) // 落盘（fire-and-forget，失败不阻断演出）
      setPhase('performing')
      playingLines.current = lines
      player.current!.play(lines, { gap: MODES[m].gap })
      void prefetchNext(m, lines, fixedTopic ?? undefined) // 请求生成两轮：当前轮 + 后台预生成
    } catch (e) {
      if (ctrl.signal.aborted) return
      console.error('LLM 生成失败，回退硬编码脚本', e)
      lastLines.current = MODES[m].script
      setPhase('performing')
      // 先出提示气泡(带具体原因),短暂停留后再开播,避免被第一句台词立即覆盖
      const reason = await describeLlmError(e)
      if (ctrl.signal.aborted) return
      setBubble({ A: `${reason},先来段内置的~`, B: null })
      window.setTimeout(() => {
        if (ctrl.signal.aborted) return // 停止/切换期间不续播
        setBubble({ A: null, B: null })
        playingLines.current = MODES[m].script
        player.current!.play(MODES[m].script, { gap: MODES[m].gap })
      }, 1800)
    }
  }

  /** 停止一切：中止生成 + 停止演出 + 停语音 + 复位 */
  function stopEverything() {
    generateAbort.current?.abort()
    generateAbort.current = null
    player.current!.stop()
    stopSpeaking()
    setPhase('idle')
    setSpeaking(null)
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })
  }

  /** 打开设置：读当前配置回填表单，加载历史分集 */
  async function openSettings() {
    setSaveState('idle')
    setSettingsOpen(true)
    setTopicOpen(false)
    const cfg = await getConfig()
    setForm(cfg)
    const id = vendorIdOfBaseUrl(cfg.baseUrl)
    setVendorId(id)
    // 各厂商 key 草稿 = 已保存的 apiKeys + 当前生效 key 归位到它的键
    setKeyDrafts({ ...cfg.apiKeys, [vendorKeyOf(id, cfg.baseUrl)]: cfg.apiKey })
    setVoice(cfg.voice)
    setEpisodes(await listEpisodes())
  }

  /** 保存配置：落盘 + 刷新缓存，下一次生成即生效。
   *  apiKeys = 已存值 ∪ 面板草稿 ∪ 当前输入(归位到当前厂商键),各厂商 key 一并持久化 */
  async function saveSettings() {
    setSaveState('saving')
    try {
      const next = await saveConfig({
        ...form,
        apiKeys: {
          ...form.apiKeys,
          ...keyDrafts,
          [vendorKeyOf(vendorId, form.baseUrl)]: form.apiKey,
        },
        voice, // 语音配置(key/音色/开关)与表单一起整体落盘
      })
      setAutoReplayMin(next.autoReplayMin) // 空闲计时按新频率重新武装
      setSaveState('saved')
      window.setTimeout(() => setSettingsOpen(false), 900)
    } catch (e) {
      console.error('配置保存失败', e)
      setSaveState('error')
    }
  }

  async function onToggleFav(ep: Episode) {
    await toggleFavorite(ep)
    setEpisodes(await listEpisodes())
  }

  async function onDeleteEpisode(ep: Episode) {
    await deleteEpisodes(new Set([ep.ts]))
    setEpisodes(await listEpisodes())
  }

  async function onClearUnfavorited() {
    await deleteEpisodes(new Set(episodes.filter((e) => !e.fav).map((e) => e.ts)))
    setEpisodes(await listEpisodes())
  }

  // ---------- 角色布局:拖动移动(各自独立)/ 滚轮缩放(全局一致) ----------

  /** 更新布局;persist='now' 立即落盘,'debounced' 防抖落盘(滚轮连续滚动只写一次) */
  function applyChars(next: CharactersConfig, persist: 'now' | 'debounced' | 'no' = 'no') {
    charCfgRef.current = next
    setCharCfg(next)
    if (persist === 'no') return
    window.clearTimeout(charSaveTimer.current)
    const write = () =>
      saveConfig({ characters: next }).catch((e) => console.warn('布局保存失败(静默)', e))
    if (persist === 'now') void write()
    else charSaveTimer.current = window.setTimeout(write, 500)
  }

  function onCharPointerDown(e: ReactPointerEvent, who: Speaker) {
    setTopActor(who) // 最近交互的角色置顶
    setDragUi(who) // 拎起态(轻微缩小提亮)
    dragRef.current = {
      who,
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...charCfgRef.current[who] },
      moved: false,
    }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // 合成事件/指针已释放时无活动指针可捕获,忽略
    }
  }

  function onCharPointerMove(e: ReactPointerEvent, who: Speaker) {
    const d = dragRef.current
    if (!d || d.who !== who) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 6) return // 小位移视为点击,留给戳一戳
      d.moved = true
      draggingWho.current = who
    }
    const cur = charCfgRef.current
    applyChars(
      {
        ...cur,
        [who]: {
          xPct: Math.min(97, Math.max(3, d.orig.xPct + (dx / window.innerWidth) * 100)),
          bottom: Math.min(
            Math.max(0, window.innerHeight - 80),
            Math.max(0, d.orig.bottom - dy),
          ),
        },
      },
      'no',
    )
  }

  function onCharPointerUp(who: Speaker) {
    const d = dragRef.current
    dragRef.current = null
    setDragUi(null)
    if (!d || d.who !== who) return
    if (d.moved) {
      draggingWho.current = null
      applyChars(charCfgRef.current, 'now')
      setDropFor(who) // 落地 squash 回弹
      window.clearTimeout(dropTimer.current)
      dropTimer.current = window.setTimeout(() => setDropFor(null), 500)
    } else {
      poke(who) // 原地点一下 = 戳一戳
    }
  }

  function onCharWheel(e: ReactWheelEvent) {
    const cur = charCfgRef.current
    const maxHeight = Math.max(240, window.innerHeight - 40)
    const height = Math.min(maxHeight, Math.max(140, cur.height + (e.deltaY < 0 ? 12 : -12)))
    if (height === cur.height) return
    applyChars({ ...cur, height }, 'debounced') // 缩放全局一致:两个角色同步
  }

  /** 隐藏/显示角色(立即落盘) */
  function setCharsHidden(v: boolean) {
    setCharHidden(v)
    saveConfig({ charactersHidden: v }).catch((e) => console.warn('显示开关保存失败(静默)', e))
  }

  // ---------- 控制栏位置:按住栏空白处拖动 ----------

  function applyCtrlBar(next: CtrlBarPos, persist: 'now' | 'debounced' | 'no' = 'no') {
    ctrlBarRef.current = next
    setCtrlBar(next)
    if (persist === 'no') return
    window.clearTimeout(ctrlBarTimer.current)
    const write = () =>
      saveConfig({ ctrlBar: next }).catch((e) => console.warn('控制栏位置保存失败(静默)', e))
    if (persist === 'now') void write()
    else ctrlBarTimer.current = window.setTimeout(write, 500)
  }

  function onBarPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    // 只响应把手,按钮/分段控件不受影响
    if (e.target !== e.currentTarget) return
    ctrlDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...ctrlBarRef.current },
      moved: false,
    }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // 无活动指针可捕获时忽略
    }
  }

  function onBarPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = ctrlDragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 6) return // 小位移视为点击,留给收起/展开
      d.moved = true
    }
    applyCtrlBar(
      {
        ...d.orig,
        xPct: Math.min(98, Math.max(2, d.orig.xPct + (dx / window.innerWidth) * 100)),
        top: Math.min(Math.max(0, window.innerHeight - 60), Math.max(0, d.orig.top + dy)),
      },
      'no',
    )
  }

  function onBarPointerUp() {
    const d = ctrlDragRef.current
    ctrlDragRef.current = null
    if (!d) return
    if (d.moved) {
      applyCtrlBar(ctrlBarRef.current, 'now') // 拖动结束:保存位置
    } else {
      // 纯点击:切换收起/展开
      applyCtrlBar({ ...ctrlBarRef.current, collapsed: !ctrlBarRef.current.collapsed }, 'now')
    }
  }

  /** 手动锁定主题:立即落盘 + 按新主题预生成一单(旧缓冲保留,无主题时照常消费) */
  function applyTopic(topic: string) {
    const norm = topic.trim()
    setTopicOverride(norm)
    setTopicOpen(false)
    void saveConfig({ topicOverride: norm }).catch((e) => console.warn('主题保存失败(静默)', e))
    if (norm) void prefetchNext(mode, lastLines.current, norm)
  }

  /** 清除主题,回到话题池随机 */
  function clearTopic() {
    setTopicOverride(null)
    setTopicOpen(false)
    void saveConfig({ topicOverride: null }).catch((e) => console.warn('主题清除失败(静默)', e))
    void prefetchNext(mode, lastLines.current) // 重新随机补一单
  }

  /** 退出程序:两段确认,3 秒内再点一次才真正关闭,防误触 */
  function requestExit() {
    if (exitArmed) {
      void getCurrentWindow().close()
      return
    }
    setExitArmed(true)
    window.clearTimeout(exitTimer.current)
    exitTimer.current = window.setTimeout(() => setExitArmed(false), 3000)
  }

  function poke(who: Speaker) {
    setActiveTick((t) => t + 1) // 用户互动,重置自动重放计时
    setTopActor(who)
    const line = POKE_LINES[Math.floor(Math.random() * POKE_LINES.length)]
    setBubble((b) => ({ ...b, [who]: line }))
    setReacting((r) => ({ ...r, [who]: true }))
    window.clearTimeout(timers.current[who])
    timers.current[who] = window.setTimeout(() => {
      setBubble((b) => ({ ...b, [who]: null }))
      setReacting((r) => ({ ...r, [who]: false }))
    }, 1600)
  }

  const busy = phase === 'generating'

  return (
    <div
      className="stage"
      onPointerDown={(e) => {
        // 点在面板/工具栏之外 → 收起已打开的面板(穿透窗口下 e.target 即 .stage 本体)
        if (e.target === e.currentTarget) {
          setSettingsOpen(false)
          setTopicOpen(false)
        }
      }}
    >
      <div
        className={`ctrl-bar${ctrlBar.collapsed ? ' collapsed' : ''}`}
        style={{ left: `${ctrlBar.xPct}%`, top: ctrlBar.top }}
      >
        <span
          ref={gripRef}
          className={`bar-grip${hovered === 'grip' ? ' hot' : ''}`}
          title={ctrlBar.collapsed ? '展开工具栏(点击)/拖动移动' : '收起工具栏(点击)/拖动移动'}
          onPointerDown={onBarPointerDown}
          onPointerMove={onBarPointerMove}
          onPointerUp={onBarPointerUp}
        >
          ⠿
        </span>
        <div ref={segCtl} className={`seg${hovered === 'modes' ? ' hot' : ''}`}>
          <div
            className="seg-thumb"
            style={{
              width: `calc(${100 / modeList.length}% - 3px)`,
              transform: `translateX(${modeList.findIndex((m) => m.id === mode) * 100}%)`,
            }}
          />
          {modeList.map((m) => (
            <button
              key={m.id}
              className={`seg-btn${mode === m.id ? ' on' : ''}`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <button
          ref={btnGen}
          className={`ctrl-btn icon${hovered === 'gen' ? ' hot' : ''}${busy ? ' loading' : ''}`}
          disabled={busy}
          title="生成"
          onClick={() => void playMode(mode)}
        >
          <PlayIcon />
        </button>

        <button
          ref={btnStop}
          className={`ctrl-btn icon${hovered === 'stop' ? ' hot' : ''}${phase !== 'idle' ? ' danger' : ''}`}
          disabled={phase === 'idle'}
          title="停止"
          onClick={stopEverything}
        >
          <StopIcon />
        </button>

        <button
          ref={btnGear}
          className={`ctrl-btn icon gear${hovered === 'settings' ? ' hot' : ''}${settingsOpen ? ' on' : ''}`}
          title="设置"
          onClick={() => (settingsOpen ? setSettingsOpen(false) : void openSettings())}
        >
          <GearIcon />
        </button>

        <button
          ref={btnEye}
          className={`ctrl-btn icon${hovered === 'eye' ? ' hot' : ''}`}
          title={charHidden ? '显示角色' : '隐藏角色'}
          onClick={() => setCharsHidden(!charHidden)}
        >
          {charHidden ? <EyeOffIcon /> : <EyeIcon />}
        </button>

        <button
          ref={btnTopic}
          className={`ctrl-btn icon${hovered === 'topic' ? ' hot' : ''}${topicOverride ? ' on' : ''}`}
          title={topicOverride ? `话题：${topicOverride}` : '设置聊天主题'}
          onClick={() => (topicOpen ? setTopicOpen(false) : (setSettingsOpen(false), setTopicOpen(true)))}
        >
          <TargetIcon />
        </button>

        <button
          ref={btnExit}
          className={`ctrl-btn icon${hovered === 'exit' ? ' hot' : ''}${exitArmed ? ' danger armed' : ''}`}
          title={exitArmed ? '再点一次确认退出' : '退出程序'}
          onClick={requestExit}
        >
          {exitArmed ? '确认退出?' : <PowerIcon />}
        </button>
      </div>

      {settingsOpen && (
        <div ref={panelRef} className="settings-panel">
          <div className="panel-head">
            <div className="panel-tabs">
              <button
                className={`panel-tab${settingsTab === 'general' ? ' on' : ''}`}
                onClick={() => setSettingsTab('general')}
              >
                常规
              </button>
              <button
                className={`panel-tab${settingsTab === 'history' ? ' on' : ''}`}
                onClick={() => setSettingsTab('history')}
              >
                历史
              </button>
            </div>
          </div>
          {settingsTab === 'general' && (
            <>
          <div className="settings-row">
            <label htmlFor="cfg-vendor">厂商</label>
            <select
              id="cfg-vendor"
              value={vendorId}
              onChange={(e) => {
                const id = e.target.value
                // 当前输入的 key 存回旧厂商的键,再从新厂商的键带出(没有则空)
                const drafts = { ...keyDrafts, [vendorKeyOf(vendorId, form.baseUrl)]: form.apiKey }
                setKeyDrafts(drafts)
                setVendorId(id)
                let baseUrl = form.baseUrl
                let model = form.model
                if (id !== CUSTOM_VENDOR_ID) {
                  const v = VENDORS.find((x) => x.id === id)!
                  baseUrl = v.baseUrl
                  model = v.models[0] ?? ''
                }
                setForm({
                  ...form,
                  baseUrl,
                  model,
                  apiKey: drafts[vendorKeyOf(id, baseUrl)] ?? '',
                })
              }}
            >
              {VENDORS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
              <option value={CUSTOM_VENDOR_ID}>本地 / 自定义</option>
            </select>
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-key" title="每个厂商(自定义按接口地址)分别记忆,切换自动带出">
              API Key{vendorId === CUSTOM_VENDOR_ID ? '(本地服务可为空)' : ''}
            </label>
            <input
              id="cfg-key"
              type="password"
              value={form.apiKey}
              onChange={(e) => {
                setForm({ ...form, apiKey: e.target.value })
                setKeyDrafts((d) => ({ ...d, [vendorKeyOf(vendorId, form.baseUrl)]: e.target.value }))
              }}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-url">接口地址</label>
            <input
              id="cfg-url"
              value={form.baseUrl}
              placeholder={
                vendorId === CUSTOM_VENDOR_ID ? 'http://localhost:11434/v1' : 'https://api.deepseek.com/v1'
              }
              onChange={(e) => {
                // 自定义端点键含 baseUrl:先把 key 存回旧地址的键,换地址互不串
                const drafts = { ...keyDrafts, [vendorKeyOf(vendorId, form.baseUrl)]: form.apiKey }
                setKeyDrafts(drafts)
                setForm({ ...form, baseUrl: e.target.value })
              }}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-model">模型</label>
            {vendorId === CUSTOM_VENDOR_ID ? (
              <input
                id="cfg-model"
                value={form.model}
                placeholder="如 qwen2.5:7b(Ollama 模型名)"
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
            ) : (
              <select
                id="cfg-model"
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              >
                {(VENDORS.find((v) => v.id === vendorId)?.models ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-show">显示角色</label>
            <input
              id="cfg-show"
              type="checkbox"
              checked={!charHidden}
              onChange={(e) => setCharsHidden(!e.target.checked)}
            />
          </div>
          <div className="settings-row">
            <div className="settings-hint">拖动角色可移动 · 悬停滚轮缩放(两角色同步)</div>
            <button
              className="panel-btn"
              onClick={() => {
                applyChars(DEFAULT_CONFIG.characters, 'now')
                applyCtrlBar(DEFAULT_CONFIG.ctrlBar, 'now')
              }}
            >
              恢复默认布局
            </button>
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-replay">空闲自动重放(分钟,留空 = 关闭)</label>
            <input
              id="cfg-replay"
              type="number"
              min={1}
              max={1440}
              step={1}
              placeholder="留空则不自动重放"
              value={form.autoReplayMin || ''}
              onChange={(e) => {
                const raw = e.target.value
                // 空串/非法输入按 0(关闭)存,不往输入框里塞 0 硬占位
                setForm({ ...form, autoReplayMin: raw.trim() === '' ? 0 : Math.max(0, Number(raw) || 0) })
              }}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-interests">使用者的兴趣爱好(选填,逗号分隔)</label>
            <textarea
              id="cfg-interests"
              rows={2}
              value={form.userInterests}
              placeholder="如:摄影,健身,玩unity,听周杰伦 — 日常闲聊会偶尔聊到"
              onChange={(e) => setForm({ ...form, userInterests: e.target.value })}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-mark">显示左上角水印</label>
            <input
              id="cfg-mark"
              type="checkbox"
              checked={showWatermark}
              onChange={(e) => {
                setShowWatermark(e.target.checked)
                saveConfig({ showWatermark: e.target.checked }).catch((err) =>
                  console.warn('水印开关保存失败(静默)', err),
                )
              }}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-voice">角色语音(硅基流动)</label>
            <input
              id="cfg-voice"
              type="checkbox"
              checked={voice.enabled}
              onChange={(e) => {
                const next = { ...voice, enabled: e.target.checked }
                setVoice(next)
                saveConfig({ voice: next }).catch((err) =>
                  console.warn('语音开关保存失败(静默)', err),
                )
              }}
            />
          </div>
          {voice.enabled && (
            <>
              <div className="settings-row">
                <label htmlFor="cfg-voice-key" title="siliconflow.cn 的 API Key,与上方 LLM 的 key 相互独立">
                  语音 API Key
                </label>
                <input
                  id="cfg-voice-key"
                  type="password"
                  placeholder="sk-...(siliconflow.cn)"
                  value={voice.apiKey}
                  onChange={(e) => setVoice({ ...voice, apiKey: e.target.value })}
                  onBlur={(e) => {
                    const next = { ...voice, apiKey: e.target.value }
                    saveConfig({ voice: next }).catch((err) =>
                      console.warn('语音 key 保存失败(静默)', err),
                    )
                  }}
                />
              </div>
              <div className="settings-row">
                <label htmlFor="cfg-voice-a">角色甲音色</label>
                <select
                  id="cfg-voice-a"
                  value={voice.A}
                  onChange={(e) => {
                    const next = { ...voice, A: e.target.value }
                    setVoice(next)
                    saveConfig({ voice: next }).catch((err) =>
                      console.warn('音色保存失败(静默)', err),
                    )
                  }}
                >
                  {VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-row">
                <label htmlFor="cfg-voice-b">角色乙音色</label>
                <select
                  id="cfg-voice-b"
                  value={voice.B}
                  onChange={(e) => {
                    const next = { ...voice, B: e.target.value }
                    setVoice(next)
                    saveConfig({ voice: next }).catch((err) =>
                      console.warn('音色保存失败(静默)', err),
                    )
                  }}
                >
                  {VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          <div className="settings-actions">
            <button className="panel-btn" onClick={() => setSettingsOpen(false)}>
              取消
            </button>
            <button
              className="panel-btn primary"
              disabled={saveState === 'saving'}
              onClick={() => void saveSettings()}
            >
              {saveState === 'saving' ? '保存中…' : '保存'}
            </button>
          </div>
          {saveState === 'saved' && (
            <div className="settings-tip ok">✓ 已保存，下次生成即生效</div>
          )}
          {saveState === 'error' && (
            <div className="settings-tip err">保存失败，详见控制台日志</div>
          )}
            </>
          )}

          {settingsTab === 'history' && (
            <>
          <div className="settings-sep">
            <span>历史记录（{episodes.length}）</span>
            <button
              className="hist-clear"
              disabled={episodes.every((e) => e.fav) || episodes.length === 0}
              onClick={() => void onClearUnfavorited()}
            >
              清空未收藏
            </button>
          </div>
          <div className="hist-list">
            {episodes.length === 0 && (
              <div className="hist-empty">还没有历史对话，点 ▶ 生成一集试试</div>
            )}
            {episodes.map((ep) => {
              const bm = modeOf(ep.mode)
              return (
                <div
                  className="hist-row"
                  key={ep.ts}
                  title="点击回放此段"
                  onClick={() => replayFromHistory(ep)}
                >
                  <span className="hist-mode" style={{ background: bm.accent }}>
                    {bm.label}
                  </span>
                  <div className="hist-main">
                    <div className="hist-preview">{ep.lines[0]?.text ?? ''}</div>
                    <div className="hist-meta">
                      {fmtTime(ep.ts)} · {ep.lines.length} 句
                      {ep.topic ? ` · ${ep.topic}` : ''}
                    </div>
                  </div>
                  <button
                    className={`hist-fav${ep.fav ? ' on' : ''}`}
                    title={ep.fav ? '取消收藏' : '收藏（不会被删除，重放权重更高）'}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onToggleFav(ep)
                    }}
                  >
                    {ep.fav ? '★' : '☆'}
                  </button>
                  <button
                    className="hist-del"
                    title={ep.fav ? '收藏对话不可删除' : '删除此段'}
                    disabled={ep.fav}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onDeleteEpisode(ep)
                    }}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
            </>
          )}
        </div>
      )}

      {topicOpen && (
        <div ref={topicPanelRef} className="settings-panel topic-panel">
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
            autoFocus
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
        {bubble.A && <Bubble text={bubble.A} below={charCfg.A.bottom + charCfg.height > window.innerHeight - 110} />}
        <CharacterSprite
          ref={charA}
          sprite={SPRITE_SETS.A}
          heightOverride={charCfg.height}
          action={action.A}
          talkDuration={bubble.A ? 0.3 + Math.min(0.7, bubble.A.length * 0.04) : undefined}
          lean={speaking === 'B' ? (charCfg.A.xPct <= charCfg.B.xPct ? 'right' : 'left') : undefined}
          listening={speaking === 'B'}
          pulsing={pulseFor === 'A'}
          dropped={dropFor === 'A'}
          dragging={dragUi === 'A'}
          hot={hovered === 'charA'}
          reacting={reacting.A}
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
        {bubble.B && <Bubble text={bubble.B} below={charCfg.B.bottom + charCfg.height > window.innerHeight - 110} />}
        <CharacterSprite
          ref={charB}
          sprite={SPRITE_SETS.B}
          heightOverride={charCfg.height}
          action={action.B}
          talkDuration={bubble.B ? 0.3 + Math.min(0.7, bubble.B.length * 0.04) : undefined}
          lean={speaking === 'A' ? (charCfg.B.xPct <= charCfg.A.xPct ? 'right' : 'left') : undefined}
          listening={speaking === 'A'}
          pulsing={pulseFor === 'B'}
          dropped={dropFor === 'B'}
          dragging={dragUi === 'B'}
          hot={hovered === 'charB'}
          reacting={reacting.B}
        />
      </div>

      {showWatermark && (
        <div className="watermark">
          M5 · 空闲自动重放历史 · 选模式点 ▶ 生成一集
        </div>
      )}
    </div>
  )
}

export default App
