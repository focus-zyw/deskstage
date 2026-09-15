// 表达动作策略(方案 §三):权重表由代码抽取,概率不让模型自己遵守"百分比"。
// 冷却规则全部在这里执行:
// · 同一动作最多连续两次(MOVE_REPEAT_LIMIT);
// · 旧梗间隔至少六个角色回合(CALLBACK_GAP_ROUNDS);
// · 口头禅间隔至少八个角色回合(CATCHPHRASE_GAP_ROUNDS,禁用指令+质量闸配合);
// · 不能连续两轮都反问用户(mayAskQuestion=false 时禁 challenge);
// · absurd-leap 与 literalize 不能同时出现(单轮单动作天然满足;相邻轮也互斥降温);
// · 用户提出明确任务时强制 direct,先完成或回答,再发挥性格。
//
// 纯函数 + 显式 PolicyState(由 director 在"提交成功"后推进——规划/重试/网页
// 恢复重建都不虚增回合)。不碰模型、不碰存储、不碰时钟。

import type { CallbackRef, ExpressionIntent, ExpressionLength, ExpressionMove, ExpressionStance } from './types'
import type { VoiceMechanics } from './voiceProfile'

export const BASE_WEIGHTS: Record<ExpressionMove, number> = {
  direct: 35,
  tease: 15,
  challenge: 10,
  'absurd-leap': 10,
  literalize: 7,
  callback: 7,
  deflect: 6,
  vulnerable: 4,
  pivot: 4,
  close: 2,
}

export const MOVE_REPEAT_LIMIT = 2
export const CALLBACK_GAP_ROUNDS = 6
export const CATCHPHRASE_GAP_ROUNDS = 8

/** 角色回合记账(director 按 actor 各持一份;只在 noteSpoken 时推进) */
export interface PolicyState {
  /** 已提交发言的回合数(0 起) */
  round: number
  /** 最近提交的动作,新在前(最多保留 2 个) */
  lastMoves: ExpressionMove[]
  /** 上次 callback 动作的回合号;-1 = 从未 */
  lastCallbackRound: number
  /** 上次 absurd-leap/literalize 的回合号;-1 = 从未 */
  lastLeapRound: number
  /** 口头禅冷却:上次实际用出的短语与回合(文本检测,见 director.noteSpoken) */
  lastCatchphrase: { phrase: string; round: number } | null
}

export function freshPolicyState(): PolicyState {
  return { round: 0, lastMoves: [], lastCallbackRound: -1, lastLeapRound: -1, lastCatchphrase: null }
}

/** 用户明确任务启发式(保守:祈使/交付类才命中;命中即先答任务再发挥) */
export function detectTask(stimulus: string): boolean {
  return /(帮我|替我|给我(写|查|翻|算|推荐|列|讲|找)|翻译(一?下)?|总结一下|写一[篇个下]|列一[个下份]|算一[下算]|查一[下查]|提醒我|搜[一索]下|怎么(办|弄|做)|推荐一下|是多少)/.test(
    stimulus,
  )
}

/** 结构化决策核心:动作/立场/长度/旧梗(不含 instruction 渲染与约束拼装) */
export interface PlanCore {
  intent: ExpressionIntent
  move: ExpressionMove
  stance: ExpressionStance
  length: ExpressionLength
  callback?: CallbackRef
  mustAnswerTask: boolean
}

export interface DecideArgs {
  stimulus: string
  mayAskQuestion: boolean
  mechanics: VoiceMechanics
  state: Readonly<PolicyState>
  /** callbackPicker 预选的旧梗候选(policy 负责 6 回合间隔闸) */
  callback?: CallbackRef
  rng: () => number
  /** 反馈学习乘数(阶段一恒 1;阶段三由 preferenceStore 提供) */
  prefMultiplier?: (move: ExpressionMove) => number
}

/** 单轮唯一动作的合格性:全部冷却规则落在这里(导出供纯逻辑单测) */
export function eligibleMoves(args: DecideArgs): ExpressionMove[] {
  const { state, callback, mayAskQuestion } = args
  const [last, secondLast] = state.lastMoves
  const repeatedTwice = last !== undefined && last === secondLast
  return (Object.keys(BASE_WEIGHTS) as ExpressionMove[]).filter((move) => {
    if (repeatedTwice && move === last) return false
    if (move === 'callback') {
      if (!callback) return false
      // 冷却只从"上次使用"起算:从未用过(-1)不设冷却
      if (state.lastCallbackRound >= 0 && state.round - state.lastCallbackRound < CALLBACK_GAP_ROUNDS) {
        return false
      }
    }
    if (move === 'absurd-leap' || move === 'literalize') {
      // 互斥:上一轮刚出现过其中之一,本轮两者都歇(单轮单动作已保证不同时)
      if (last === 'absurd-leap' || last === 'literalize') return false
    }
    if (move === 'challenge' && !mayAskQuestion) return false
    return true
  })
}

