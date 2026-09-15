// 旧梗选择(方案 §二):只从宿主提供的真实记忆候选(context.gags,来自 story.json)
// 中挑选,绝不编造——这是"旧梗引用事实正确率 100%"的唯一保证。
// 相关性用中文 2~4 字重叠的轻量实现(思路同 storyStore.selectStoryItems,
// 但不读存储、不写注入冷却:群聊侧只读预选,冷却由宿主与导演各自的回合规则管理)。

import type { CallbackRef } from './types'

/** 去掉标点/空白,只留汉字与字母数字(重参与引用检测共用) */
export function normalizeForMatch(text: string): string {
  return text.replace(/[^\p{Script=Han}a-zA-Z0-9]+/gu, '')
}

/** 汉字 2~4 字片段集合(去重);过短文本退化为整串 */
function shingles(text: string): Set<string> {
  const s = normalizeForMatch(text)
  const out = new Set<string>()
  if (s.length <= 4) {
    if (s) out.add(s)
    return out
  }
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n))
  }
  return out
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const x of a) if (b.has(x)) n++
  return n
}

export interface PickCallbackArgs {
  gags?: ReadonlyArray<{ id: string; text: string }>
  /** 本轮刺激文本(相关性依据) */
  stimulus: string
  /** 最近对话:候选梗若已被近期发言引用过则跳过(避免连梗) */
  recent: ReadonlyArray<{ text: string }>
}

/** 挑一个相关且未被近期引用的旧梗;没有合适候选就返回 undefined(不硬凑) */
export function pickCallback(args: PickCallbackArgs): CallbackRef | undefined {
  const gags = args.gags ?? []
  if (gags.length === 0) return undefined
  const recentJoined = normalizeForMatch(args.recent.map((m) => m.text).join('|'))
  const stimulusShingles = shingles(args.stimulus)
  let best: { gag: { id: string; text: string }; score: number } | null = null
  for (const gag of gags) {
    const norm = normalizeForMatch(gag.text)
    if (!norm) continue
    // 近期已经说过的梗不再回收(梗短,原样出现即算引用)
    if (recentJoined.includes(norm)) continue
    const score = overlapCount(shingles(gag.text), stimulusShingles)
    if (score <= 0) continue
    if (!best || score > best.score) best = { gag, score }
  }
  if (!best) return undefined
  return { id: best.gag.id, text: best.gag.text }
}
