import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { readFile, remove } from '@tauri-apps/plugin-fs'
import { CharacterSprite } from './stage/CharacterSprite'
import { Bubble } from './stage/Bubble'
import { EyeIcon, EyeOffIcon, PlayIcon, StopIcon, GearIcon, PowerIcon, TargetIcon, PokeballIcon, ChatIcon, CropIcon } from './stage/icons'
import { startScreenshot, applyScreenshotHotkey } from './capture'
import { startEnvPolling, stopEnvPolling, isFullscreenApp, isUserActive } from './engine/envAware'
import { setCaptureMode } from './input/pointerManager'
import { CaptureOverlay } from './CaptureOverlay'
import { SPRITE_SETS, preloadSprites } from './stage/spriteSets'
import {
  initPointerManager,
  registerHitRegion,
  onHoverChange,
} from './input/pointerManager'
import {
  PerformancePlayer,
  type ChoiceOption,
  type ChoicePoint,
  type DialogLine,
  type Speaker,
} from './performer/player'
import { MODES, modeList, modeOf, type Mode } from './performer/modes'
import { generateDialog, generateShortChat, improvPokeLine, describeLlmError, generateUserChatReply, extractFacts, distillStory } from './engine/llmClient'
import { isQuietHours } from './engine/timeAware'
import { react, distanceBands } from './engine/interactionRules'
import { logInteraction, logInterrupt, logDrag } from './storage/interactionStore'
import { speak, prefetchVoice, stopSpeaking, VOICES, cloneVoice, listCustomVoices, type ClonedVoice } from './engine/tts'
import { prefetchNext } from './engine/dialogPrefetch'
import { WEBCHAT_SITES, webchatLogin, webchatProbe, webchatRestoreMain } from './engine/webchat'
import { TOPIC_SEEDS, pickTopic } from './engine/topicSeeds'
import { bumpTopicSeen, bumpTopicFavored, bumpTopicReplays, bumpTopicWatched, bumpTopicSkipped, bumpMode, bumpPoke, getTopicWeights, getMemory, clearMemory, deleteFact, togglePinFact, topFacts, mergeFacts, type MemoryFact } from './storage/memoryStore'
import { getStory, mergeStory, removeArc, removeStoryItem, pickArcBeat, storyInventory, type StoryData } from './storage/storyStore'
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

type Phase = 'idle' | 'generating' | 'performing' | 'choosing'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** 记忆事实分类的中文标签 */
const MEM_CAT_LABEL: Record<string, string> = {
  identity: '身份',
  preference: '喜好',
  habit: '习惯',
  people: '身边人',
  event: '事件',
  other: '其他',
}

/** 语气→说话节奏(秒/循环):deadpan 慢半拍、excited 加速、slow 拖沓;与 TTS 语速同向 */
const DELIVERY_TALK_DUR: Record<string, number> = { deadpan: 1.05, excited: 0.38, slow: 0.9 }

/** 保底收底留白:未走二遍节奏标注的集,最后一句自动补 1s 停顿,给响底包袱留笑的时间 */
function withFinalePause(lines: DialogLine[]): DialogLine[] {
  if (lines.length === 0) return lines
  const last = lines[lines.length - 1]!
  if (last.pauseAfter !== undefined) return lines
  return [...lines.slice(0, -1), { ...last, pauseAfter: 1000 }]
}

