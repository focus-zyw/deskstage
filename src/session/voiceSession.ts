// 实时语音对话闭环 · 编排器与 phase 唯一事实源。
//
// phase 流转:off → listening →(speech-end)→ transcribing →(chat.send 受理)→
// thinking →(首句出声,ChatSession host 钩子通知)→ speaking →(turn 结束)→ listening;
// 麦克风断流 → mic-lost(PTT 按下或重开会话即重试)。UI 把 transcribing/thinking
// 都显示为「正在想」;runtimeMode 只存 {type:'voice'} 排他位,这里才是 phase 的家。
//
// 打断:PTT 按下(恒可用)或自动 barge-in(实验项,默认关)→ chat.cancel()
// (真取消:abort 在飞 LLM + 句柄级停声 + 未完句不提交)→ 回 listening。
// 排他与进入:prepare()(宿主停演出/主播)→ mode.enter()(runtimeMode voice 位)。
//
// 深模块:麦克风/VAD/ASR/聊天/时钟全部注入,导入期无副作用;行为矩阵进
// CI(tests/voiceSession.test.mjs)。模块级外部 store(快照+useVoiceSession)
// 与 runtimeMode 同款:UI 直订这里,不经 caps 转发,避免状态副本。
import { useSyncExternalStore } from 'react'
import type { ChatSession } from './ChatSession'
import { diag } from '../diag/store'
import { registerSecretValue } from '../diag/redact'
import type { AsrConfig, VoiceChatConfig } from '../storage/configStore'
import { rmsDbfs, MIC_SAMPLE_RATE } from '../engine/mic'
import {
  createVoiceTracker,
  type VoiceTracker,
  type VoiceTrackerDeps,
  type TrackerMode,
} from '../engine/vad'

export type VoicePhase =
  | 'off'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'mic-lost'

export type VoiceSessionMode = 'ptt' | 'hands-free'

export interface VoiceSnapshot {
  phase: VoicePhase
  /** 收音电平 dBFS(「正在听」的电平点) */
  level: number
  /** 最近一次提示(没听清/识别失败/麦克风断开/风暴闩锁),空串 = 无 */
  note: string
  /** 自动打断被风暴保护闩锁(仅按键可打断) */
  stormLatched: boolean
}

export interface VoiceSessionDeps {
  /** 采集租约(engine/mic);异常断流经 onEnded 上报 */
  startMic(o: {
    deviceId?: string
    onFrame(pcm: Int16Array): void
    onEnded(reason: string): void
  }): Promise<{ stop(): Promise<void> }>
  createTracker(deps: VoiceTrackerDeps): VoiceTracker
  /** 识别一句(PCM16/16k)→ 文本;空串 = 没听清;抛错 = 服务不可用 */
  transcribe(pcm: Int16Array): Promise<string>
  /** 会话配置(启动时读一次;中途改设置下次会话生效) */
  loadConfig(): Promise<{ voiceChat: VoiceChatConfig; asr: AsrConfig }>
  chat: Pick<ChatSession, 'send' | 'cancel' | 'whenIdle'>
  mode: {
    /** 进入前置:停演出/主播;false = 当前不允许进入(如框选中) */
    prepare(): boolean
    enter(): void
    exit(): void
  }
  /** phase 变化通知宿主(姿势/闭嘴等呈现侧映射) */
  onPhase(phase: VoicePhase, prev: VoicePhase): void
  log?(msg: string): void
}

export interface VoiceSessionApi {
  start(mode: VoiceSessionMode): Promise<void>
  stop(): Promise<void>
  /** 按住说话:幂等;off = 直接开会话,mic-lost = 重试,speaking/thinking = 先打断再收音 */
  pttDown(): void
  pttUp(): void
  /** ChatSession host 钩子:语音句开始出声(或文本节奏兜底开屏) */
  notifyTurnSpeechStart(): void
}

/** 转写→发送链代次:打断/新句让旧链的迟到回调全部失效 */
type Publish = (s: VoiceSnapshot) => void