function weightOf(move: ExpressionMove, args: DecideArgs): number {
  let w = BASE_WEIGHTS[move]
  w *= args.mechanics.humor.includes(move) ? 1.6 : 0.7
  if (move === 'tease' || move === 'challenge') w *= 0.5 + args.mechanics.social.teasingIntensity
  if (move === 'pivot' || move === 'close') w *= 0.5 + args.mechanics.social.initiative
  w *= args.prefMultiplier?.(move) ?? 1
  return Math.max(w, 0.0001)
}

function weightedPick(moves: ExpressionMove[], args: DecideArgs): ExpressionMove {
  const weights = moves.map((m) => weightOf(m, args))
  const total = weights.reduce((a, b) => a + b, 0)
  let roll = args.rng() * total
  for (let i = 0; i < moves.length; i++) {
    roll -= weights[i]!
    if (roll <= 0) return moves[i]!
  }
  return moves[moves.length - 1]!
}

/** 防御反应:stimulus 命中防御触发词(如"被夸/被关心")→ 本轮改用防御动作。
 *  触发词从 trigger 文本里抠(去"被",按 或/和/、 切开),只做字面匹配 */
function defenseTriggered(stimulus: string, mechanics: VoiceMechanics): boolean {
  const words = mechanics.defense.trigger
    .replace(/被/g, '')
    .split(/[或和、,，\s]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 1)
  return words.some((w) => stimulus.includes(w))
}

function pickLength(preferred: VoiceMechanics['rhythm']['preferredLength'], rng: () => number): ExpressionLength {
  const r = rng()
  if (preferred === 'micro') return r < 0.6 ? 'micro' : r < 0.95 ? 'short' : 'medium'
  if (preferred === 'short') return r < 0.2 ? 'micro' : r < 0.8 ? 'short' : 'medium'
  return r < 0.25 ? 'micro' : r < 0.7 ? 'short' : 'medium'
}

function pickStance(bias: number, move: ExpressionMove, rng: () => number): ExpressionStance {
  if (move === 'challenge') return rng() < 0.75 ? 'doubt' : 'disagree'
  if (move === 'vulnerable') return 'neutral'
  const r = rng()
  if (bias >= 0.66) return r < 0.6 ? 'agree' : r < 0.9 ? 'neutral' : 'doubt'
  if (bias >= 0.33) {
    if (r < 0.4) return 'agree'
    if (r < 0.8) return 'neutral'
    return r < 0.95 ? 'doubt' : 'disagree'
  }
  if (r < 0.15) return 'agree'
  if (r < 0.55) return 'neutral'
  return r < 0.85 ? 'doubt' : 'disagree'
}

function pickIntent(move: ExpressionMove, stimulusIsQuestion: boolean): ExpressionIntent {
  if (move === 'close') return 'close'
  if (move === 'pivot') return 'shift'
  if (move === 'deflect' || move === 'vulnerable') return 'defend'
  if (stimulusIsQuestion && (move === 'direct' || move === 'tease')) return 'answer'
  return 'react'
}

/** 单轮决策主入口:任务优先 → 防御反应 → 冷却过滤 → 加权抽取 → 立场/长度 */
export function decidePlanCore(args: DecideArgs): PlanCore {
  const stimulusIsQuestion = /[?？]\s*$/.test(args.stimulus.trim())
  const task = detectTask(args.stimulus)
  if (task) {
    return {
      intent: 'answer',
      move: 'direct',
      stance: pickStance(args.mechanics.social.agreementBias, 'direct', args.rng),
      length: pickLength(args.mechanics.rhythm.preferredLength, args.rng),
      mustAnswerTask: true,
    }
  }
  let moves = eligibleMoves(args)
  if (moves.length === 0) moves = ['direct']
  let move = weightedPick(moves, args)
  // 防御反应(方案 §四 defense):触发时改用防御动作,但仍受冷却合格性约束
  // (defense 不在合格集 = 正处冷却/连发上限,保持原抽取结果)
  const defense = args.mechanics.defense.response
  if (move !== 'direct' && defense !== move && moves.includes(defense) && defenseTriggered(args.stimulus, args.mechanics)) {
    move = defense
  }
  const core: PlanCore = {
    intent: task ? 'answer' : pickIntent(move, stimulusIsQuestion),
    move,
    stance: pickStance(args.mechanics.social.agreementBias, move, args.rng),
    length: pickLength(args.mechanics.rhythm.preferredLength, args.rng),
    mustAnswerTask: false,
  }
  if (move === 'callback' && args.callback) core.callback = args.callback
  return core
}
