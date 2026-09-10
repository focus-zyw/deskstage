// 角色世界策展:每集播完后的唯一入库入口。
// 调用方只管 curateEpisode(lines)——内部完成 全量库存 → 模型蒸馏 → 台词证据校验 →
// 断言/模态规则 → 两级去重(模型 sameAs 指认 + 字面相似度) → mergeStory 入库,返回整理报告。
// 政策集中在这里:存储层(storyStore)只管不变量,提示词(llmClient)只管产出格式;
// 再出现"同场景重复入库/反问变成事实/临时甩锅成设定"这类问题,只需要修这一个模块。

import type { DialogLine } from '../performer/dialogSchema'
import { distillStory, transcriptOf } from './llmClient'
import {
  getStory,
  mergeStory,
  normalizeStoryText,
  SIMILAR_MERGE_THRESHOLD,
  storyInventory,
  storyTextSimilarity,
  validateStoryText,
  type DistilledStory,
  type StoryCandidate,
  type StoryInventory,
  type StoryPatch,
} from '../storage/storyStore'

export interface CurateReport {
  addedGags: string[]
  addedThreads: string[]
  /** sameAs 合并:库存老梗被更新成的规范表述 */
  canonicalized: { id: string; text: string }[]
  /** 本集实际回收了的老梗(模型指认的 + 字面相似度判定的) */
  reusedGagIds: string[]
  resolvedThreadIds: string[]
  rejected: { text: string; reason: string }[]
  arcAdvanced: string | null
  /** 本集演完最后一拍、随之完结的剧情线 */
  arcCompleted: string | null
  newArc: string | null
}

export interface CuratorDeps {
  distill?: (lines: DialogLine[], known: StoryInventory) => Promise<DistilledStory>
}

/** 引文规范化后至少要剩这么多字才算有效台词证据 */
const MIN_EVIDENCE_CHARS = 4
// 吹牛/甩锅必须保留模态语气;缺语气词时按主体补"自称",防止临时借口沉淀成世界事实
const MODAL_MARKER = /自称|号称|甩锅|辩称|嘴硬|硬说|吹牛|瞎说|谎称/

const withModality = (text: string): string => {
  if (text.startsWith('甲')) return `甲自称${text.slice(1)}`
  if (text.startsWith('乙')) return `乙自称${text.slice(1)}`
  return `甲自称${text}`
}

/** 整理一集台词:只接受有台词证据、断言成立、可脱离台词复用的素材入库 */
export async function curateEpisode(
  lines: DialogLine[],
  deps: CuratorDeps = {},
): Promise<CurateReport> {
  const report: CurateReport = {
    addedGags: [],
    addedThreads: [],
    canonicalized: [],
    reusedGagIds: [],
    resolvedThreadIds: [],
    rejected: [],
    arcAdvanced: null,
    arcCompleted: null,
    newArc: null,
  }
  if (lines.length === 0) return report
  const distill = deps.distill ?? distillStory
  const transcript = transcriptOf(lines)
  const inv = await storyInventory()
  const d = await distill(lines, inv)

  report.resolvedThreadIds = d.resolvedThreadIds
  report.reusedGagIds = [...d.reusedGagIds]

  const patch: StoryPatch = {
    gags: [],
    threads: [],
    canonicalizedGags: [],
    reusedGagIds: d.reusedGagIds,
    resolvedThreadIds: d.resolvedThreadIds,
    arcAdvance: d.arcAdvance,
    newArc: d.newArc,
  }

  // 台词证据:引文规范化后必须真的出现在本集台词里,防止模型凭空造设定
  const hasEvidence = (c: StoryCandidate): boolean =>
    c.evidence.some((q) => {
      const nq = normalizeStoryText(q)
      return nq.length >= MIN_EVIDENCE_CHARS && normalizeStoryText(transcript).includes(nq)
  })
  // 集内去重:同一批候选里换说法的只收第一条
  const seen: string[] = []

  const runCandidates = (kind: 'gag' | 'thread', candidates: StoryCandidate[]) => {
    for (const c of candidates) {
      if (!hasEvidence(c)) {
        report.rejected.push({ text: c.text, reason: '无台词证据' })
        continue
      }
      if (c.assertion === 'question' || c.assertion === 'hypothesis') {
        report.rejected.push({ text: c.text, reason: '反问/猜测不入库' })
        continue
      }
      let text = c.text
      if ((c.assertion === 'boast' || c.assertion === 'excuse') && !MODAL_MARKER.test(text)) {
        text = withModality(text)
      }
      const invalid = validateStoryText(kind, text)
      if (invalid) {
        report.rejected.push({ text, reason: invalid })
        continue
      }
      if (seen.some((s) => storyTextSimilarity(s, text) >= SIMILAR_MERGE_THRESHOLD)) {
        report.rejected.push({ text, reason: '与集内候选重复' })
        continue
      }
      if (kind === 'gag' && c.sameAsId) {
        // 模型指认的同义梗:把库存老梗的措辞规范化,并计一次使用
        patch.canonicalizedGags.push({ id: c.sameAsId, text })
        report.canonicalized.push({ id: c.sameAsId, text })
      } else {
        const pool = kind === 'gag' ? inv.gags : inv.threads
        const twin = pool.find((x) => storyTextSimilarity(x.text, text) >= SIMILAR_MERGE_THRESHOLD)
        if (kind === 'gag') {
          // 模型没认出来但字面高度相似的老梗:按回收记账(hits 在 mergeStory 里 +1)
          if (twin) report.reusedGagIds.push(twin.id)
          patch.gags.push({ text })
          report.addedGags.push(text)
        } else {
          patch.threads.push({ text })
          if (!twin) report.addedThreads.push(text)
        }
      }
      seen.push(text)
    }
  }
  runCandidates('gag', d.newGags)
  runCandidates('thread', d.newThreads)

  const touched =
    patch.gags.length +
      patch.threads.length +
      patch.canonicalizedGags.length +
      patch.reusedGagIds.length +
      patch.resolvedThreadIds.length >
      0 ||
    !!patch.arcAdvance ||
    !!patch.newArc
  if (touched) {
    await mergeStory(patch)
    const after = await getStory()
    if (d.arcAdvance) {
      const arc = after.arcs.find((a) => a.id === d.arcAdvance!.id)
      if (arc?.status === 'done') report.arcCompleted = arc.id
      else report.arcAdvanced = d.arcAdvance.id
    }
    if (d.newArc && after.arcs.some((a) => a.status === 'active' && a.title === d.newArc!.title)) {
      report.newArc = d.newArc.title
    }
  }
  return report
}
