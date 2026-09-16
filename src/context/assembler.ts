// Context Assembler:Hot 之外的 Warm/Mem0 新层在进入 prompt 前的检索渲染窄口。
// 现有三处组装点(actorPrompt/promptBuilder/llmClient 内联)不动,只从这里取新行:
// - warmLine:当前会话滚动摘要恒注入(Pi 序:摘要在原文之前)+ 历史集摘要按
//   「相关性×0.7 + 新近×0.3」取 top2。restricted 永不出现在注入里(warmStore
//   入库时已拦,这里按防御再滤一道)。
// - experienceLine:Mem0 经历检索(失败/未启用返回 undefined,fail-open)。
import { currentSession, listEpisodes, type WarmEpisode } from '../storage/warmStore'
import { relevance } from '../storage/memoryPolicy'
import { mem0Memory } from '../cold/mem0Memory'

/** 历史集摘要最多注入条数 */
export const WARM_EPISODES_INJECT = 2
/** 相关性/新近的加权 */
const RELEVANCE_WEIGHT = 0.7
const RECENCY_WEIGHT = 0.3
/** 新近度半衰期参考:24 小时内近似线性,超过按 14 天保留期归零 */
const RECENCY_SPAN_MS = 14 * 24 * 60 * 60 * 1000

export interface WarmAssembler {
  /** Warm 注入行(滚动摘要 + 历史集摘要;无可注入返回 undefined) */
  warmLine(query: string, now?: number): Promise<string | undefined>
  /** Mem0 经历注入行(无可召回/未启用返回 undefined) */
  experienceLine(query: string, limit?: number): Promise<string | undefined>
}

export interface AssemblerDeps {
  currentSession?: typeof currentSession
  listEpisodes?: typeof listEpisodes
  searchExperiences?: (query: string, limit?: number) => Promise<string[]>
}

function recency(ts: number, now: number): number {
  const age = Math.max(now - ts, 0)
  return Math.max(1 - age / RECENCY_SPAN_MS, 0)
}

function renderEpisodes(list: WarmEpisode[]): string {
  const rows = list.map((e) => e.summary.trim()).filter(Boolean)
  if (rows.length === 0) return ''
  return `此前聊过(供自然衔接,别当新闻复述):${rows.join(';')}`
}

export function createWarmAssembler(deps: AssemblerDeps = {}): WarmAssembler {
  const sessionOf = deps.currentSession ?? currentSession
  const episodesOf = deps.listEpisodes ?? listEpisodes
  const searchOf = deps.searchExperiences ?? ((q: string, n?: number) => mem0Memory.searchExperiences(q, n))

  return {
    async warmLine(query, now = Date.now()) {
      const [session, episodes] = await Promise.all([sessionOf(), episodesOf()])
      const parts: string[] = []
      const rolling = session?.rollingSummary.trim()
      if (rolling) parts.push(`刚才之前聊过(供自然衔接,别当新闻复述):${rolling}`)
      const q = query.trim()
      const picked = episodes
        .filter((e) => e.sensitivity !== 'restricted' && e.summary.trim())
        .map((e) => ({
          e,
          score: relevance(e.summary, q) * RELEVANCE_WEIGHT + recency(e.toTs, now) * RECENCY_WEIGHT,
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, WARM_EPISODES_INJECT)
        .map(({ e }) => e)
      const episodesLine = renderEpisodes(picked)
      if (episodesLine) parts.push(episodesLine)
      if (parts.length === 0) return undefined
      return parts.join('\n')
    },

    async experienceLine(query, limit = 3) {
      const hits = await searchOf(query, limit)
      if (hits.length === 0) return undefined
      return `你记得的过往经历(供自然联想,别当新闻播报):${hits.join(';')}`
    },
  }
}

/** 生产单例 */
export const contextAssembler: WarmAssembler = createWarmAssembler()