/** apiKeys 的存储键:预设厂商用 id,自定义端点按 baseUrl 区分(与 configStore 注释约定一致) */
function vendorKeyOf(id: string, baseUrl: string): string {
  return id === CUSTOM_VENDOR_ID ? `custom:${baseUrl.trim()}` : id
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 音色克隆行:选一段 10~20 秒的清晰人声(说话内容与文本一致),上传后成为账号下的克隆音色。
 *  也支持从正在播放声音的应用直接录一段(进程环回,隔离其他软件声音)。
 *  克隆成功自动选中给角色乙(通常捧哏换个有味道的声线) */
function CloneVoiceRow({
  apiKey,
  onCloned,
  onRecordingChange,
}: {
  apiKey: string
  onCloned: (v: ClonedVoice) => void
  /** 录音状态上报:录音中锁定面板(点外部/Esc 不收起,停止入口不会丢失) */
  onRecordingChange?: (recording: boolean) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle')
  const [errMsg, setErrMsg] = useState('')
  // 应用声音录制:会话列表/选中项/录音状态与计时
  const [sessions, setSessions] = useState<{ pid: number; name: string; playing: boolean }[]>([])
  const [targetFilter, setTargetFilter] = useState('')
  const [target, setTarget] = useState<string>('')
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const recordingRef = useRef(false)
  const togglingRef = useRef(false) // 录音按钮防抖:命令在途时忽略重复点击
  const capturePathRef = useRef<string | null>(null) // 本次录音的 wav 落盘路径(克隆成功后清理)

  /** 删除本次录音的 wav(克隆已用完/面板中途取消) */
  function discardCapture(path: string | null) {
    if (!path) return
    capturePathRef.current = null
    void remove(path).catch(() => {})
  }

  // 计时器 + 卸载保险:面板若在此期间被关闭/卸载,自动停录并丢弃半成品,不留孤儿线程/文件
  useEffect(() => {
    if (!recording) return
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => {
      window.clearInterval(t)
      if (recordingRef.current) {
        void invoke<string>('stop_capture')
          .then((p) => remove(p).catch(() => {}))
          .catch(() => {})
        recordingRef.current = false
        onRecordingChange?.(false)
      }
    }
    // onRecordingChange 是父组件的内联回调,行为恒定;入 deps 会让计时器每帧重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording])

  /** 收尾一次录音:取回文件、复位 UI。手动停止与 180s 自动停共用 */
  async function finishRecording() {
    const path = await invoke<string>('stop_capture') // 同时清掉后端 job,线程已结束时立即返回
    const bytes = await readFile(path)
    capturePathRef.current = path
    setFile(new File([bytes], path.split(/[\\/]/).pop() ?? 'capture.wav', { type: 'audio/wav' }))
    recordingRef.current = false
    setRecording(false)
    onRecordingChange?.(false)
  }

  // 后端录音线程意外结束(设备失效/目标进程异常 → 报错;达到 180s 上限 → 自动停):
  // 把前端拉回一致状态并清后端残留 job。手动停止的正常事件由 toggleRecord 收尾,这里跳过
  useEffect(() => {
    const un = listen<{ ok: boolean; path?: string; error?: string; auto: boolean }>(
      'capture-ended',
      (e) => {
        if (!recordingRef.current) return
        if (e.payload.ok && !e.payload.auto) return
        recordingRef.current = false
        setRecording(false)
        onRecordingChange?.(false)
        if (!e.payload.ok) {
          setErrMsg(String(e.payload.error ?? '录音意外结束').slice(0, 120))
          setState('error')
          void invoke('stop_capture').catch(() => {}) // 清残留 job,下次才能再录
          return
        }
        void finishRecording().catch(() => {
          void invoke('stop_capture').catch(() => {})
        })
      },
    )
    return () => {
      void un.then((f) => f())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!apiKey.trim()) return null

  async function refreshSessions() {
    try {
      const list = await invoke<{ pid: number; name: string; playing: boolean }[]>('list_audio_sessions')
      setSessions(list)
    } catch (e) {
      console.warn('应用声音会话列表拉取失败', e)
    }
  }

  async function toggleRecord() {
    if (togglingRef.current) return // 命令在途,防双击造成"已有录音/没有录音"误报
    togglingRef.current = true
    try {
      if (!recording) {
        try {
          await invoke('start_capture', {
            pid: target === 'system' || target === '' ? null : Number(target),
          })
          recordingRef.current = true
          setRecording(true)
          onRecordingChange?.(true)
          setElapsed(0)
          discardCapture(capturePathRef.current) // 换新样本,旧录音不再需要
          setFile(null)
        } catch (e) {
          setErrMsg(String(e).slice(0, 120))
          setState('error')
        }
        return
      }
      try {
        await finishRecording()
      } catch (e) {
        recordingRef.current = false
        setRecording(false)
        onRecordingChange?.(false)
        setErrMsg(String(e).slice(0, 120))
        setState('error')
      }
    } finally {
      togglingRef.current = false
    }
  }

  async function submit() {
    if (!file || !name.trim() || !text.trim()) return
    setState('busy')
    try {
      const v = await cloneVoice(apiKey, file, file.name, name.trim(), text.trim())
      discardCapture(capturePathRef.current) // 克隆成功,参考录音完成使命
      setState('ok')
      onCloned(v)
    } catch (e) {
      setState('error')
      setErrMsg((e as Error).message.slice(0, 120))
    }
  }

  return (
    <div className="settings-row clone-row" title="用一段真人录音克隆专属音色:内容需与文本一致,清晰无背景音乐">
      <label htmlFor="cfg-clone-file">克隆音色(选人声样本,或从应用录一段)</label>
      <div className="clone-fields">
        <input
          id="cfg-clone-file"
          type="file"
          accept="audio/*"
          onChange={(e) => {
            discardCapture(capturePathRef.current) // 改选手动文件,之前录的不再需要
            setFile(e.target.files?.[0] ?? null)
          }}
        />
        <div className="capture-fields">
          <input
            type="text"
            placeholder="过滤应用名…"
            value={targetFilter}
            onChange={(e) => setTargetFilter(e.target.value)}
          />
        </div>
        <div className="capture-fields">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onFocus={() => void refreshSessions()}
          >
            <option value="system">整个系统的声音</option>
            {sessions
              .filter((s) => s.name.toLowerCase().includes(targetFilter.toLowerCase()))
              .map((s) => (
                <option key={s.pid} value={String(s.pid)}>
                  {s.playing ? '🔊 ' : ''}
                  {s.name}
                </option>
              ))}
          </select>
          <button
            className="panel-btn"
            disabled={state === 'busy'}
            onClick={() => void toggleRecord()}
          >
            {recording ? `停止录制 (${elapsed}s)` : target === 'system' ? '录制系统' : '录制该应用'}
          </button>
        </div>
        {recording && (
          <span className="clone-tip warn">录音中:去目标应用播放声音即可;面板已锁定,点停止后恢复正常</span>
        )}
        {file && (
          <span className="clone-tip ok">
            样本:{file.name}({Math.round(file.size / 1024)}KB)
            {file.size < 100_000 && ' · 偏小:确认目标应用真的在发声、录满 10~20 秒再停'}
          </span>
        )}
        <input
          type="text"
          placeholder="音色名(如:up主小张)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          placeholder="录音里说的那句话(逐字)"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="panel-btn"
          disabled={!file || !name.trim() || !text.trim() || state === 'busy'}
          onClick={() => void submit()}
        >
          {state === 'busy' ? '上传中…' : '克隆'}
        </button>
      </div>
      {state === 'ok' && <span className="clone-tip ok">✓ 克隆成功,已选给角色乙</span>}
      {state === 'error' && <span className="clone-tip err">{errMsg}</span>}
    </div>
  )
}

/** 全局快捷键录入器:点击进入录入态,按下带修饰键的组合键即完成,Esc 取消。
 *  输出为 global-shortcut 接受的格式(Ctrl+Alt+A 这类);必须带修饰键,防止单键误占 */
function HotkeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [listening, setListening] = useState(false)
  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setListening(false)
        return
      }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return // 等主键
      const mods: string[] = []
      if (e.ctrlKey) mods.push('Ctrl')
      if (e.altKey) mods.push('Alt')
      if (e.shiftKey) mods.push('Shift')
      if (e.metaKey) mods.push('Super')
      if (mods.length === 0) {
        setListening(false) // 无修饰键的组合不收,防误占普通按键
        return
      }
      const main = e.key.length === 1 ? e.key.toUpperCase() : e.key
      onChange(`${mods.join('+')}+${main}`)
      setListening(false)
    }
    // 捕获阶段拦下,避免 Escape 冒泡把设置面板关掉
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listening, onChange])
  return (
    <button className="panel-btn" onClick={() => setListening(true)}>
      {listening ? '按下组合键…(Esc 取消)' : value || '未设置'}
    </button>
  )
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
  // 台词语气(delivery):驱动 sprite 修饰类与说话节奏
  const [delivery, setDelivery] = useState<Record<Speaker, string | undefined>>({
    A: undefined,
    B: undefined,
  })
  const [phase, setPhase] = useState<Phase>('idle')
  // 分段选择器当前选中模式；生成按钮按它点播
  const [mode, setMode] = useState<Mode>('daily')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [form, setForm] = useState<AppConfig>(DEFAULT_CONFIG)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  // 设置面板分页:常规 / 语音 / 记忆 / 历史
  const [settingsTab, setSettingsTab] = useState<'general' | 'voice' | 'memory' | 'history'>('general')
  // 记忆系统的机器事实列表(设置"记忆"页展示/管理)
  const [memoryFacts, setMemoryFacts] = useState<MemoryFact[]>([])
  const [clearMemArmed, setClearMemArmed] = useState(false)
  // 角色世界(两人之间的老梗/未了结事件),记忆页展示管理
  const [storyData, setStoryData] = useState<StoryData | null>(null)
  // 聊天通道:输入框开合/草稿/应答中;用户气泡(区别于角色气泡)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatDraft, setChatDraft] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [userBubble, setUserBubble] = useState<string | null>(null)
  const lastChatTarget = useRef<Speaker>('A')
  // 语音录制进行中:面板锁定(点外部/Esc/齿轮均不收起,防止丢失停止入口)
  const voiceRecording = useRef(false)
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
  // 网页版生成:窗口/就绪状态的一行展示文本
  const [webchatStatusText, setWebchatStatusText] = useState('')
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
  // 账号下的克隆音色(打开设置时拉取),供音色下拉选择
  const [clonedVoices, setClonedVoices] = useState<ClonedVoice[]>([])
  // 使用者的兴趣爱好(设置面板填写,随机话题时按模式概率介入)
  // 最近交互的角色显示在上层(z-order)
  const [topActor, setTopActor] = useState<Speaker>('A')
  // 活人感:当前说话者/听者惊讶脉冲/拖动落地回弹/拖动中的角色
  const [speaking, setSpeaking] = useState<Speaker | null>(null)
  const [pulseFor, setPulseFor] = useState<Speaker | null>(null)
  const pulseTimer = useRef(0)
  const [dropFor, setDropFor] = useState<Speaker | null>(null)
  const dropTimer = useRef(0)
  // 中途抉择:choice 点暂停后等待观众站队;30s 未选自动随机
  const [choice, setChoice] = useState<ChoicePoint | null>(null)
  const choiceTimer = useRef(0)
  const pendingEpisode = useRef<{ before: DialogLine[]; after: Record<string, DialogLine[]>; mode: Mode; topic: string; chosen?: string } | null>(null)
  // 中途抉择:choice 点暂停后等待观众站队;30s 未选自动随机
  const [dragUi, setDragUi] = useState<Speaker | null>(null)
  const finaleTimer = useRef(0)
  // 远距离喊话:气泡加大加粗
  const [loudBubble, setLoudBubble] = useState<Record<Speaker, boolean>>({ A: false, B: false })
  const distLastAt = useRef<Record<string, number>>({})
  // 时间感知:启动问候 + 空闲自发短聊天
  const [spontTick, setSpontTick] = useState(0)
  const phaseRef = useRef(phase)
  const lastSpontAt = useRef(0)
  const greeted = useRef(false)
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
  const btnShot = useRef<HTMLButtonElement>(null)
  const btnChat = useRef<HTMLButtonElement>(null)
  const btnExit = useRef<HTMLButtonElement>(null)
  const gripRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const topicPanelRef = useRef<HTMLDivElement>(null)
  const chatBoxRef = useRef<HTMLDivElement>(null)
  const timers = useRef<Record<Speaker, number>>({ A: 0, B: 0 })

  // 演出播放器：LLM 生成的 DialogLine[] 与硬编码脚本走同一条路
  const player = useRef<PerformancePlayer | null>(null)
  // 当前正在播放的台词数组,供 onLine 回调预合成下一句语音
  const playingLines = useRef<DialogLine[]>([])
  if (!player.current) {
    player.current = new PerformancePlayer({
      onLine: (line, index) => {
        setBubble((b) => ({ ...b, [line.speaker]: line.text }))
        // 台词在笑 → 用大笑表情(LLM 词表有 laugh 时直接命中,否则启发式兜底)
        const laughing = /哈哈+|嘿嘿|嘻嘻|笑死|233/.test(line.text)
        const act = laughing ? 'laugh' : line.action || 'talk'
        setAction((a) => ({ ...a, [line.speaker]: act }))
        setSpeaking(line.speaker)
        setDelivery((d) => ({ ...d, [line.speaker]: line.delivery }))
        if (nowPlaying.current) nowPlaying.current.index = index
        speak(line.speaker, line.text, line.delivery) // 语音失败静默,不影响气泡
        const next = playingLines.current[index + 1]
        if (next) prefetchVoice(next.speaker, next.text, next.delivery)
        // 听者同步反应:LLM 指定听者动作(害羞/大笑/欲言又止…),对手戏更活
        const listener: Speaker = line.speaker === 'A' ? 'B' : 'A'
        const la = line.listenerAction
        if (la) setAction((a) => ({ ...a, [listener]: la }))
        // 台词带感叹/问号 → 听者惊讶脉冲
        if (/[!?！？]/.test(line.text)) {
          setPulseFor(listener)
          window.clearTimeout(pulseTimer.current)
          pulseTimer.current = window.setTimeout(() => setPulseFor(null), 600)
        }
      },
      onLineEnd: (speaker) => {
        const listener: Speaker = speaker === 'A' ? 'B' : 'A'
        setBubble((b) => ({ ...b, [speaker]: null }))
        // 双方回 idle:说话者收声,听者的反应动作也不滞留到下一拍
        setAction((a) => ({ ...a, [speaker]: 'idle', [listener]: 'idle' }))
        setDelivery((d) => ({ ...d, [speaker]: undefined }))
        setSpeaking(null)
      },
      onChoice: (cp) => {
        setChoice(cp)
        setPhase('choosing')
      },
      onDone: () => {
        // 选边集:播完(含所选分支)后补记后半段历史
        const p = pendingEpisode.current
        if (p?.chosen) {
          const branchLines = p.after[p.chosen] ?? []
          if (branchLines.length) void appendHistory(branchLines, p.mode, p.topic)
          nowPlaying.current = { topic: p.topic, lines: branchLines, total: branchLines.length, index: -1, source: 'gen' }
        }
        pendingEpisode.current = null
        setPhase('idle')
        setSpeaking(null)
        setDelivery({ A: undefined, B: undefined })
        // 看完一集 = 弱正信号;自动重放是系统行为不计偏好,防"系统自播→自我强化"污染
        const np = nowPlaying.current
        if (np && np.source !== 'auto') bumpTopicWatched(np.topic)
        // 新生成的集自然播完后才蒸馏角色世界:没看完不记,回放不重复蒸馏
        if (np && np.source === 'gen' && np.lines) void distillStoryFrom(np.lines)
        nowPlaying.current = null
        // 收底拍:响底台词与表情定格 2.6s 给观众笑的时间,然后全员放松回 idle
        window.clearTimeout(finaleTimer.current)
        finaleTimer.current = window.setTimeout(() => {
          setAction({ A: 'idle', B: 'idle' })
          setBubble({ A: null, B: null })
        }, 2600)
      },
    })
  }
  const generateAbort = useRef<AbortController | null>(null)
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
      setCaptureShot(String(payload))
    })
    const fail = listen('capture-error', ({ payload }) => {
      const msg = String(payload).slice(0, 50)
      setBubble({ A: `截图失败:${msg}`, B: null })
      window.setTimeout(() => {
        setBubble((b) => (b.A?.startsWith('截图失败') ? { A: null, B: null } : b))
      }, 5000)
    })
    return () => {
      void start.then((f) => f())
      void fail.then((f) => f())
    }
  }, [])


  // 看视频不被打扰:默认点击不抢焦点(WS_EX_NOACTIVATE);
  // 仅设置/主题面板打开时临时恢复激活(输入框需要键盘),关闭即恢复
  useEffect(() => {
    void invoke('set_noactivate', { enable: !(settingsOpen || topicOpen || chatOpen || !!captureShot) }).catch(() => {})
  }, [settingsOpen, topicOpen, chatOpen, captureShot])
  // 上一段台词（内存中），续播时喂给 LLM 做衔接
  const lastLines = useRef<DialogLine[]>([])
  // 上一次自动重放的集,连续重放时避开
  const lastReplayTs = useRef(0)
  // 正在播出的集:话题/台词/进度/信号来源,供完播/跳过记账与完播后蒸馏(auto 重放不计)
  const nowPlaying = useRef<{
    topic?: string
    lines?: DialogLine[]
    total: number
    index: number
    source: 'auto' | 'manual' | 'gen'
  } | null>(null)

  useEffect(() => {
    void initPointerManager()
    preloadSprites(Object.values(SPRITE_SETS)) // 预热立绘,演出中切换动作零延迟
    void getConfig().then((c) => {
      setForm(c) // form 与磁盘配置同步:兴趣/画像等在播放流程里也会读,不能等打开设置才回填
      setAutoReplayMin(c.autoReplayMin)
      applyChars(c.characters)
      setCharHidden(c.charactersHidden)
      setTopicOverride(c.topicOverride)
      applyCtrlBar(c.ctrlBar)
      setShowWatermark(c.showWatermark)
      setVoice(c.voice)
      // 截屏:应用全局快捷键 + 按配置把本窗口从系统级屏幕捕获中排除
      void applyScreenshotHotkey()
      void invoke('set_capture_excluded', { enable: c.screenshot.hideSelf }).catch(() => {})
      // 环境感知:按配置低频轮询本机状态(电量/前台应用分类等)
      if (c.envSense) startEnvPolling()
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
      // 聊天按钮必须注册热区:穿透架构下未注册区域收不到任何鼠标事件,
      // 漏注册 = 入口彻底点不到(此前聊天入口即因此失效)
      registerHitRegion('shot', {
        getRect: () => btnShot.current!.getBoundingClientRect(),
      }),
      registerHitRegion('chat', {
        getRect: () => btnChat.current!.getBoundingClientRect(),
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

  // 聊天框打开期间整体可命中(输入框/发送按钮可点)
  useEffect(() => {
    if (!chatOpen) return
    return registerHitRegion('chat-box', {
      getRect: () =>
        chatBoxRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
    })
  }, [chatOpen])

  // 任一面板打开时注册全屏兜底热区:穿透窗口里面板外的屏幕点击也能送达 DOM,
  // "点外部收起"才生效。注册顺序在最后 → hitTest 先命中面板/工具栏/角色等小热区,
  // 只有落在它们之外的光标才会命中 outside
  useEffect(() => {
    if (!settingsOpen && !topicOpen && !chatOpen) return
    return registerHitRegion('outside', {
      getRect: () => new DOMRect(0, 0, window.innerWidth, window.innerHeight),
    })
  }, [settingsOpen, topicOpen, chatOpen])

  // Escape 关闭任一打开的面板(语音录制中锁定:先停止录制才能关闭)
  useEffect(() => {
    if (!settingsOpen && !topicOpen && !chatOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (voiceRecording.current && settingsOpen) return
        setSettingsOpen(false)
        setTopicOpen(false)
        setChatOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, topicOpen, chatOpen])

  /** 播放指定的一集(自动重放与历史行点击共用):不调 LLM、不写历史 */
  function playEpisode(ep: Episode, source: 'auto' | 'manual') {
    generateAbort.current?.abort() // 若有生成在途,直接作废
    player.current!.stop()
    stopSpeaking()
    lastReplayTs.current = ep.ts
    lastLines.current = ep.lines // 衔接后续手动生成
    // 仅手动回放是口味正反馈;空闲自动重放是系统行为,计进去会让权重自我强化
    if (source === 'manual') bumpTopicReplays(ep.topic)
    nowPlaying.current = { topic: ep.topic, lines: ep.lines, total: ep.lines.length, index: -1, source }
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })
    setPhase('performing')
    playingLines.current = ep.lines
    player.current!.play(withFinalePause(ep.lines), { gap: modeOf(ep.mode).gap })
  }

  /** 加权随机抽一集历史重放(收藏权重 5):不调 LLM、不写历史 */
  async function autoReplay() {
    if (player.current!.playing) return
    if (isFullscreenApp()) return // 用户在全屏应用(视频/游戏/演示)里,别打扰
    const eps = await listEpisodes(100)
    // 读历史(可能数百 ms)期间用户点了生成/聊天 → 不抢场
    if (phaseRef.current !== 'idle' || player.current!.playing) return
    if (eps.length === 0) return
    const pool = eps.length > 1 ? eps.filter((e) => e.ts !== lastReplayTs.current) : eps
    const bag: Episode[] = []
    for (const e of pool) {
      for (let i = 0; i < (e.fav ? 5 : 1); i++) bag.push(e)
    }
    const ep = bag[Math.floor(Math.random() * bag.length)]
    playEpisode(ep, 'auto')
  }

  /** 点击历史行:关闭面板并回放该集 */
  function replayFromHistory(ep: Episode) {
    setSettingsOpen(false)
    playEpisode(ep, 'manual')
  }

  /** 空闲自动重放:仅在没有生成/演出、没开面板/聊天框、角色未隐藏时计时;任何依赖变化都会重置计时 */
  useEffect(() => {
    if (phase !== 'idle' || settingsOpen || chatOpen || charHidden || autoReplayMin <= 0) return
    const t = window.setTimeout(() => void autoReplay(), autoReplayMin * 60_000)
    return () => window.clearTimeout(t)
  }, [phase, settingsOpen, chatOpen, charHidden, autoReplayMin, activeTick])

  /** 观众选边:播对应分支并补记历史;30s 未选由 effect 自动随机 */
  function pickOption(option: ChoiceOption) {
    window.clearTimeout(choiceTimer.current)
    setChoice(null)
    setPhase('performing')
    if (pendingEpisode.current) pendingEpisode.current.chosen = option.id
    playingLines.current = pendingEpisode.current?.after[option.id] ?? []
    nowPlaying.current = {
      topic: pendingEpisode.current?.topic ?? '',
      lines: playingLines.current,
      total: playingLines.current.length,
      index: -1,
      source: 'gen',
    }
    player.current!.resume(option.id)
    try { localStorage.setItem('vc-lastChoice', option.label) } catch { /* ignore */ }
  }

  // 抉择 30s 超时:自动随机选边,防止演出卡死
  useEffect(() => {
    if (phase !== 'choosing' || !choice) return
    const t = window.setTimeout(() => {
      const opt = choice.options[Math.floor(Math.random() * choice.options.length)]
      pickOption(opt)
    }, 30_000)
    return () => window.clearTimeout(t)
  }, [phase, choice])

  /** 播出一段短聊天(问候/自发),计入历史,静默失败;开场先挥手。
   *  短聊天无话题,不参与"看完/跳过"记账,清掉残留避免误记上一集 */
  function playShortChat(lines: DialogLine[]) {
    lastLines.current = lines
    playingLines.current = lines
    nowPlaying.current = null
    setAction({ A: 'wave', B: 'wave' })
    window.setTimeout(() => {
      setPhase('performing')
      player.current!.play(lines, { gap: 700 })
      void appendHistory(lines, 'daily')
    }, 900)
  }

  /** 自发短聊天调度:连续空闲 2.5~5 分钟后尝试一次;各守卫不过就静默跳过 */
  useEffect(() => {
    if (phase !== 'idle' || settingsOpen || topicOpen || chatOpen || charHidden || autoReplayMin <= 0) return
    const t = window.setTimeout(() => void trySpontaneous(), 150_000 + Math.random() * 150_000)
    return () => window.clearTimeout(t)

    async function trySpontaneous() {
      setSpontTick((n) => n + 1) // 本次尝试结束 → 调度 effect 重新武装
      if (phaseRef.current !== 'idle' || player.current!.playing) return
      if (isQuietHours()) return // 凌晨免打扰,角色也该睡觉
      if (isFullscreenApp()) return // 全屏应用(视频/游戏/演示)自动闭麦
      if (autoReplayMin <= 0) return // 用户关了自动内容,自发聊天一并尊重
      const now = Date.now()
      if (now - lastSpontAt.current < 15 * 60_000) return // 最小间隔
      if (Math.random() > 0.4) return // 这次不聊
      const cfg = await getConfig()
      if (!cfg.apiKey.trim()) return
      lastSpontAt.current = now
      try {
        const lines = await generateShortChat('spontaneous', lastLines.current)
        if (phaseRef.current !== 'idle' || player.current!.playing) return
        if (lines.length === 0) return
        playShortChat(lines)
      } catch {
        // 生成失败静默——自发内容宁可错过
      }
    }
  }, [phase, settingsOpen, topicOpen, chatOpen, charHidden, autoReplayMin, activeTick, spontTick])

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
  // 久坐提醒(番茄钟):启用后,连续活跃 X 分钟且中间没歇过,两人用角色口吻提醒;
  // 提醒后重新计时;休息(键鼠空闲≥5分钟)清零。提醒不写历史(不是剧情)
  const workStart = useRef<number | null>(null)
  const lastBreakRemindAt = useRef(0)
  useEffect(() => {
    const t = window.setInterval(() => {
      void (async () => {
        try {
          if (isFullscreenApp()) return // 全屏应用时不提醒
          const cfg = await getConfig()
          if (!cfg.breakReminder.enabled) return
          if (phaseRef.current !== 'idle' || player.current!.playing) return
          if (charHidden) return
          const need = Math.min(120, Math.max(15, cfg.breakReminder.minutes || 45))
          if (!isUserActive()) {
            workStart.current = null // 用户在休息,计时清零
            return
          }
          if (workStart.current === null) workStart.current = Date.now()
          const workedMin = (Date.now() - workStart.current) / 60000
          if (workedMin < need || Date.now() - lastBreakRemindAt.current < 30 * 60_000) return
          lastBreakRemindAt.current = Date.now()
          workStart.current = Date.now()
          const lines = await generateShortChat('break', lastLines.current)
          if (phaseRef.current !== 'idle' || player.current!.playing || lines.length === 0) return
          lastLines.current = lines
          playingLines.current = lines
          setPhase('performing')
          player.current!.play(lines, { gap: 700 })
        } catch {
          // 静默:提醒宁可错过
        }
      })()
    }, 60_000)
    return () => window.clearInterval(t)
  }, [])

  /** 启动问候:打开应用时按当前时段打招呼(失败静默);占用自发聊天的预算 */
  useEffect(() => {
    if (greeted.current) return
    greeted.current = true
    void (async () => {
      const cfg = await getConfig()
      if (!cfg.apiKey.trim()) return
      try {
        const lines = await generateShortChat('greeting', lastLines.current)
        if (phaseRef.current !== 'idle' || player.current!.playing) return
        if (lines.length === 0) return
        lastSpontAt.current = Date.now() - 14 * 60_000 // 问候后约 1 分钟起,自发聊天才可用
        playShortChat(lines)
      } catch {
        // 问候失败静默
      }
    })()
  }, [])

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
    window.clearTimeout(finaleTimer.current)
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })

    // 主题:手动锁定 > 按模式概率聊使用者画像/兴趣 > 话题池随机(雷区过滤+偏好加权)
    const fixedTopic = topicOverride
    const interests = form.userProfile.likes
      .split(/[,，、;；\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
    // 约 30% 概率演出连续剧情的一拍(手动锁定主题时让位)
    const arcBeat = fixedTopic ? null : pickArcBeat((await getStory()).arcs)
    const actualTopic = arcBeat
      ? `连续剧情《${arcBeat.title}》:${arcBeat.hook}`
      : fixedTopic ??
      (interests.length > 0 && Math.random() < (modeOf(m).interestTopicChance ?? 0)
        ? `使用者感兴趣的事:${interests[Math.floor(Math.random() * interests.length)]}`
        : pickTopic(modeOf(m), {
            ban: form.userProfile.banTopics,
            weights: await getTopicWeights(),
          }))
    bumpMode(m)

    // 预生成命中:有主题时只取同主题条目,无主题时 FIFO 任意条目
    const hit = await takePrefetch(m, fixedTopic ?? undefined)
    if (hit) {
      if (!hit.topic.startsWith('连续剧情')) {
        bumpTopicSeen(hit.topic) // 口味记账对齐实际播出的主题(命中缓冲时≠本次抽中的主题)
      }
      nowPlaying.current = { topic: hit.topic, lines: hit.lines, total: hit.lines.length, index: -1, source: 'gen' }
      lastLines.current = hit.lines
      void appendHistory(hit.lines, hit.mode, hit.topic) // 使用后移入 history(fire-and-forget)
      setPhase('performing')
      playingLines.current = hit.lines
      player.current!.play(withFinalePause(hit.lines), { gap: modeOf(hit.mode).gap })
      void prefetchNext(m, hit.lines, fixedTopic ?? undefined) // 补货下一轮(静默)
      return
    }

    // 未命中：生成当前轮(等待期两人进入思考姿势)
    setAction({ A: 'thinking', B: 'thinking' })
    setPhase('generating')
    const ctrl = new AbortController()
    generateAbort.current = ctrl
    const topic = actualTopic
    try {
      const script = await generateDialog(m, topic, lastLines.current, ctrl.signal, fixedTopic != null, arcBeat ?? undefined)
      if (ctrl.signal.aborted) return
      if (!arcBeat) bumpTopicSeen(topic) // 这轮真的播出了才记 seen;剧情线拍不入话题账
      nowPlaying.current = { topic, lines: script.before, total: script.before.length, index: -1, source: 'gen' }
      lastLines.current = script.before
      pendingEpisode.current = { before: script.before, after: script.after, mode: m, topic }
      void appendHistory(script.before, m, topic) // 前半段落盘;选边后半在播完后补记
      setPhase('performing')
      playingLines.current = script.before
      player.current!.play(withFinalePause(script.before), {
        gap: MODES[m].gap,
        choice: script.choice,
        after: Object.fromEntries(
          Object.entries(script.after).map(([id, seg]) => [id, withFinalePause(seg)]),
        ),
      })
      void prefetchNext(m, script.before, fixedTopic ?? undefined) // 请求生成两轮：当前轮 + 后台预生成
    } catch (e) {
      if (ctrl.signal.aborted) return
      console.error('LLM 生成失败，回退硬编码脚本', e)
      lastLines.current = MODES[m].script
      nowPlaying.current = null // 兜底剧本与抽中的话题无关,不参与看完/跳过记账
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
    // 中途按停止 = 负反馈(演过 80% 以上视为看完,不罚);正在生成时无账可记
    const np = nowPlaying.current
    if (np && np.total > 0 && np.index / np.total < 0.8) bumpTopicSkipped(np.topic)
    nowPlaying.current = null
    generateAbort.current?.abort()
    generateAbort.current = null
    player.current!.stop()
    stopSpeaking()
    setPhase('idle')
    setSpeaking(null)
    setDelivery({ A: undefined, B: undefined })
    setChoice(null)
    window.clearTimeout(choiceTimer.current)
    window.clearTimeout(finaleTimer.current)
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })
    setUserBubble(null)
  }

  /** 聊天通道:解析 @角色 → 被指定角色回一句 → 后台提取记忆入库。
   *  无 @ 时甲乙轮换;演出进行中禁发(避免气泡互相打架) */
  async function sendUserChat() {
    const text = chatDraft.trim()
    if (!text || chatBusy || phase !== 'idle') return
    const m = text.match(/^\s*@?(甲|乙|A|B)\s*/)
    const who: Speaker = m
      ? m[1] === '甲' || m[1] === 'A'
        ? 'A'
        : 'B'
      : (lastChatTarget.current = lastChatTarget.current === 'A' ? 'B' : 'A')
    setUserBubble(text)
    setChatDraft('')
    setChatBusy(true)
    setTopActor(who)
    setActiveTick((t) => t + 1)
    try {
      const reply = await generateUserChatReply(who, text)
      setBubble((b) => ({ ...b, [who]: reply }))
      setAction((a) => ({ ...a, [who]: 'talk' }))
      setSpeaking(who)
      speak(who, reply)
      const listener: Speaker = who === 'A' ? 'B' : 'A'
      setPulseFor(listener)
      window.clearTimeout(pulseTimer.current)
      pulseTimer.current = window.setTimeout(() => setPulseFor(null), 600)
      window.setTimeout(() => {
        setBubble((b) => (b[who] === reply ? { ...b, [who]: null } : b))
        setAction((a) => ({ ...a, [who]: 'idle' }))
        setSpeaking(null)
        setUserBubble((u) => (u === text ? null : u)) // 应答结束,你说的这句一并收走
      }, 2200 + reply.length * 160)
    } catch {
      setUserBubble(null)
      const fb = '（信号不好，没听清…再说一遍？）'
      setBubble((b) => ({ ...b, [who]: fb }))
      window.setTimeout(() => setBubble((b) => (b[who] === fb ? { ...b, [who]: null } : b)), 2200)
    } finally {
      setChatBusy(false)
    }
    // 后台记忆提取:不阻塞、失败静默
    void (async () => {
      try {
        const mem = await getMemory()
        const known = topFacts(mem, 8)
        const candidates = await extractFacts(text, known)
        if (candidates.length > 0) {
          await mergeFacts(candidates)
          setMemoryFacts((await getMemory()).facts)
        }
      } catch {
        // 静默
      }
    })()
  }

  /** 记忆页:刷新事实列表 */
  async function refreshMemoryFacts() {
    setMemoryFacts((await getMemory()).facts)
  }

  /** 记忆页:刷新角色世界列表 */
  async function refreshStory() {
    setStoryData(await getStory())
  }

  /** 完播后蒸馏角色世界素材:对照库存记账(新素材入库/老梗回收计数/事件线结案)。
   *  仅新生成集(gen)自然播完后调用——用户没看完的集不蒸馏,回放不重复蒸馏;静默失败 */
  async function distillStoryFrom(lines: DialogLine[]) {
    try {
      const inv = await storyInventory(3)
      await mergeStory(await distillStory(lines, inv))
      await refreshStory() // 记忆页若开着,列表顺带刷新
    } catch {
      // 静默:蒸馏宁可错过
    }
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
    // 拉取账号下的克隆音色(失败静默,下拉只是少了自定义项)
    if (cfg.voice.apiKey.trim()) {
      listCustomVoices(cfg.voice.apiKey)
        .then(setClonedVoices)
        .catch((e) => console.warn('克隆音色列表拉取失败(静默)', e))
    }
  }

  /** 保存配置：落盘 + 刷新缓存，下一次生成即生效。
   *  只写设置面板拥有的字段(连接信息/画像/自动重放/语音),布局、主题等
   *  由各自的保存通道维护,避免用打开面板时刻的旧快照覆盖拖动等并发改动。
   *  apiKeys = 已存值 ∪ 面板草稿 ∪ 当前输入(归位到当前厂商键),各厂商 key 一并持久化 */
  async function saveSettings() {
    setSaveState('saving')
    try {
      const next = await saveConfig({
        apiKey: form.apiKey,
        apiKeys: {
          ...form.apiKeys,
          ...keyDrafts,
          [vendorKeyOf(vendorId, form.baseUrl)]: form.apiKey,
        },
        baseUrl: form.baseUrl,
        model: form.model,
        userProfile: form.userProfile,
        autoReplayMin: form.autoReplayMin,
        voice, // 语音配置(key/音色/开关)与表单一起整体落盘
        screenshot: form.screenshot, // 截屏配置(快捷键/开关/角色排除)
        webchatEnabled: form.webchatEnabled,
        webchatSite: form.webchatSite,
        envSense: form.envSense, // 环境感知开关
        breakReminder: form.breakReminder, // 久坐提醒(番茄钟)
      })
      setAutoReplayMin(next.autoReplayMin) // 空闲计时按新频率重新武装
      void applyScreenshotHotkey() // 快捷键按新配置换绑
      void invoke('set_capture_excluded', { enable: next.screenshot.hideSelf }).catch(() => {})
      if (next.envSense) startEnvPolling()
      else stopEnvPolling()
      setSaveState('saved')
      window.setTimeout(() => setSettingsOpen(false), 900)
    } catch (e) {
      console.error('配置保存失败', e)
      setSaveState('error')
    }
  }

  // ---------- 网页版生成:Edge 窗口与状态 ----------

  // 登录就绪轮询句柄(登录成功自动恢复角色)
  const webchatPollRef = useRef(0)

  /** 打开 Edge 窗口给用户登录(角色暂时隐藏让路);轮询就绪后自动恢复角色 */
  async function openWebchatWindow() {
    try {
      setWebchatStatusText('正在打开 Edge 窗口…')
      await webchatLogin(form.webchatSite)
      setWebchatStatusText('Edge 已打开:登录一次,成功后角色自动恢复')
      startWebchatReadyPoll()
    } catch (e) {
      setWebchatStatusText(`打开失败:${String(e)}`)
    }
  }

  /** 每 4 秒探测一次目标站点可否发消息,登录成功即恢复角色;最多等 5 分钟 */
  function startWebchatReadyPoll() {
    window.clearInterval(webchatPollRef.current)
    const started = Date.now()
    webchatPollRef.current = window.setInterval(() => {
      if (Date.now() - started > 5 * 60_000) {
        window.clearInterval(webchatPollRef.current)
        setWebchatStatusText('等待登录超时:登录完成后可点「查状态」或「恢复角色」')
        return
      }
      void webchatProbe()
        .then((p) => {
          if (!p.ready) {
            setWebchatStatusText(`探测中:${p.detail}`)
            return
          }
          window.clearInterval(webchatPollRef.current)
          setWebchatStatusText('已就绪 ✓ 登录成功,角色已恢复——可以直接点播了')
        })
        .catch((e) => setWebchatStatusText(`探测异常:${String(e)}`))
    }, 4000)
  }

  async function refreshWebchatStatus() {
    try {
      setWebchatStatusText('检查中…')
      const p = await webchatProbe()
      setWebchatStatusText(p.ready ? '已就绪 ✓(角色已恢复)' : `未就绪:${p.detail}`)
    } catch (e) {
      setWebchatStatusText(`状态获取失败:${String(e)}`)
    }
  }

  async function restoreMain() {
    try {
      await webchatRestoreMain()
      setWebchatStatusText('角色已恢复')
    } catch (e) {
      setWebchatStatusText(`恢复失败:${String(e)}`)
    }
  }

  async function onToggleFav(ep: Episode) {
    const nowFav = await toggleFavorite(ep)
    if (nowFav) bumpTopicFavored(ep.topic) // 收藏 = 口味正信号
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
      maybeDistancePlay(who)
    } else {
      poke(who) // 原地点一下 = 戳一戳
    }
  }

  /** 拖拽结束后的距离演出:贴近/远离/叠一起(本地规则,12s 冷却) */
  function maybeDistancePlay(who: Speaker) {
    if (phaseRef.current !== 'idle') return
    const other: Speaker = who === 'A' ? 'B' : 'A'
    const ax = (charCfg.A.xPct / 100) * window.innerWidth
    const bx = (charCfg.B.xPct / 100) * window.innerWidth
    const dx = Math.abs(ax - bx)
    const bands = distanceBands(charCfg.height)
    const now = Date.now()
    const cooled = (kind: string) => now - (distLastAt.current[kind] ?? 0) > 12_000
    const mark = (kind: string) => { distLastAt.current[kind] = now }

    if (dx < bands.overlap && cooled('overlap')) {
      mark('overlap')
      showPoke(other, react(other, 'overlap'), 'surprise', 2000)
      // 推开:被拖者向远离方向挪 6%
      const cfg = charCfgRef.current
      const dir = cfg[who].xPct <= cfg[other].xPct ? -6 : 6
      applyChars({ ...cfg, [who]: { ...cfg[who], xPct: Math.min(97, Math.max(3, cfg[who].xPct + dir)) } }, 'now')
      void logDrag()
      return
    }
    if (dx < bands.close && cooled('close')) {
      mark('close')
      showPoke(other, react(other, 'close'), 'surprise', 2200)
      void logDrag()
      return
    }
    if (dx > window.innerWidth * 0.6 && cooled('far')) {
      mark('far')
      showPoke('A', react('A', 'far'), 'talk', 2400, true)
      showPoke('B', react('B', 'far'), 'talk', 2400, true)
      void logDrag()
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
    // 只响应把手及内部图标(图标已 pointer-events:none),按钮/分段控件不受影响
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return
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

  /** 连戳计数(60s 滑动窗口),决定反应强度 */
  const pokeCounts = useRef<Record<Speaker, number[]>>({ A: [], B: [] })
  const improvLastAt = useRef(0)

  function showPoke(who: Speaker, line: string, action: string, ms = 1600, loud = false) {
    setBubble((b) => ({ ...b, [who]: line }))
    setLoudBubble((l) => ({ ...l, [who]: loud }))
    setAction((a) => ({ ...a, [who]: action }))
    setReacting((r) => ({ ...r, [who]: true }))
    window.clearTimeout(timers.current[who])
    timers.current[who] = window.setTimeout(() => {
      setBubble((b) => ({ ...b, [who]: null }))
      setAction((a) => ({ ...a, [who]: 'idle' }))
      setReacting((r) => ({ ...r, [who]: false }))
      setLoudBubble((l) => ({ ...l, [who]: false }))
    }, ms)
  }

  function poke(who: Speaker) {
    setActiveTick((t) => t + 1) // 用户互动,重置自动重放计时
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
      improvPokeLine(who, lastLines.current)
        .then((line) => {
          // 返回时已超窗或开始正式演出 → 丢弃,防止顶掉台词气泡
          if (Date.now() - now >= 4500) return
          if (phaseRef.current !== 'idle' || player.current!.playing) return
          showPoke(who, line, 'talk', 2200)
        })
        .catch(() => {
          if (phaseRef.current !== 'idle' || player.current!.playing) return
          showPoke(who, fallback, fallbackAction)
        })
      // 先给一个占位反应,LLM 返回后替换
      showPoke(who, '（被戳得一激灵）', 'surprise', 1200)
      return
    }
    showPoke(who, fallback, fallbackAction)
  }

  const busy = phase === 'generating'
  // 显示用动作:打瞌睡仅覆盖 idle 态,任何明确动作优先
  const displayAction = (who: Speaker) =>
    sleepyOn && action[who] === 'idle' ? 'sleepy' : action[who]

  return (
    <div
      className="stage"
      onPointerDown={(e) => {
        // 点在面板/工具栏之外 → 收起已打开的面板(穿透窗口下 e.target 即 .stage 本体)
        // 录音中点击外部不收面板(防止丢失停止入口)
        if (voiceRecording.current && settingsOpen) return
        if (e.target === e.currentTarget) {
          setSettingsOpen(false)
          setTopicOpen(false)
          setChatOpen(false)
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
          <PokeballIcon />
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
          onClick={() => {
            if (settingsOpen && voiceRecording.current) return // 录音中锁定
            if (settingsOpen) setSettingsOpen(false)
            else void openSettings()
          }}
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
          onClick={() => {
            if (topicOpen) {
              setTopicOpen(false)
            } else {
              setSettingsOpen(false)
              setTopicOpen(true)
            }
          }}
        >
          <TargetIcon />
        </button>

        <button
          ref={btnShot}
          className={`ctrl-btn icon${hovered === 'shot' ? ' hot' : ''}`}
          title="截屏(框选,复制到剪贴板)"
          onClick={() => {
            setSettingsOpen(false)
            setTopicOpen(false)
            setChatOpen(false)
            startScreenshot().catch((e) => {
              const msg = String((e as Error)?.message ?? e).slice(0, 50)
              setBubble({ A: `截图失败:${msg}`, B: null })
              window.setTimeout(() => {
                setBubble((b) => (b.A?.startsWith('截图失败') ? { A: null, B: null } : b))
              }, 2400)
            })
          }}
        >
          <CropIcon />
        </button>

        <button
          ref={btnChat}
          className={`ctrl-btn icon${hovered === 'chat' ? ' hot' : ''}${chatOpen ? ' on' : ''}`}
          title="和角色说话(@甲/@乙 指定谁回)"
          onClick={() => {
            if (chatOpen) {
              setChatOpen(false)
            } else {
              setSettingsOpen(false)
              setTopicOpen(false)
              setChatOpen(true)
            }
          }}
        >
          <ChatIcon />
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
                className={`panel-tab${settingsTab === 'voice' ? ' on' : ''}`}
                onClick={() => setSettingsTab('voice')}
              >
                语音
              </button>
              <button
                className={`panel-tab${settingsTab === 'memory' ? ' on' : ''}`}
                onClick={() => {
                  setSettingsTab('memory')
                  void refreshMemoryFacts()
                  void refreshStory()
                }}
              >
                记忆
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
            <label htmlFor="cfg-interests">使用者的兴趣爱好(选填,逗号分隔 — 完整画像在"记忆"页)</label>
            <textarea
              id="cfg-interests"
              rows={2}
              value={form.userProfile.likes}
              placeholder="如:摄影,健身,玩unity,听周杰伦 — 日常闲聊会偶尔聊到"
              onChange={(e) =>
                setForm({ ...form, userProfile: { ...form.userProfile, likes: e.target.value } })
              }
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-env">桌面环境感知(电量/前台应用分类等,仅本机分类,不上传)</label>
            <input
              id="cfg-env"
              type="checkbox"
              checked={form.envSense}
              onChange={(e) => {
                const next = e.target.checked
                setForm({ ...form, envSense: next })
                saveConfig({ envSense: next }).catch((err) =>
                  console.warn('环境感知开关保存失败(静默)', err),
                )
                next ? startEnvPolling() : stopEnvPolling()
              }}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-break-enable">久坐提醒(连续活跃 X 分钟后角色提醒休息)</label>
            <div className="shot-key-row">
              <input
                id="cfg-break-enable"
                type="checkbox"
                checked={form.breakReminder.enabled}
                onChange={(e) =>
                  setForm({
                    ...form,
                    breakReminder: { ...form.breakReminder, enabled: e.target.checked },
                  })
                }
              />
              <input
                type="number"
                min={15}
                max={120}
                step={5}
                className="break-min-input"
                title="连续活跃多少分钟后提醒(15~120)"
                value={form.breakReminder.minutes}
                onChange={(e) =>
                  setForm({
                    ...form,
                    breakReminder: {
                      ...form.breakReminder,
                      minutes: Math.min(120, Math.max(15, Number(e.target.value) || 45)),
                    },
                  })
                }
              />
              <span>分钟后</span>
            </div>
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
          <div className="settings-sep">
            <span>网页版生成(实验)</span>
          </div>
          <div className="settings-row">
            <label
              htmlFor="cfg-webchat"
              title="仅主演出(相声/日常段子)走网页模型,记忆提取等小调用仍走 API;失败自动回退"
            >
              主演出改用网页模型生成
            </label>
            <input
              id="cfg-webchat"
              type="checkbox"
              checked={form.webchatEnabled}
              onChange={(e) => setForm({ ...form, webchatEnabled: e.target.checked })}
            />
          </div>
          {form.webchatEnabled && (
            <>
              <div className="settings-row">
                <label htmlFor="cfg-webchat-site">网页模型站点</label>
                <select
                  id="cfg-webchat-site"
                  value={form.webchatSite}
                  onChange={(e) =>
                    setForm({ ...form, webchatSite: e.target.value as AppConfig['webchatSite'] })
                  }
                >
                  {WEBCHAT_SITES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-row">
                <label htmlFor="cfg-webchat-login">网页窗口(首次需登录一次)</label>
                <div className="shot-key-row">
                  <button id="cfg-webchat-login" className="panel-btn" onClick={openWebchatWindow}>
                    打开窗口
                  </button>
                  <button className="panel-btn" onClick={() => void refreshWebchatStatus()}>
                    查状态
                  </button>
                  <button className="panel-btn" onClick={() => void restoreMain()}>
                    恢复角色
                  </button>
                  <span className="settings-hint">{webchatStatusText}</span>
                </div>
              </div>
              <div className="settings-row">
                  <div className="settings-hint">
                    生成用系统 Edge 的独立窗口(独立 profile,不影响日常浏览):登录一次长期有效;
                    生成时会出现 Edge 标签页,可最小化,完成后自动关闭。
                  </div>
              </div>
            </>
          )}
          <div className="settings-sep">
            <span>截屏</span>
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-shot-enable">全局截屏快捷键(框选→复制到剪贴板)</label>
            <div className="shot-key-row">
              <input
                id="cfg-shot-enable"
                type="checkbox"
                checked={form.screenshot.enabled}
                onChange={(e) =>
                  setForm({ ...form, screenshot: { ...form.screenshot, enabled: e.target.checked } })
                }
              />
              <HotkeyRecorder
                value={form.screenshot.hotkey}
                onChange={(hotkey) =>
                  setForm({ ...form, screenshot: { ...form.screenshot, hotkey } })
                }
              />
            </div>
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-shot-hide">截屏/录屏时排除角色(角色不进任何截图与录屏,Win10 2004+)</label>
            <input
              id="cfg-shot-hide"
              type="checkbox"
              checked={form.screenshot.hideSelf}
              onChange={(e) => {
                const next = { ...form.screenshot, hideSelf: e.target.checked }
                setForm({ ...form, screenshot: next })
                saveConfig({ screenshot: next }).catch((err) =>
                  console.warn('截屏排除开关保存失败(静默)', err),
                )
                invoke('set_capture_excluded', { enable: e.target.checked }).catch(() => {})
              }}
            />
          </div>
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

          {settingsTab === 'voice' && (
            <>
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
                <label htmlFor="cfg-voice-key" title="siliconflow.cn 的 API Key,与常规页 LLM 的 key 相互独立">
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
                  {clonedVoices.length > 0 && <optgroup label="我的克隆音色">{clonedVoices.map((v) => (
                    <option key={v.uri} value={v.uri}>{v.name}</option>
                  ))}</optgroup>}
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
                  {clonedVoices.length > 0 && <optgroup label="我的克隆音色">{clonedVoices.map((v) => (
                    <option key={v.uri} value={v.uri}>{v.name}</option>
                  ))}</optgroup>}
                </select>
              </div>
              <CloneVoiceRow
                apiKey={voice.apiKey}
                onRecordingChange={(rec) => (voiceRecording.current = rec)}
                onCloned={(v) => {
                  setClonedVoices((list) => [...list.filter((x) => x.uri !== v.uri), v])
                  const next = { ...voice, B: v.uri }
                  setVoice(next)
                  saveConfig({ voice: next }).catch(() => {})
                }}
              />
            </>
          )}
            </>
          )}

          {settingsTab === 'memory' && (
            <>
          <div className="settings-sep">
            <span>使用者画像(角色据此认识你)</span>
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-mem-name">你的称呼</label>
            <input
              id="cfg-mem-name"
              placeholder="角色会这样叫你"
              value={form.userProfile.userName}
              onChange={(e) => setForm({ ...form, userProfile: { ...form.userProfile, userName: e.target.value } })}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-mem-occ">职业 / 身份</label>
            <input
              id="cfg-mem-occ"
              placeholder="如:在读研究生"
              value={form.userProfile.occupation}
              onChange={(e) => setForm({ ...form, userProfile: { ...form.userProfile, occupation: e.target.value } })}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-mem-likes">喜欢(逗号分隔)</label>
            <input
              id="cfg-mem-likes"
              value={form.userProfile.likes}
              onChange={(e) => setForm({ ...form, userProfile: { ...form.userProfile, likes: e.target.value } })}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-mem-dis">不喜欢(逗号分隔)</label>
            <input
              id="cfg-mem-dis"
              value={form.userProfile.dislikes}
              onChange={(e) => setForm({ ...form, userProfile: { ...form.userProfile, dislikes: e.target.value } })}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-mem-ban">雷区(完全不聊)</label>
            <input
              id="cfg-mem-ban"
              placeholder="如:考试,前任"
              value={form.userProfile.banTopics}
              onChange={(e) => setForm({ ...form, userProfile: { ...form.userProfile, banTopics: e.target.value } })}
            />
          </div>
          <div className="settings-sep">
            <span>记住的事({memoryFacts.length})</span>
            <button
              className={`hist-clear${clearMemArmed ? ' danger' : ''}`}
              disabled={memoryFacts.length === 0}
              onClick={() => {
                if (!clearMemArmed) {
                  setClearMemArmed(true)
                  window.setTimeout(() => setClearMemArmed(false), 3000)
                  return
                }
                void (async () => {
                  await clearMemory()
                  setMemoryFacts([])
                  setClearMemArmed(false)
                })()
              }}
            >
              {clearMemArmed ? '确认清空?' : '清空全部'}
            </button>
          </div>
          {memoryFacts.length === 0 && (
            <div className="settings-tip">还没有记忆 — 和角色聊天时透露的信息会被自动记住</div>
          )}
          {memoryFacts.map((f) => (
            <div className="mem-fact" key={f.id}>
              <span className="mem-cat">{MEM_CAT_LABEL[f.category]}</span>
              <span className="mem-content">{f.content}</span>
              <button
                className={`mem-btn${f.pinned ? ' on' : ''}`}
                title={f.pinned ? '取消置顶' : '置顶(永不遗忘)'}
                onClick={() => void (async () => { await togglePinFact(f.id); await refreshMemoryFacts() })()}
              >
                📌
              </button>
              <button
                className="mem-btn"
                title="忘记这条"
                onClick={() => void (async () => { await deleteFact(f.id); await refreshMemoryFacts() })()}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="settings-sep">
            <span>角色世界(两人之间的老梗/未了结事件,演出中会偶尔回收)</span>
          </div>
          {(storyData?.gags.length ?? 0) === 0 && (storyData?.threads.length ?? 0) === 0 && (
            <div className="settings-tip">还没有角色共同记忆 — 演出几集后会自动积累</div>
          )}
          {storyData?.gags.map((g) => (
            <div className="mem-fact" key={g.id}>
              <span className="mem-cat">老梗</span>
              <span className="mem-content">{g.text}</span>
              <button
                className="mem-btn"
                title="删掉这条老梗"
                onClick={() => void (async () => { await removeStoryItem('gags', g.id); await refreshStory() })()}
              >
                ✕
              </button>
            </div>
          ))}
          {storyData?.threads.map((t) => (
            <div className="mem-fact" key={t.id}>
              <span className="mem-cat">未了结</span>
              <span className="mem-content">{t.text}</span>
              <button
                className="mem-btn"
                title="删掉这条事件线"
                onClick={() => void (async () => { await removeStoryItem('threads', t.id); await refreshStory() })()}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="settings-sep">
            <span>连续剧情(多集推进的剧情线,约 30% 的集数会演下一拍)</span>
          </div>
          {(storyData?.arcs.length ?? 0) === 0 && (
            <div className="settings-tip">还没有剧情线 — 演出中冒出的连续剧情会出现在这里</div>
          )}
          {storyData?.arcs.map((a) => (
            <div className="mem-fact" key={a.id}>
              <span className="mem-cat">{a.status === 'done' ? '完结' : `第${a.stage}拍`}</span>
              <span className="mem-content">《{a.title}》下一拍:{a.nextHook}</span>
              <button
                className="mem-btn"
                title="删掉这条剧情线"
                onClick={() => void (async () => { await removeArc(a.id); await refreshStory() })()}
              >
                ✕
              </button>
            </div>
          ))}
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

        {captureShot && (
          <CaptureOverlay
            path={captureShot}
            onDone={(ok) => {
              setCaptureMode(false)
              setCaptureShot(null)
              if (ok) setActiveTick((t) => t + 1)
            }}
          />
        )}

        {showWatermark && (
          <div className="watermark">空闲时自动重放历史 · 选模式点 ▶ 生成一集 · 拖精灵球移动工具栏</div>
        )}
      </div>
  )
}

export default App
