// 抉择点闸门(纯函数):应用侧掷中"本集应有观众抉择点"后,模型可能没写、
// 也可能写了但不完整(选项≠2/缺prompt)。这两类违约在 parse/validate 层都是
// 静默通过——校验只在 choice 存在时才检查分支——面板于是无声消失。
// 这里把违约转成一次定向修复议题,交给生成侧既有的定点修复/重试链路;
// 软性约束:救不回就按无抉择播出,绝不因此把整集好剧本推去兜底。
import type { PerformanceScript } from '../performer/dialogSchema'

export interface ChoiceAskInput {
  /** 本集掷中了抉择点(协议要求必须包含);未掷中时不做任何要求 */
  allowChoice: boolean
  script: Pick<PerformanceScript, 'choice'>
  /** parse 层上交的"写了但不合格"choice 原文(onChoiceRejected 钩子) */
  rejectedRaw?: unknown
}

/** 原文塞进修复议题的长度上限:够模型辨认结构即可,防超长输出挤爆修复 prompt */
const REJECTED_RAW_CAP = 400

/** 返回修复议题(空数组 = 无需修复:未掷中,或 choice 已合格存在) */
export function evaluateChoiceAsk(input: ChoiceAskInput): string[] {
  if (!input.allowChoice || input.script.choice) return []
  if (input.rejectedRaw != null) {
    const rawText = safeStringify(input.rejectedRaw)
    return [
      `协议要求本段必须包含一个观众抉择点,但上次输出的 choice 对象不完整(需要:15字内 prompt + 恰好两个选项,每个含英文短id与中文label)。请修正下面这个抉择点并插回 dialog 剧情冲突最激烈的中段,其后每句台词带 "branch":"<所支持选项id>",两个分支各3~5句、收同一个底包袱。原文:${rawText}`,
    ]
  }
  return [
    '缺失观众抉择点:本段协议要求必须包含恰好一个 choice 对象(15字内 prompt + 恰好两个选项),请在剧情冲突最激烈的中段插入,其后每句台词带 "branch":"<所支持选项id>",两个分支各3~5句、收同一个底包袱。',
  ]
}

function safeStringify(v: unknown): string {
  try {
    return (JSON.stringify(v) ?? '').slice(0, REJECTED_RAW_CAP)
  } catch {
    return '(不可序列化)'
  }
}