export function createVoiceSession(deps: VoiceSessionDeps, publish: Publish): VoiceSessionApi {
  let phase: VoicePhase = 'off'
  let level = -120
  let note = ''
  let stormLatched = false
  let activeMode: VoiceSessionMode | null = null
  let mic: { stop(): Promise<void> } | null = null
  let gateOpen = false
  /** PTT 在会话尚未就绪时按下:就绪后自动开闸 */
  let gatePending = false
  let tracker: VoiceTracker | null = null
  let cfg: { voiceChat: VoiceChatConfig; asr: AsrConfig } | null = null
  let turnSeq = 0
  let starting = false
  let lastLevelEmit = 0

  function emit(force = false): void {
    const now = Date.now()
    if (!force && now - lastLevelEmit < 100) return // 电平 33Hz 进来,快照最多 10Hz
    lastLevelEmit = now
    publish({ phase, level, note, stormLatched })
  }
  function setPhase(p: VoicePhase): void {
    if (p === phase) return
    const prev = phase
    phase = p
    // 角色占用音频期(speaking)开启 barge-in 侦听;回到收音即关——
    // thinking/transcribing 不开(PTT 仍可打断,语音打断只在"正在说")
    tracker?.setWatchBargeIn(p === 'speaking')
    emit(true)
    deps.onPhase(p, prev)
  }
  function setNote(n: string): void {
    if (note === n) return
    note = n
    emit(true)
  }

  /** VAD 模式映射:listening 才收音;transcribing/thinking 挂起(迟到的半句直接丢,
   *  防转写间隙叠出新句);speaking 保持原模式交由 watch 挡采集,barge-in 才有落点 */
  function trackerMode(): TrackerMode {
    if (!activeMode || phase === 'off' || phase === 'mic-lost') return 'idle'
    if (phase === 'transcribing' || phase === 'thinking') return 'idle'
    return activeMode === 'hands-free' ? 'handsfree' : 'ptt'
  }

  function makeTracker(): VoiceTracker {
    return deps.createTracker({
      mode: trackerMode,
      sensitivityDb: () => cfg?.voiceChat.vadSensitivityDb ?? 12,
      endSilenceMs: () => cfg?.voiceChat.silenceMs ?? 800,
      autoInterrupt: () => (cfg?.voiceChat.autoInterrupt ?? false) && !stormLatched,
      interruptExtraDb: () => cfg?.voiceChat.interruptExtraDb ?? 6,
      onEvent: (e) => {
        if (e.type === 'speech-end') void handleUtterance(e.pcm)
        else if (e.type === 'barge-in') bargeIn()
        else if (e.type === 'interrupt-storm') {
          stormLatched = true
          setNote('回声误触发频繁,已暂停「说话时语音打断」,仅按键可打断')
        }
      },
    })
  }

  /** 一段话音 → 识别 → 发给聊天。迟到链(被打断/新句顶掉)按代次丢弃。
   *  诊断:ASR 成功 → 指标并入本回合会话;失败/空结果 → 独立 mini 会话
   *  (否则"为什么这次没有说话"在面板上完全不可见) */
  async function handleUtterance(pcm: Int16Array): Promise<void> {
    if (phase !== 'listening' || !activeMode) return
    const seq = ++turnSeq
    setPhase('transcribing')
    const asrT0 = Date.now()
    const audioMs = Math.round((pcm.length / MIC_SAMPLE_RATE) * 1000)
    let text = ''
    let asrError: string | undefined
    try {
      text = (await deps.transcribe(pcm)).trim()
    } catch (e) {
      asrError = String((e as Error)?.message ?? e).slice(0, 60)
      if (seq !== turnSeq) return
      setPhase('listening')
      setNote(`识别失败:${asrError}`)
      const miniId = `asr-${seq}-${asrT0}`
      diag.beginTurn({ id: miniId, source: 'voice', text: '', ts: asrT0 })
      diag.asrResult(miniId, { ms: Date.now() - asrT0, chars: 0, audioMs, errorKind: asrError })
      diag.turnFinished(miniId, { outcome: 'failed', totalMs: Date.now() - asrT0, replyChars: 0, replySentences: 0 })
      diag.finish(miniId)
      return
    }
    const asrMs = Date.now() - asrT0
    if (seq !== turnSeq) return
    if (!text) {
      setPhase('listening')
      setNote('没听清,再试一次?')
      const miniId = `asr-${seq}-${asrT0}`
      diag.beginTurn({ id: miniId, source: 'voice', text: '', ts: asrT0 })
      diag.asrResult(miniId, { ms: asrMs, chars: 0, audioMs, errorKind: 'empty' })
      diag.turnFinished(miniId, { outcome: 'silent', totalMs: Date.now() - asrT0, replyChars: 0, replySentences: 0 })
      diag.finish(miniId)
      return
    }
    setNote('')
    setPhase('thinking')
    const r = await deps.chat.send(text, { voice: true, diagAsr: { ms: asrMs, chars: text.length, audioMs } })
    if (seq !== turnSeq) return
    if (r !== 'accepted') {
      setPhase('listening')
      setNote('上一条还在回答')
      return
    }
    void deps.chat.whenIdle().then(() => {
      if (seq !== turnSeq) return
      if (phase === 'thinking' || phase === 'speaking') setPhase('listening')
    })
  }

  /** 打断在飞应答回到收音;对 transcribing/thinking/speaking 都有效 */
  function bargeIn(): void {
    if (phase !== 'speaking' && phase !== 'thinking' && phase !== 'transcribing') return
    turnSeq += 1
    deps.chat.cancel()
    setPhase('listening')
  }

  /** 麦克风断流(拔出/休眠/隐私关闭):保持 voice 位展示不可用,PTT 按下重试 */
  function micLost(reason: string): void {
    mic = null
    gateOpen = false
    gatePending = false
    if (phase === 'off') return
    setPhase('mic-lost')
    setNote(`麦克风断开:${reason}`)
  }

  async function restart(): Promise<void> {
    const mode = activeMode ?? 'ptt'
    await api.stop()
    await api.start(mode)
  }

  const api: VoiceSessionApi = {
    async start(mode) {
      if (phase !== 'off' || starting) return
      starting = true
      try {
        if (!deps.mode.prepare()) return
        cfg = await deps.loadConfig()
        stormLatched = false
        setNote('')
        tracker = makeTracker()
        activeMode = mode
        setPhase('listening')
        deps.mode.enter()
        mic = await deps.startMic({
          deviceId: cfg.voiceChat.deviceId || undefined,
          onFrame: (f) => {
            level = rmsDbfs(f)
            tracker?.feed(f)
            emit() // 快照节流在 emit 内部(电平最多 10Hz)
          },
          onEnded: (reason) => micLost(reason),
        })
        if (gatePending && activeMode === 'ptt') {
          gatePending = false
          gateOpen = true
          tracker?.setGate(true)
        }
        deps.log?.(`语音会话开始(${mode})`)
      } catch (e) {
        setPhase('mic-lost')
        setNote(`麦克风不可用:${String((e as Error)?.message ?? e).slice(0, 80)}(检查系统「设置 → 隐私 → 麦克风」)`)
      } finally {
        starting = false
      }
    },
    async stop() {
      const wasActive = phase !== 'off' || activeMode !== null
      turnSeq += 1
      gateOpen = false
      gatePending = false
      const m = mic
      mic = null
      activeMode = null
      tracker = null
      deps.chat.cancel() // 在飞应答随会话终止(abort + 句柄停声)
      setPhase('off')
      if (wasActive) deps.mode.exit()
      await m?.stop().catch(() => {})
    },
    pttDown() {
      if (phase === 'off') {
        gatePending = true
        void api.start('ptt')
        return
      }
      if (phase === 'mic-lost') {
        gatePending = true
        void restart()
        return
      }
      if (phase === 'speaking' || phase === 'thinking' || phase === 'transcribing') {
        bargeIn() // PTT 打断恒可用:任何占用阶段按下即断
        if (activeMode === 'ptt') {
          gateOpen = true
          tracker?.setGate(true)
        }
        return
      }
      if (phase === 'listening' && activeMode === 'ptt' && !gateOpen) {
        gateOpen = true
        tracker?.setGate(true)
      }
    },
    pttUp() {
      gatePending = false
      if (!gateOpen) return
      gateOpen = false
      tracker?.setGate(false) // → speech-end → handleUtterance
    },
    notifyTurnSpeechStart() {
      if (phase === 'thinking' || phase === 'transcribing') setPhase('speaking')
    },
  }
  return api
}

