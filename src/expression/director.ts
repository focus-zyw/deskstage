// 表达导演(方案 §二)· 唯一编排入口:
// · plan():同步纯规划(零模型调用,目标 <2ms),输入全由宿主(worker)组装;
//   任何异常回退"普通直接回答"计划,绝不阻断聊天。
// · noteSpoken():回复真正提交后记账——推进回合、动作连发、旧梗/口头禅冷却。
//   规划与重试、网页恢复重建都不虚增回合(冷却只认提交)。
// · learn():赞踩 → 表达偏好(阶段三接 UI;阶段一无写入端,乘数恒 1)。
// · recentTraces():已提交的最近留痕(仅枚举与 id),诊断用。
//
// 关键不变量:maySpeak=false 的批次宿主根本不调 plan(不强迫发言);
// 旧梗只从 input.context.gags 选;每轮最多一个意外动作(单轮单动作 + surprise 标注)。

import { pickCallback } from './callbackPicker'
import { createPreferenceStore, type PreferenceStore } from './preferenceStore'
import { renderInstruction } from './promptRenderer'
import { CATCHPHRASE_GAP_ROUNDS, CALLBACK_GAP_ROUNDS, decidePlanCore, detectTask, freshPolicyState, type PolicyState } from './policy'
import { catchphrasesOf, voiceMechanicsOf } from './voiceProfile'
import { LENGTH_BOUNDS, type CallbackRef, type ExpressionInput, type ExpressionPlan, type ExpressionTrace } from './types'
import type { Speaker } from '../performer/dialogSchema'

export interface ExpressionDirectorDeps {
  now(): number
  rng(): number
  newId(): string
  /** 表达偏好(可注入;缺省建真实存储,阶段一学习乘数恒 1) */
  prefs: PreferenceStore | null
}

