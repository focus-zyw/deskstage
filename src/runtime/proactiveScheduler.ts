// 主动行为调度器:全应用唯一的"现在该不该主动说话"决策点。
// 为什么:此前问候/自发聊天/久坐提醒/备忘扫描/自动重放各自持定时器与守卫,
// 无优先级、无配额、无"用户连续忽略就降频",新功能只能继续加散装定时器。
// 设计:单一 15s tick。备忘扫描每次 tick 必跑(用户定的事,卡片即时、不参与竞争);
// 其余主动行为(久坐>重放>自发)按优先级竞争,同一 tick 最多发一件事,全部计入
// 小时配额(主动程度:安静3/平衡6/热闹12)。用户提前掐断同类行为连续 3 次该类冷却翻倍。
// 时序状态(工作起始/上次触发/空闲起点)收编到模块内,原来散在 App 的 refs 一并迁入。

import { getCaps } from './runtimeMode'
import { getConfig } from '../storage/configStore'
import { isQuietHours } from '../engine/timeAware'
import { isFullscreenApp, isUserActive } from '../world'
import { dismissCooldownMultiplier, type DismissableKind } from '../storage/interactionStore'

const TICK_MS = 15_000
const QUOTA_PER_HOUR: Record<'quiet' | 'balanced' | 'lively', number> = {
  quiet: 3,
  balanced: 6,
  lively: 12,
}
/** 自发闲聊:连续空闲多久后才可能尝试 / 尝试最小间隔 / 每次尝试通过率(与旧实现同参数) */
const SPONT_IDLE_MIN_MS = 150_000
const SPONT_ATTEMPT_INTERVAL_MS = 150_000
const SPONT_CHANCE = 0.4
/** 久坐提醒触发后的重计间隔(提醒完重新计时,而不是立刻再攒) */
const BREAK_REMIND_COOLDOWN_MS = 30 * 60_000
const HOUR_MS = 3_600_000

export interface SchedulerDeps {
  /** 备忘扫描:每次 tick 必调(内部幂等,fired 标记);卡片永远即时,语音部分自己判断空闲 */
  sweepMemos(): Promise<void>
  /** 久坐提醒:闸门已过,返回是否真的提醒了 */
  breakRemind(): Promise<boolean>
  /** 自动重放:闸门已过,返回是否真的播了(没历史/正在播 = false) */
  autoReplay(): Promise<boolean>
  /** 自发闲聊:闸门已过,返回是否真的播了 */
  spontaneous(): Promise<boolean>
}

// ---------- 时序状态(模块内;App 只管"做什么",这里管"什么时候") ----------

let workStart: number | null = null // 连续活跃起点;键鼠空闲≥5分钟清零
let lastBreakAt = 0
let lastSpontAttempt = 0
let lastSpontSuccess = 0
let lastReplayAt = 0
let lastActivityAt = Date.now()
/** 最近一次进入"可主动"状态的时刻;不可主动期间为 null(空闲计时停在原地) */
let allowedSince: number | null = null
let replayedInStretch = false // 一次连续空闲段最多自动重放一集(与旧 setTimeout 语义一致)
let quota: number[] = [] // 主动说话时间戳,滑动 1 小时窗口
let timer: ReturnType<typeof setInterval> | null = null

/** 用户主动互动(戳/聊天/点播/框选完成):重置空闲计时与降频连击 */
export function noteActivity(): void {
  lastActivityAt = Date.now()
}

/** 问候占用自发预算:传过去的时间戳(问候后约 1 分钟自发才可用 → now-14min) */
export function noteSpontaneous(atMs: number): void {
  lastSpontAttempt = atMs
  lastSpontSuccess = atMs
}

function recordQuota(): void {
  quota.push(Date.now())
}

async function quotaAvailable(
  proactivity: 'quiet' | 'balanced' | 'lively',
): Promise<boolean> {
  const now = Date.now()
  quota = quota.filter((t) => now - t < HOUR_MS)
  return quota.length < QUOTA_PER_HOUR[proactivity]
}

async function tick(deps: SchedulerDeps): Promise<void> {
  // 备忘永远先跑:到点的事必须说(卡片即时;语音内部判断空闲,勿扰时 TTS 自静)
  try {
    await deps.sweepMemos()
  } catch {
    // 静默:扫描失败下个 tick 再来
  }

  const caps = getCaps()
  // 统一闸门:非空闲/有面板/勿扰/角色隐藏/全屏 → 什么都别主动,空闲计时停在原地
  if (!caps.proactiveAllowed || caps.charHidden || isFullscreenApp()) {
    allowedSince = null
    return
  }
  const now = Date.now()
  if (allowedSince === null) {
    allowedSince = now
    replayedInStretch = false
  }
  const idleFor = now - Math.max(allowedSince, lastActivityAt)

  const cfg = await getConfig()
  if (!(await quotaAvailable(cfg.proactivity))) return

  // 1) 久坐提醒 > 2) 自动重放 > 3) 自发闲聊;同一 tick 最多一件事
  if (cfg.breakReminder.enabled && now - lastBreakAt >= BREAK_REMIND_COOLDOWN_MS * (await dismissCooldownMultiplier('break'))) {
    if (!isUserActive()) {
      workStart = null // 用户在休息,计时清零
    } else {
      if (workStart === null) workStart = now
      const need = Math.min(120, Math.max(15, cfg.breakReminder.minutes || 45))
      if (now - workStart >= need * 60_000) {
        lastBreakAt = now
        workStart = now // 提醒后重新计时
        recordQuota()
        try {
          await deps.breakRemind()
        } catch {
          // 静默:提醒宁可错过
        }
        return
      }
    }
  }

  if (cfg.autoReplayMin > 0 && !replayedInStretch) {
    const mult = await dismissCooldownMultiplier('replay')
    const due = idleFor >= cfg.autoReplayMin * 60_000 && now - lastReplayAt >= cfg.autoReplayMin * 60_000 * mult
    if (due) {
      lastReplayAt = now
      try {
        if (await deps.autoReplay()) {
          replayedInStretch = true
          recordQuota()
          return
        }
      } catch {
        // 静默
      }
    }
  }

  if (cfg.proactivity !== 'quiet' && cfg.autoReplayMin > 0 && !isQuietHours()) {
    const mult = await dismissCooldownMultiplier('spontaneous')
    const due =
      idleFor >= SPONT_IDLE_MIN_MS &&
      now - lastSpontAttempt >= SPONT_ATTEMPT_INTERVAL_MS * mult &&
      now - lastSpontSuccess >= 15 * 60_000 * mult
    if (due && Math.random() < SPONT_CHANCE) {
      lastSpontAttempt = now
      try {
        if (await deps.spontaneous()) {
          lastSpontSuccess = now
          recordQuota()
        }
      } catch {
        // 静默:自发内容宁可错过
      }
    }
  }
}

/** 启动调度器,返回停止函数。deps 闭包使用 App 首帧实例即可(内部只依赖 ref 与模块函数) */
export function startScheduler(deps: SchedulerDeps): () => void {
  if (timer) return () => {}
  lastActivityAt = Date.now()
  allowedSince = Date.now()
  timer = setInterval(() => {
    void tick(deps)
  }, TICK_MS)
  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}

export type { DismissableKind }
