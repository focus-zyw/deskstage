// 招牌怪癖·演出注入渲染(纯函数,设计方案 §5.1)。
// 注入指令用五句完整措辞(逐字,不得压缩)——"背景重力,不是任务"只是开发文档层面的
// 设计原则:压缩成短语会丢掉"未命中不得造话题""命中也可不表现"两个可执行约束。

import type { ActorSlot } from '../engine/persona'
import type { QuirkBook } from './types'

export const QUIRK_INJECTION_RULES: readonly string[] = [
  '怪癖是背景倾向，不是剧情任务，不要求本轮体现。',
  '只有当前情境自然命中触发条件时才考虑使用。',
  '未命中时直接忽略，不得主动创造话题来展示怪癖。',
  '即使命中，也可不表现；避免连续多轮重复同一怪癖。',
  '禁止逐条展示、逐集报菜名或为了证明人设而硬塞怪癖。',
]

/** 组装怪癖注入块:没有任何怪癖时返回空串(promptBuilder 不加空段)。
 *  enabled/名称由调用方传入,保持纯函数可测 */
export function renderQuirkBlock(
  book: QuirkBook,
  enabled: boolean,
  nameOf: (slot: ActorSlot) => string,
  enabledSlots: readonly ActorSlot[],
): string {
  if (!enabled) return ''
  const lines: string[] = []
  for (const slot of enabledSlots) {
    for (const q of book[slot]) {
      lines.push(`- ${nameOf(slot)}:${q.trigger} → ${q.behavior}`)
    }
  }
  if (lines.length === 0) return ''
  return ['招牌怪癖(每条格式"触发 → 行为"):', ...lines, '怪癖使用纪律:', ...QUIRK_INJECTION_RULES.map((r) => `- ${r}`)].join('\n')
}