// ---------- 模块级外部 store(与 runtimeMode 同款) ----------

let snap: VoiceSnapshot = { phase: 'off', level: -120, note: '', stormLatched: false }
const listeners = new Set<() => void>()

export function getVoiceSnapshot(): VoiceSnapshot {
  return snap
}

export function subscribeVoice(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useVoiceSession(): VoiceSnapshot {
  return useSyncExternalStore(subscribeVoice, getVoiceSnapshot)
}

let active: VoiceSessionApi | null = null

/** 已安装的会话实例;null = App 尚未挂载(热键/命令在安装前静默不响应) */
export function getActiveVoiceSession(): VoiceSessionApi | null {
  return active
}

/** App 挂载时安装唯一实例(真实依赖在此闭合;重复安装返回既有实例) */
export function installVoiceSession(init: {
  chat: Pick<ChatSession, 'send' | 'cancel' | 'whenIdle'>
  loadConfig(): Promise<{ voiceChat: VoiceChatConfig; asr: AsrConfig }>
  onPhase(phase: VoicePhase, prev: VoicePhase): void
  mode: VoiceSessionDeps['mode']
  log?(msg: string): void
}): VoiceSessionApi {
  if (active) return active
  active = createVoiceSession(
    {
      startMic: (o) => import('../engine/mic').then((m) => m.startMic({ owner: 'voice-session', ...o })),
      createTracker: (td) => createVoiceTracker(td),
      transcribe: async (pcm) => {
        const cfg = await init.loadConfig()
        registerSecretValue(cfg.asr.apiKey)
        const provider = (await import('../engine/asr')).asrProviderById(cfg.asr.provider)
        return provider.transcribe(pcm, MIC_SAMPLE_RATE, cfg.asr.model)
      },
      loadConfig: init.loadConfig,
      chat: init.chat,
      mode: init.mode,
      onPhase: init.onPhase,
      log: init.log,
    },
    (s) => {
      snap = s
      listeners.forEach((l) => l())
    },
  )
  return active
}
