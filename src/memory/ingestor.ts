// 记忆摄取器:所有"用户发言 → 长期事实"入口的唯一通道。
// 职责链:pending 账本 → 读已知事实 → 调提取 → 证据校验(摘录必须真的能在本轮
// 原文中找到,模型编造的原句在这里被拦下)→ ingestFacts 原子提交(事实/冲突/账本
// 一次 CAS 写入)。模型失败只把账本记为 failed,绝不影响聊天。
// 提取实现可注入:测试用假 extract 零网络跑全流程;生产默认走 llmClient.extractFacts。
import { extractFacts } from '../engine/llmClient'
import { evidenceExcerptHolds } from '../storage/memoryPolicy'
import {
  beginIngestRecord,
  failIngestRecord,
  getMemory,
  ingestFacts,
  topFacts,
  type FactCandidate,
  type FactProposalInput,
  type MemoryIngestReport,
} from '../storage/memoryStore'

export type { MemoryIngestReport }

export interface MemoryIngestor {
  ingestUserTurn(input: {
    turnId: string | null
    text: string
    /** 预留:提取实现的取消贯穿下一版接入(当前 6s 超时在 extractFacts 内部) */
    signal?: AbortSignal
  }): Promise<MemoryIngestReport>
}

export interface MemoryIngestorDeps {
  /** 已知事实摘要(提取 prompt 的"不要重复提取"清单);缺省取 store 前 8 条 */
  known?: () => Promise<string[]>
  /** 事实提取(模型调用;超时在实现内部) */
  extract: (text: string, known: string[], diagTurnId?: string) => Promise<FactCandidate[]>
  now?: () => number
}

export function createMemoryIngestor(deps: MemoryIngestorDeps): MemoryIngestor {
  const knownOf = deps.known ?? (async () => topFacts(await getMemory(), 8))
  const nowOf = deps.now ?? (() => Date.now())
  return {
    async ingestUserTurn({ turnId, text }) {
      await beginIngestRecord(turnId ?? null)
      try {
        const known = await knownOf()
        const candidates = await deps.extract(text, known, turnId ?? undefined)
        const proposals: FactProposalInput[] = []
        let invalid = 0
        for (const c of candidates) {
          const quote = (c.excerpt ?? '').trim()
          // 证据校验:摘录归一化后必须出现在本轮用户原文里,否则拒绝该候选
          if (!quote || !evidenceExcerptHolds(text, quote)) {
            invalid++
            continue
          }
          proposals.push({
            content: c.content,
            category: c.category ?? 'other',
            slot: c.slot,
            value: c.value,
            volatility: c.volatility,
            sensitivity: c.sensitivity,
            evidence: [
              {
                kind: 'model-extraction',
                turnId: turnId ?? null,
                excerpt: quote.slice(0, 120),
                assertion: c.assertion === 'explicit' ? 'explicit' : 'implicit',
                at: nowOf(),
              },
            ],
          })
        }
        return await ingestFacts({ turnId: turnId ?? null, proposals, candidateCount: candidates.length, invalidCount: invalid })
      } catch {
        // 模型失败:账本记 failed,聊天不受影响
        await failIngestRecord(turnId ?? null, 'model-error')
        return {
          status: 'failed',
          candidateCount: 0,
          appliedFactIds: [],
          supersededFactIds: [],
          conflictIds: [],
          rejected: 0,
          reason: 'model-error',
        }
      }
    },
  }
}

/** 生产默认摄取器:真实模型提取 + 既有记忆摘要 */
export const memoryIngestor: MemoryIngestor = createMemoryIngestor({
  extract: (text, known, diagTurnId) => extractFacts(text, known, diagTurnId),
})
