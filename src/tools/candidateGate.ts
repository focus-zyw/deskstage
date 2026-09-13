// 候选门槛(纯函数):工具决策的第一道闸,目标是大数普通对话零额外模型调用。
//
// 路由规则(设计裁决):
// · 零候选 → kind 'none':完全不调 Planner,按普通聊天走;
// · 单一高置信候选 → kind 'direct':意图明确,直接选定,连 Planner 也省了;
// · 多候选/置信不够 → kind 'plan':把短清单交给模型做 ToolDecision;
// 打分来自各 manifest.match()——确定性关键词规则,不猜意图,可单测。

import type { ToolManifest, ToolPlanningContext } from './types'

/** 进候选清单的最低分(低于它的工具对本句话不存在) */
export const CANDIDATE_MIN_SCORE = 0.35
/** 单候选直达的最低分(明确命令级) */
export const DIRECT_MIN_SCORE = 0.7

export type GateRoute =
  | { kind: 'none' }
  | { kind: 'direct'; tool: string }
  | { kind: 'plan'; candidates: ToolManifest[] }

export function routeTurn(
  text: string,
  manifests: ToolManifest[],
  ctx: ToolPlanningContext,
): GateRoute {
  const scored = manifests
    .map((m) => ({ m, score: m.match(text, ctx) }))
    .filter((s) => s.score >= CANDIDATE_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.m.id.localeCompare(b.m.id))
  if (scored.length === 0) return { kind: 'none' }
  // 直达仅在"无必填参数"时成立:参数要从用户话里抽的工具(search_memory 的 query 等)
  // 必须交 Planner 提取,空参数直达只会挂在校验上
  if (
    scored.length === 1 &&
    scored[0].score >= DIRECT_MIN_SCORE &&
    (scored[0].m.inputSchema.required ?? []).length === 0
  ) {
    return { kind: 'direct', tool: scored[0].m.id }
  }
  return { kind: 'plan', candidates: scored.map((s) => s.m) }
}

/** 命中规则表(适配器 match 的共用底座):命中取最高权重,全不中返回 0。
 *  权重语义:1.0 明确命令词 / 0.85 强意图 / 0.5 弱关联 / 0 不相关 */
export function scoreByRules(
  text: string,
  rules: { re: RegExp; weight: number }[],
): number {
  let best = 0
  for (const { re, weight } of rules) {
    if (re.test(text) && weight > best) best = weight
  }
  return best
}
