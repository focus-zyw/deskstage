// 主动行为调度器:全应用唯一的"现在该不该主动说话"决策点。
// 为什么:此前问候/自发聊天/久坐提醒/备忘扫描/自动重放各自持定时器与守卫,
// 无优先级、无配额、无"用户连续忽略就降频",新功能只能继续加散装定时器。
// 设计:单一 15s tick。备忘扫描每次 tick 必跑(用户定的事,卡片即时、不参与竞争);
// 其余主动行为(久坐>重放>自发)按优先级竞争,同一 tick 最多发一件事,全部计入
// 小时配额(主动程度:安静3/平衡6/热闹12)。用户提前掐断同类行为连续 3 次该类冷却翻倍。
// 时序状态(工作起始/上次触发/空闲起点)收编到模块内,原来散在 App 的 refs 一并迁入。
// 影子大脑挂点(docs/影子大脑桥接设计方案.md):observe 每 tick 回传一次结构化评估
// (理由显式化,影子配对的数据源);consult 在候选触发前问外部大脑(takeover 模式),
// 超时/未接/无裁决一律回落本地,绝不因外部卡住演出。

import { getCaps } from './runtimeMode'
import { getConfig } from '../storage/configStore'
import { isQuietHours } from '../engine/timeAware'
import { isFullscreenApp, isUserActive } from '../world'
import { dismissCooldownMultiplier, type DismissableKind } from '../storage/interactionStore'
import type { LocalEvaluation } from '../brain/types'

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

/** 接管裁决:listen = 本轮别播;speak = 播(可带外部台词,缺省走本地生成);null = 没问到,回落本地 */
export type ConsultVerdict = { verdict: 'speak'; lines?: readonly unknown[] } | 'listen'

export interface SchedulerDeps {
  /** 备忘扫描:每次 tick 必调(内部幂等,fired 标记);卡片永远即时,语音部分自己判断空闲 */
  sweepMemos(): Promise<void>
  /** 久坐提醒:闸门已过,返回是否真的提醒了;overrideLines = 接管裁决给定的台词 */
  breakRemind(overrideLines?: readonly unknown[]): Promise<boolean>
  /** 自动重放:闸门已过,返回是否真的播了(没历史/正在播 = false) */
  autoReplay(): Promise<boolean>
  /** 自发闲聊:闸门已过,返回是否真的播了;overrideLines = 接管裁决给定的台词 */
  spontaneous(overrideLines?: readonly unknown[]): Promise<boolean>
  /** 影子大脑:每 tick 结束前回传一次本地评估(可选,影子/接管模式才注入) */
  observe?(evaluation: LocalEvaluation): void
  /** 影子大脑:候选触发前问外部大脑(可选,仅 takeover 注入;null/超时 = 回落本地) */
  consult?(candidate: 'spontaneous' | 'break'): Promise<ConsultVerdict | null>
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

/** 调度器时序只读快照(影子大脑快照用;不暴露可变引用) */
export interface SchedulerTiming {
  allowedSince: number | null
  lastActivityAt: number
  lastSpontAttempt: number
  lastSpontSuccess: number
  lastReplayAt: number
  lastBreakAt: number
  quotaCount: number
}

export function schedulerTiming(): SchedulerTiming {
  return {
    allowedSince,
    lastActivityAt,
    lastSpontAttempt,
    lastSpontSuccess,
    lastReplayAt,
    lastBreakAt,
    quotaCount: quota.length,
  }
}

/** 当前主动程度档的小时配额上限(影子大脑快照用) */
export function quotaCapOf(proactivity: 'quiet' | 'balanced' | 'lively'): number {
  return QUOTA_PER_HOUR[proactivity]
}

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

/** 把 consult 裁决折成 (是否跳过, 接管台词);note 记录裁决走向 */
async function consultOf(
  deps: SchedulerDeps,
  candidate: 'spontaneous' | 'break',
  notes: string[],
): Promise<{ skip: boolean; lines?: readonly unknown[] }> {
  if (!deps.consult) return { skip: false }
  // 外部大脑的任何异常都按"没问到"处理——接管绝不放大故障
  let verdict: ConsultVerdict | null
  try {
    verdict = await deps.consult(candidate)
  } catch {
    return { skip: false }
  }
  if (verdict === 'listen') {
    notes.push(`接管:外部大脑裁决 listen,${candidate === 'break' ? '久坐' : '自发'}本轮不播`)
    return { skip: true }
  }
  if (verdict && verdict.verdict === 'speak' && verdict.lines && verdict.lines.length > 0) {
    notes.push('接管:外部大脑裁决 speak(台词接管)')
    return { skip: false, lines: verdict.lines }
  }
  notes.push('接管:外部大脑裁决 speak(本地措辞)')
  return { skip: false }
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
    deps.observe?.({
      blocked: 'gate',
      candidate: 'none',
      fired: false,
      decline: null,
      idleForMs: 0,
      quotaUsed: quota.length,
      reasons: ['总闸门:勿扰/面板/演出/语音/全屏/角色隐藏'],
    })
    return
  }
  const now = Date.now()
  if (allowedSince === null) {
    allowedSince = now
    replayedInStretch = false
  }
  const idleFor = now - Math.max(allowedSince, lastActivityAt)

  const cfg = await getConfig()
  if (!(await quotaAvailable(cfg.proactivity))) {
    deps.observe?.({
      blocked: 'quota',
      candidate: 'none',
      fired: false,
      decline: null,
      idleForMs: idleFor,
      quotaUsed: quota.length,
      reasons: [`小时配额已满(${quota.length}/${QUOTA_PER_HOUR[cfg.proactivity]})`],
    })
    return
  }

