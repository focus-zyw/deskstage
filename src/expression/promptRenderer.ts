// 本轮表达指令渲染(方案 §五):结构化 Plan → 一段中文指令。
// 确定性模板拼接,无模型调用;指令必须每轮注入 prompt(含网页增量轮),
// 因此保持短小(3~7 行),并明确"执行即可,不得复述"防指令泄漏上屏。

import type {
  CallbackRef,
  ExpressionIntent,
  ExpressionLength,
  ExpressionMove,
  ExpressionStance,
} from './types'

const MOVE_LINES: Record<ExpressionMove, string> = {
  direct: '直接回应,不绕弯子',
  tease: '轻微调侃一句,点到为止,不攻击人',
  challenge: '不完全同意,反问或拆一下对方的前提',
  'absurd-leap': '用一个突然但说得通的荒诞类比轻轻偏转',
  literalize: '自然而然地按字面理解对方的话',
  callback: '自然回收大家的共同旧梗',
  deflect: '嘴硬岔开,不正面接招',
  vulnerable: '短暂说一句真实情绪,马上收住',
  pivot: '主动把话题带到相关的新方向',
  close: '自然收尾,不强行延续话题',
}

const STANCE_LINES: Record<ExpressionStance, string> = {
  agree: '基本同意,但不表现得过分热情',
  neutral: '中性接话,不急着站队',
  doubt: '不完全同意,保留怀疑',
  disagree: '不同意,但就事论事,不攻击人',
}

function lengthLine(length: ExpressionLength, maxChars: number): string {
  if (length === 'micro') return `一句短句,总长不超过 ${maxChars} 字`
  if (length === 'short') return `一两个短句,总长不超过 ${maxChars} 字`
  return `最多三个短句,总长不超过 ${maxChars} 字`
}

export interface RenderInstructionArgs {
  intent: ExpressionIntent
  move: ExpressionMove
  stance: ExpressionStance
  length: ExpressionLength
  maxChars: number
  mayAskQuestion: boolean
  mustAnswerTask: boolean
  callback?: CallbackRef
  /** 碎句倾向高:允许半截话(来自 VoiceMechanics.rhythm.fragmentChance) */
  fragment: boolean
  /** 口头禅冷却中:点名字面禁用 */
  bannedCatchphrase?: string
  /** 角色禁令(VoiceMechanics.forbiddenPatterns,最多渲染 3 条) */
  forbiddenPatterns: string[]
}

/** 渲染本轮表达指令;每轮注入 system(prompt 两种形态都携带) */
export function renderInstruction(args: RenderInstructionArgs): string {
  const lines: string[] = ['本轮表达策略(执行即可,不得复述):']
  if (args.mustAnswerTask) {
    lines.push('- 先直接完成用户交代的任务或回答问题,再谈别的。')
  } else if (args.intent === 'close') {
    lines.push('- 这轮自然收住,不强行开启新话头。')
  } else {
    lines.push('- 直接回应这条消息。')
  }
  lines.push(`- 立场:${STANCE_LINES[args.stance]}。`)
  lines.push(`- 表达动作:${MOVE_LINES[args.move]}。`)
  lines.push(`- 长度:${lengthLine(args.length, args.maxChars)}${args.fragment ? ',可以说半截话' : ''}。`)
  if (args.callback) {
    lines.push(`- 旧梗回收:把「${args.callback.text}」自然带进话里,一带而过,不解释梗的来历。`)
  }
  if (!args.mayAskQuestion || args.move === 'close') {
    lines.push('- 不要反问,不要追问。')
  }
  if (args.bannedCatchphrase) {
    lines.push(`- 不使用最近出现过的口头禅「${args.bannedCatchphrase}」。`)
  }
  const taboos = args.forbiddenPatterns.slice(0, 3)
  if (taboos.length > 0) {
    lines.push(`- 不要:${taboos.join(';')}。`)
  }
  return lines.join('\n')
}