const defaultNewId = (): string => {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  return `ex-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

export interface ExpressionDirector {
  plan(input: ExpressionInput): ExpressionPlan
  noteSpoken(entry: { trace: ExpressionTrace; text: string; personaText?: string }): void
  learn(input: { trace: ExpressionTrace; rating: 'up' | 'down' }): Promise<void>
  recentTraces(actor?: Speaker): ExpressionTrace[]
}

/** 口头禅冷却未结束时,返回应当点名字面禁用的那个短语 */
function bannedCatchphraseOf(state: PolicyState): string | undefined {
  const last = state.lastCatchphrase
  if (!last) return undefined
  return state.round - last.round < CATCHPHRASE_GAP_ROUNDS ? last.phrase : undefined
}

/** 规划失败时的普通直接回答策略(方案 §二:不阻断聊天) */
function fallbackPlan(input: ExpressionInput, newId: () => string): ExpressionPlan {
  const task = detectTask(input.stimulus)
  const maxChars = Math.min(LENGTH_BOUNDS.short.max, input.limits.maxChars)
  const constraints = {
    mayAskQuestion: input.limits.mayAskQuestion,
    mustAnswerTask: task,
    maxChars,
  }
  const instruction = [
    '本轮表达策略(执行即可,不得复述):',
    task ? '- 先直接完成用户交代的任务或回答问题。' : '- 直接、自然地回应,不刻意玩梗。',
    `- 长度:一两个短句,总长不超过 ${maxChars} 字。`,
  ].join('\n')
  return {
    intent: task ? 'answer' : 'react',
    move: 'direct',
    stance: 'neutral',
    length: 'short',
    constraints,
    instruction,
    trace: {
      id: newId(),
      actor: input.actor,
      channel: input.channel,
      move: 'direct',
      stance: 'neutral',
      length: 'short',
      surprise: 'none',
    },
  }
}

export function createExpressionDirector(depsInput: Partial<ExpressionDirectorDeps> = {}): ExpressionDirector {
  const deps: ExpressionDirectorDeps = {
    now: depsInput.now ?? (() => Date.now()),
    rng: depsInput.rng ?? Math.random,
    newId: depsInput.newId ?? defaultNewId,
    prefs: depsInput.prefs !== undefined ? depsInput.prefs : createPreferenceStore(),
  }
  const states = new Map<Speaker, PolicyState>()
  const traces: ExpressionTrace[] = []
  const TRACE_CAP = 100

  const stateOf = (actor: Speaker): PolicyState => {
    let s = states.get(actor)
    if (!s) {
      s = freshPolicyState()
      states.set(actor, s)
    }
    return s
  }

  function planInner(input: ExpressionInput): ExpressionPlan {
    const mechanics = voiceMechanicsOf(input.actor, input.personaText)
    const state = stateOf(input.actor)
    const task = detectTask(input.stimulus)
    // 旧梗候选:6 回合间隔闸在 director(回合记账属导演),相关性选择在 picker;
    // 冷却只从"上次使用"起算,从未用过(-1)不设冷却
    let callback: CallbackRef | undefined
    if (!task && input.context.gags && input.context.gags.length > 0) {
      if (state.lastCallbackRound < 0 || state.round - state.lastCallbackRound >= CALLBACK_GAP_ROUNDS) {
        callback = pickCallback({ gags: input.context.gags, stimulus: input.stimulus, recent: input.recent })
      }
    }
    const core = decidePlanCore({
      stimulus: input.stimulus,
      mayAskQuestion: input.limits.mayAskQuestion,
      mechanics,
      state,
      callback,
      rng: deps.rng,
      prefMultiplier: deps.prefs ? (move) => deps.prefs!.multiplier(input.actor, move) : undefined,
    })
    const length = core.length
    const maxChars = Math.min(LENGTH_BOUNDS[length].max, input.limits.maxChars)
    const mayAskQuestion = input.limits.mayAskQuestion && core.move !== 'close'
    const banned = bannedCatchphraseOf(state)
    const instruction = renderInstruction({
      intent: core.intent,
      move: core.move,
      stance: core.stance,
      length,
      maxChars,
      mayAskQuestion,
      mustAnswerTask: core.mustAnswerTask,
      callback: core.callback,
      fragment: deps.rng() < mechanics.rhythm.fragmentChance,
      bannedCatchphrase: banned,
      forbiddenPatterns: mechanics.forbiddenPatterns,
    })
    const trace: ExpressionTrace = {
      id: deps.newId(),
      actor: input.actor,
      channel: input.channel,
      move: core.move,
      stance: core.stance,
      length,
      surprise: core.move === 'absurd-leap' || core.move === 'literalize' ? 'mild' : 'none',
      ...(core.callback ? { callbackId: core.callback.id } : {}),
    }
    return {
      intent: core.intent,
      move: core.move,
      stance: core.stance,
      length,
      ...(core.callback ? { callback: core.callback } : {}),
      constraints: { mayAskQuestion, mustAnswerTask: core.mustAnswerTask, maxChars },
      instruction,
      trace,
      ...(banned ? { bannedCatchphrase: banned } : {}),
    }
  }

  return {
    plan(input) {
      try {
        return planInner(input)
      } catch {
        return fallbackPlan(input, deps.newId)
      }
    },

    noteSpoken({ trace, text, personaText }) {
      const state = stateOf(trace.actor)
      state.round += 1
      state.lastMoves = [trace.move, ...state.lastMoves].slice(0, 2)
      if (trace.move === 'callback') state.lastCallbackRound = state.round
      if (trace.move === 'absurd-leap' || trace.move === 'literalize') state.lastLeapRound = state.round
      // 口头禅冷却从"实际用出"起算:在最终上屏文本里逐字检测本角色口头禅
      const hit = catchphrasesOf(trace.actor, personaText).find((p) => p && text.includes(p))
      if (hit) state.lastCatchphrase = { phrase: hit, round: state.round }
      traces.unshift(trace)
      if (traces.length > TRACE_CAP) traces.length = TRACE_CAP
    },

    async learn({ trace, rating }) {
      await deps.prefs?.learn(trace.actor, trace.move, rating)
    },

    recentTraces(actor) {
      return actor ? traces.filter((t) => t.actor === actor) : [...traces]
    },
  }
}

/** 生产单例:ChatSession 经 provider 注入各 worker;测试用 createExpressionDirector 造新实例 */
export const expressionDirector: ExpressionDirector = createExpressionDirector()