  const notes: string[] = []
  // 1) 久坐提醒 > 2) 自动重放 > 3) 自发闲聊;同一 tick 最多一件事
  if (cfg.breakReminder.enabled && now - lastBreakAt >= BREAK_REMIND_COOLDOWN_MS * (await dismissCooldownMultiplier('break'))) {
    if (!isUserActive()) {
      workStart = null // 用户在休息,计时清零
      notes.push('久坐:用户在休息,工作计时清零')
    } else {
      if (workStart === null) workStart = now
      const need = Math.min(120, Math.max(15, cfg.breakReminder.minutes || 45))
      const worked = now - workStart
      if (worked >= need * 60_000) {
        const { skip, lines } = await consultOf(deps, 'break', notes)
        lastBreakAt = now
        workStart = now // 提醒后重新计时
        if (skip) {
          deps.observe?.(finalEval('break', false, 'takeover-listen', idleFor, notes))
          return
        }
        recordQuota()
        let firedBreak = false
        try {
          firedBreak = await deps.breakRemind(lines)
        } catch {
          // 静默:提醒宁可错过
        }
        deps.observe?.(finalEval('break', firedBreak, firedBreak ? null : 'producers-declined', idleFor, notes))
        return
      }
      notes.push(`久坐:连续工作 ${Math.round(worked / 60_000)}/${need} 分钟`)
    }
  } else if (cfg.breakReminder.enabled) {
    notes.push('久坐:上次提醒后冷却中')
  }

  if (cfg.autoReplayMin > 0 && !replayedInStretch) {
    const mult = await dismissCooldownMultiplier('replay')
    const due = idleFor >= cfg.autoReplayMin * 60_000 && now - lastReplayAt >= cfg.autoReplayMin * 60_000 * mult
    if (due) {
      lastReplayAt = now
      let firedReplay = false
      try {
        if (await deps.autoReplay()) {
          firedReplay = true
          replayedInStretch = true
          recordQuota()
        }
      } catch {
        // 静默
      }
      if (firedReplay) {
        deps.observe?.(finalEval('replay', true, null, idleFor, notes))
        return
      }
      notes.push('重放:没有可播历史或正在播出')
    } else {
      notes.push(idleFor < cfg.autoReplayMin * 60_000 ? '重放:空闲未够' : '重放:冷却中')
    }
  } else {
    notes.push(cfg.autoReplayMin <= 0 ? '重放:已关闭' : '重放:本空闲段已放过')
  }

  if (cfg.proactivity !== 'quiet' && cfg.autoReplayMin > 0 && !isQuietHours()) {
    const mult = await dismissCooldownMultiplier('spontaneous')
    const dueIdle = idleFor >= SPONT_IDLE_MIN_MS
    const dueAttempt = now - lastSpontAttempt >= SPONT_ATTEMPT_INTERVAL_MS * mult
    const dueSuccess = now - lastSpontSuccess >= 15 * 60_000 * mult
    const due = dueIdle && dueAttempt && dueSuccess
    if (due && Math.random() < SPONT_CHANCE) {
      const { skip, lines } = await consultOf(deps, 'spontaneous', notes)
      lastSpontAttempt = now
      if (skip) {
        deps.observe?.(finalEval('spontaneous', false, 'takeover-listen', idleFor, notes))
        return
      }
      let fired = false
      try {
        if (await deps.spontaneous(lines)) {
          fired = true
          lastSpontSuccess = now
          recordQuota()
        }
      } catch {
        // 静默:自发内容宁可错过
      }
      deps.observe?.(
        finalEval('spontaneous', fired, fired ? null : 'producers-declined', idleFor, notes),
      )
      return
    }
    if (!dueIdle) notes.push('自发:连续空闲未够')
    else if (!dueAttempt || !dueSuccess) notes.push('自发:冷却中(用户连掐降频)')
    else notes.push(`自发:掷点未中(${Math.round(SPONT_CHANCE * 100)}%)`)
  } else {
    notes.push(
      cfg.proactivity === 'quiet' || cfg.autoReplayMin <= 0
        ? '自发:已关闭(安静档或无重放历史)'
        : '自发:深夜静音时段',
    )
  }
    deps.observe?.(finalEval('spontaneous', false, spontaneousDeclineOf(notes), idleFor, notes))
}

/** 无 firing 时的评估:候选恒为自发(优先级末位,它的结论就是"这 tick 为什么没说话") */
function spontaneousDeclineOf(notes: string[]): LocalEvaluation['decline'] {
  const last = notes[notes.length - 1] ?? ''
  if (last.includes('接管')) return 'takeover-listen'
  if (last.includes('静音时段')) return 'quiet-hours'
  if (last.includes('已关闭')) return 'disabled'
  if (last.includes('掷点未中')) return 'chance'
  if (last.includes('冷却中')) return 'cooldown'
  if (last.includes('空闲未够')) return 'not-due'
  return 'producers-declined'
}

function finalEval(
  candidate: LocalEvaluation['candidate'],
  fired: boolean,
  decline: LocalEvaluation['decline'],
  idleForMs: number,
  notes: string[],
): LocalEvaluation {
  return {
    blocked: null,
    candidate,
    fired,
    decline: fired ? null : decline,
    idleForMs,
    quotaUsed: quota.length,
    reasons: notes.slice(0, 6).map((n) => n.slice(0, 60)),
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
