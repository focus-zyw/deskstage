// 语音活动检测(能量版)+ 说话状态机:30ms 帧进、事件出。
// 帧状态机语义照 @ricky0123/vad-web(起 = N 个正帧 / 止 = M 个静帧 / pre-roll 回填),
// 判定用 RMS dBFS 相对自适应噪声底;Silero(二期)经同一接口接入,精度换零依赖。
//
// 时间全用帧数度量(1 帧 = 30ms 恒定),不用计时器——行为矩阵在 CI 里完全确定,
// 不存在虚拟时钟漂移。深模块:参数 getter 每帧现查(设置即调即生效),
// 导入期无副作用(tests/vad.test.mjs 直载)。
import { rmsDbfs } from './mic'

export const FRAME_MS = 30

export type TrackerMode = 'idle' | 'handsfree' | 'ptt'

export type VoiceEvent =
  | { type: 'speech-start' }
  | { type: 'speech-end'; pcm: Int16Array }
  | { type: 'barge-in'; pcm: Int16Array }
  | { type: 'interrupt-storm' }

export interface VoiceTrackerDeps {
  /** 当前模式(voiceSession 按 phase 推进切换) */
  mode(): TrackerMode
  /** 起声阈值 = 噪声底 + sensitivityDb(默认 12) */
  sensitivityDb(): number
  /** 静音多久判一句结束(ms) */
  endSilenceMs(): number
  /** 自动打断实验开关(默认关;外放回声风险,见设计文档) */
  autoInterrupt(): boolean
  /** 打断阈值在起声阈值基础上再抬多少 dB */
  interruptExtraDb(): number
  onEvent(e: VoiceEvent): void
}

export interface VoiceTracker {
  feed(frame: Int16Array): void
  /** PTT 按下/松开:开闸收帧,松开即结算一句 */
  setGate(active: boolean): void
  /** speaking 期间置 true:挂起噪声底学习,启用高阈值 barge-in 检测 */
  setWatchBargeIn(active: boolean): void
  /** 强制结算当前句(模式切换/退出) */
  flush(): void
  /** 风暴闩锁复位(会话重启时) */
  resetStorm(): void
  noiseFloorDb(): number
}

// 帧数参数(30ms/帧):起 = 3 正帧(90ms,防喷麦瞬态);止 = endSilenceMs;
// pre-roll = 10 帧(300ms,保住"我/你/开"这类短促首音);打断确认 = 13 帧(400ms);
// 风暴窗口 = 333 帧(10s)内 ≥3 次 <600ms 的短打断 → 闩锁退回仅按键。
const START_FRAMES = 3
const PREROLL_FRAMES = 10
const BARGE_FRAMES = 13
const STORM_WINDOW_FRAMES = 333
const STORM_LIMIT = 3
const BARGE_SHORT_FRAMES = 20

/** 噪声底慢速 EMA:只在"确定安静"(非收音/非说话/非 watch)时学习,
 *  防角色 TTS 外放声抬高底噪导致越学越聋 */
const FLOOR_ALPHA = 0.05
const FLOOR_SEED_DB = -60

function joinFrames(frames: Int16Array[]): Int16Array {
  const total = frames.reduce((n, f) => n + f.length, 0)
  const out = new Int16Array(total)
  let at = 0
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return out
}

