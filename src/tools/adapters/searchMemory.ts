// search_memory 工具:在既有记忆(facts)里查找使用者相关信息(read 级)。
// 与 topFacts 的被动注入不同,这是模型主动查询——"我还记得你说过什么"由它兜底,
// 避免每轮把全部记忆塞 prompt。打分用 2-gram(中文无词边界),命中多者靠前。
import { prepareTurnMemory, type MemoryData } from '../../storage/memoryStore'
import { scoreByRules } from '../candidateGate'
import { validateToolInput, type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'

const inputSchema: ToolInputSchema = {
  properties: {
    query: { type: 'string', description: '要查找的关键词', maxLength: 60 },
  },
  required: ['query'],
}

/** 2-gram 相关性检索(纯函数,导出供测试):整词匹配在中文不成立,
 *  query 切 2 字滑窗对 content 计命中;全串命中加权;置顶小幅加权 */
export function searchFacts(mem: MemoryData, query: string, limit = 5): string[] {
  const q = query.trim()
  if (!q) return []
  const grams = new Set<string>()
  for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2))
  if (q.length === 1) grams.add(q)
  return mem.facts
    .map((f) => {
      let score = 0
      for (const g of grams) if (f.content.includes(g)) score++
      if (q.length > 1 && f.content.includes(q)) score += 3
      return { content: f.content, score: score + (f.pinned ? 0.5 : 0) }
    })
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.content)
}

const manifest: ToolManifest = {
  id: 'search_memory',
  label: '查记忆',
  description: '在记忆里查找关于使用者的既有信息(称呼、喜好、身份、习惯等)',
  risk: 'read',
  inputSchema,
  timeoutMs: 5_000,
  defaultEnabled: true,
  match: (text) =>
    scoreByRules(text, [
      { re: /(翻记忆|查(一下)?记忆|记忆里)/, weight: 1 },
      { re: /(还记得|记得吗|记不记得|提过|说过我|我喜欢|我讨厌|我是干|我是做|我的(名字|称呼|职业|爱好|喜好|习惯|雷区|专业))/, weight: 0.9 },
    ]),
  presentation: { actor: 'C', pendingText: '我翻翻记忆…', action: 'thinking' },
}

export const searchMemoryTool: CharacterTool = {
  manifest,
  available: () => true,
  validate: (input) => validateToolInput(inputSchema, input),
  async execute(input) {
    const v = validateToolInput(inputSchema, input)
    if (!v.ok) return { ok: false, summary: v.reason, errorCode: 'invalid' }
    // 统一策略入口(explicit-search 比被动注入宽:过期/待确认可见但带标记,
    // 隐私规则照样拦截);refs 随 result.data 穿透,并入回合总注入集合
    const ctx = await prepareTurnMemory({ query: String(v.value.query), purpose: 'explicit-search', n: 5 })
    if (ctx.selected.length === 0) return { ok: true, summary: '记忆里没有找到相关内容' }
    // 待确认后缀按原因区分:过期/来源不明确/冲突,不再一律说"可能已过期"
    const PENDING_LABEL: Record<string, string> = {
      expired: '可能已过期',
      'low-support': '来源不够明确',
      conflict: '正等待你确认新旧信息',
    }
    const hits = ctx.selected.map((s) =>
      s.effectiveStatus === 'needs-confirmation' && s.reason
        ? `${s.text}(待确认:${PENDING_LABEL[s.reason] ?? '可能已过期'})`
        : s.text,
    )
    return {
      ok: true,
      summary: `记忆里找到 ${hits.length} 条相关:\n${hits.join('\n')}`,
      data: { hits, memoryRefs: ctx.refs },
    }
  },
}
