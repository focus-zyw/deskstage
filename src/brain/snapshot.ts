// 运行现场快照聚合:把分散在 world/调度器/mood/记忆/chatlog/互动账本的现场
// 拼成一张 BrainInput。全部依赖注入(纯函数,可直接单测);IO 侧在 bridgeLink。
// 脱敏闸:窗口标题只在用户已开 contextSense.windowTitle 时携带——沿用既有授权,
// 不新增隐私面。设计见 docs/影子大脑桥接设计方案.md。

import type { WorldState } from '../world'
import { decayTable, type MoodTable } from '../engine/moodState'
import type { InteractionStats } from '../storage/interactionStore'
import type { LocalEvaluation, BrainInput } from './types'
import { moodToVad } from './vad'

const MAX_PROMPT_FACTS = 3
const PROMPT_FACT_CAP = 60
const MAX_LAST_LINES = 6
const LAST_LINE_CAP = 80

let seq = 0

/** 输入 id:brin_ + 序号(进程内单调)+ 时间戳尾巴(跨重启不撞) */
function nextInputId(now: number): string {
  seq += 1
  return `brin_${seq.toString(36)}_${now.toString(36)}`
}

export interface SnapshotSource {
  world: WorldState | null
  /** 本 tick 的调度器本地评估(影子配对的锚) */
  evaluation: LocalEvaluation
  quotaCap: number
  /** 调度器时序(schedulerTiming()):取距上次自发尝试/成功的毫秒 */
  timing: { lastSpontAttempt: number; lastSpontSuccess: number }
  /** 未衰减的 mood 表(内部先惰性衰减再投影) */
  moods: MoodTable
  promptFacts: readonly string[]
  /** chatlog 尾部(原始条目,内部截断拼 who:text) */
  lastTurns: ReadonlyArray<{ who: string; text: string }>
  interactions: InteractionStats
  /** 用户已开窗口标题采集(contextSense.windowTitle)才为 true */
  includeWindowTitle: boolean
  now?: number
}

export function buildBrainInput(src: SnapshotSource): BrainInput {
  const now = src.now ?? Date.now()
  const w = src.world
  const moods = decayTable(src.moods, now)
  const facts = src.promptFacts
    .map((f) => f.trim().slice(0, PROMPT_FACT_CAP))
    .filter(Boolean)
    .slice(0, MAX_PROMPT_FACTS)
  const lastLines = src.lastTurns
    .map((t) => `${t.who}:${t.text.replace(/\s+/g, ' ').trim()}`.slice(0, LAST_LINE_CAP))
    .slice(-MAX_LAST_LINES)
  const title = src.includeWindowTitle && w?.activeWindowTitle ? w.activeWindowTitle : null
  return {
    inputId: nextInputId(now),
    ts: now,
    tick: {
      idleForMs: Math.max(0, Math.round(src.evaluation.idleForMs)),
      quotaUsed: src.evaluation.quotaUsed,
      quotaCap: src.quotaCap,
      sinceLastSpontMs: src.timing.lastSpontAttempt > 0 ? now - src.timing.lastSpontAttempt : null,
      sinceLastSpontSuccessMs:
        src.timing.lastSpontSuccess > 0 ? now - src.timing.lastSpontSuccess : null,
    },
    world: {
      foreground: w?.foreground ?? null,
      processName: w?.processName ?? null,
      activeWindowTitle: title,
      fullscreen: !!w?.fullscreenApp,
      idleMinutes: w?.idleMinutes ?? 0,
      audioPlaying: !!w?.audioPlaying,
      mediaName: w?.mediaName ?? null,
      cpuPercent: w?.cpuPercent ?? null,
      memPercent: w?.memPercent ?? null,
      batteryPercent: w?.batteryPercent ?? null,
      charging: w?.charging ?? null,
    },
    mood: {
      A: { vad: moodToVad(moods.A), cause: moods.A.cause },
      B: { vad: moodToVad(moods.B), cause: moods.B.cause },
      C: { vad: moodToVad(moods.C), cause: moods.C.cause },
    },
    memory: { promptFacts: facts },
    recent: { lastLines },
    interactions: {
      dismissSpontaneous: src.interactions.dismissSpontaneous,
      dismissReplay: src.interactions.dismissReplay,
      dismissBreak: src.interactions.dismissBreak,
      interrupts: src.interactions.interrupts,
      pokes: src.interactions.pokeA + src.interactions.pokeB + src.interactions.pokeC,
    },
    local: src.evaluation,
  }
}