export function createVoiceTracker(deps: VoiceTrackerDeps): VoiceTracker {
  let floor = FLOOR_SEED_DB
  let totalFrames = 0

  // 采集态:handsfree 的 inSpeech / ptt 的开闸,共用一套 utterance 缓冲
  let collecting = false
  let utterance: Int16Array[] = []
  let preroll: Int16Array[] = []
  let posFrames = 0
  let silenceFrames = 0
  let speechFrames = 0

  // barge-in 检测(speaking 期间)
  let watchBargeIn = false
  let bargePos = 0
  let bargeRing: Int16Array[] = []
  let bargeStartAt = 0
  let stormLatched = false
  const bargeLog: number[] = []

  const threshold = () => floor + deps.sensitivityDb()

  function beginCollect() {
    collecting = true
    utterance = [...preroll] // 当前帧已在上面进过 pre-roll 环,这里只回填,不重复
    preroll = []
    speechFrames = utterance.length
    posFrames = 0
    silenceFrames = 0
    deps.onEvent({ type: 'speech-start' })
  }

  function endCollect() {
    if (!collecting) return
    collecting = false
    const pcm = joinFrames(utterance)
    utterance = []
    deps.onEvent({ type: 'speech-end', pcm })
  }

  return {
    feed(frame) {
      totalFrames += 1
      const mode = deps.mode()
      const db = rmsDbfs(frame)
      const quiet = mode === 'idle' || (!collecting && !watchBargeIn)
      // 只吸收低于阈值的帧:环境噪音抬底噪(想学),语音不打底噪(防越学越聋)
      if (quiet && db <= threshold()) floor = floor + FLOOR_ALPHA * (db - floor)

      // ---- barge-in:仅 speaking(watch)且开关打开时;风暴闩锁后只喂静默 ----
      if (watchBargeIn && mode !== 'idle') {
        bargeRing.push(frame)
        if (bargeRing.length > BARGE_FRAMES) bargeRing.shift()
        if (deps.autoInterrupt() && !stormLatched) {
          const bargeThreshold = threshold() + deps.interruptExtraDb()
          if (db > bargeThreshold) {
            if (bargePos === 0) bargeStartAt = totalFrames
            bargePos += 1
            if (bargePos >= BARGE_FRAMES) {
              bargePos = 0
              bargeLog.push(totalFrames)
              // 滑动窗口裁剪:只留风暴窗口内的记录
              while (bargeLog.length > 0 && bargeLog[0] <= totalFrames - STORM_WINDOW_FRAMES) {
                bargeLog.shift()
              }
              const short = totalFrames - bargeStartAt < BARGE_SHORT_FRAMES
              if (bargeLog.length >= STORM_LIMIT && short) {
                // 10s 内 3 次短打断 ≈ 回声误触发,闩锁退回仅按键,叫醒 UI 提示
                stormLatched = true
                bargeLog.length = 0
                deps.onEvent({ type: 'interrupt-storm' })
              } else {
                deps.onEvent({ type: 'barge-in', pcm: joinFrames(bargeRing) })
              }
            }
          } else {
            bargePos = 0
          }
        }
        // watch 期间不采集用户话音(角色在说),直接返回
        if (!collecting) return
      }

      if (mode === 'ptt') {
        if (collecting) {
          utterance.push(frame)
          speechFrames += 1
        }
        return
      }

      if (mode !== 'handsfree') {
        // idle:维持 pre-roll 环,供随时切入 handsfree 不丢首音
        preroll.push(frame)
        if (preroll.length > PREROLL_FRAMES) preroll.shift()
        return
      }

      // handsfree 迟滞状态机
      const voiced = db > threshold()
      if (!collecting) {
        preroll.push(frame)
        if (preroll.length > PREROLL_FRAMES) preroll.shift()
        posFrames = voiced ? posFrames + 1 : 0
        if (posFrames >= START_FRAMES) beginCollect()
        return
      }
      utterance.push(frame)
      speechFrames += 1
      if (voiced) {
        silenceFrames = 0
      } else {
        silenceFrames += 1
        const endFrames = Math.max(1, Math.round(deps.endSilenceMs() / FRAME_MS))
        if (silenceFrames >= endFrames) {
          // 截掉尾部静音帧(留 2 帧余量防切字)
          const keep = Math.max(0, utterance.length - (silenceFrames - 2))
          endCollectWith(utterance.slice(0, keep))
          return
        }
      }
      const maxFrames = Math.round(30_000 / FRAME_MS)
      if (speechFrames >= maxFrames) endCollect()
    },
    setGate(active) {
      if (active) {
        if (collecting) return
        collecting = true
        utterance = []
        speechFrames = 0
        silenceFrames = 0
        deps.onEvent({ type: 'speech-start' })
      } else {
        endCollect()
      }
    },
    setWatchBargeIn(active) {
      if (watchBargeIn === active) return
      watchBargeIn = active
      bargePos = 0
      bargeRing = []
      if (!active) endCollect()
    },
    flush() {
      endCollect()
    },
    resetStorm() {
      stormLatched = false
      bargeLog.length = 0
    },
    noiseFloorDb: () => floor,
  }

  function endCollectWith(frames: Int16Array[]) {
    collecting = false
    utterance = []
    const pcm = joinFrames(frames)
    deps.onEvent({ type: 'speech-end', pcm })
  }
}
