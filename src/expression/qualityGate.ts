// 质量闸(方案 §九):模型结果提交前的确定性检查 + 至多一次轻量修复。
// 红线:绝不阻断聊天——不可修复的问题只记录(trace/诊断)后照常提交;
// 绝不重新生成(即时聊天延迟红线 P95 +300ms);修复只动 reply.text。

import type { ExpressionPlan, GateIssue } from './types'
import { normalizeForMatch } from './callbackPicker'

/** 客服腔黑名单:出现即判不合格(可修复:整句剔除) */
const SERVICE_TONE_RE =
  /(作为(一个)?AI|作为一个(人工智能|语言模型)|^作为语言模型|语言模型|有什么可以帮助你|有什么可以帮您|很高兴为您服务|请问还有什么可以帮|希望这[个段]回答|如果您有其他问题)/

/** 字符 bigram Jaccard 相似度(近重复判定;短文本只用全等) */
function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 6 || b.length < 6) return 0
  const grams = (s: string): Set<string> => {
    const out = new Set<string>()
    for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2))
    return out
  }
  const ga = grams(a)
  const gb = grams(b)
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

export interface GateContext {
  /** 本轮表达计划(maxChars/mayAskQuestion 的依据) */
  plan: Pick<ExpressionPlan, 'constraints'>
  /** 该角色最近已提交回复(新在前,至多 6 条) */
  ownRecent: string[]
  /** 本轮刺激原句(整句复述检测) */
  stimulus: string
  /** 口头禅冷却中应禁用的短语(noteSpoken 检出后由导演下发) */
  bannedCatchphrase?: string
}

export interface GateResult {
  /** 最终文本已无任何问题 */
  ok: boolean
  /** 最终文本上仍存在的问题 */
  issues: GateIssue[]
  text: string
  repaired: boolean
}

function detectIssues(text: string, ctx: GateContext): GateIssue[] {
  const issues: GateIssue[] = []
  const norm = normalizeForMatch(text)
  if (norm) {
    const repeated = ctx.ownRecent.some((r) => {
      const nr = normalizeForMatch(r)
      return (nr && nr === norm) || similarity(nr, norm) >= 0.8
    })
    if (repeated) issues.push('repetition')
  }
  if (SERVICE_TONE_RE.test(text)) issues.push('service-tone')
  const stimNorm = normalizeForMatch(ctx.stimulus)
  if (stimNorm.length >= 6 && norm.includes(stimNorm)) issues.push('echo')
  if (text.length > ctx.plan.constraints.maxChars) issues.push('over-length')
  if (!ctx.plan.constraints.mayAskQuestion && /[?？][\s~]*$/.test(text)) issues.push('question-ban')
  if (ctx.bannedCatchphrase && text.includes(ctx.bannedCatchphrase)) issues.push('catchphrase-cooldown')
  return issues
}

/** 句边界截长:在限额内找最后一个句读;找不到就硬截(不加速营号) */
function truncateTo(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('!'), head.lastIndexOf('!'), head.lastIndexOf('?'), head.lastIndexOf('?'), head.lastIndexOf(';'), head.lastIndexOf('~'))
  if (cut >= Math.floor(maxChars * 0.4)) return head.slice(0, cut + 1)
  return head
}

function dropServiceSentences(text: string): string | null {
  const parts = text.split(/(?<=[。!?~…])\s*/)
  const kept = parts.filter((p) => p && !SERVICE_TONE_RE.test(p))
  if (kept.length === 0 || kept.length === parts.length) return null
  return kept.join('')
}

/** 轻量修复,恰好一次:只修可修的(截长/剔客服腔/去口头禅/疑问改陈述);
 *  repetition 与 echo 不可修,原样保留 */
function repairOnce(text: string, issues: GateIssue[], ctx: GateContext): string {
  let out = text
  if (issues.includes('service-tone')) {
    const dropped = dropServiceSentences(out)
    if (dropped) out = dropped
  }
  if (issues.includes('catchphrase-cooldown') && ctx.bannedCatchphrase) {
    out = out.split(ctx.bannedCatchphrase).join('')
  }
  if (issues.includes('question-ban')) out = out.replace(/[?？][\s~]*$/, '。')
  if (issues.includes('over-length')) out = truncateTo(out, ctx.plan.constraints.maxChars)
  return out.trim()
}

/** 提交前检查入口:返回(可能已修复的)最终文本与问题清单;永不抛错、永不阻断 */
export function runQualityGate(rawText: string, ctx: GateContext): GateResult {
  const issues = detectIssues(rawText, ctx)
  if (issues.length === 0) return { ok: true, issues: [], text: rawText, repaired: false }
  const repairedText = repairOnce(rawText, issues, ctx)
  const finalText = repairedText !== rawText.trim() && repairedText ? repairedText : rawText
  const finalIssues = finalText === rawText ? issues : detectIssues(finalText, ctx)
  return { ok: finalIssues.length === 0, issues: finalIssues, text: finalText, repaired: finalText !== rawText }
}
