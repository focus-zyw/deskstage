// 规划器纯函数层:指纹/相似度/雷区/兼容哈希/评分/转场/环境素材/AI 卡清洗。
// 第一版不引入 embedding,全部可预测、可离线测试(RNG/时钟由 director 注入,
// 这里无 I/O 无随机)。确实独立增长后再拆。
import type { DialogMode } from '../performer/modes'
import { TOPIC_CATEGORIES, type EpisodeTopicSignal, type TopicCard, type TopicDistance } from './types'

/** 规划器版本:评分口径/prompt 结构/兼容规则变化时 +1,使旧预生成缓存全部失效。
 *  v2:TopicCard 增 angles/roles/applicability + PlanCompatibility 增 castHash */
export const PLANNER_VERSION = 2

// ---------- 指纹与相似度 ----------

/** 标题规范化:小写 + 全半角归一 + 去标点空白(只留字母数字汉字) */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^a-z0-9\p{Script=Han}]+/gu, '')
}

/** 稳定指纹:规范化标题的 FNV-1a 32bit(跨启动稳定;几百条话题规模碰撞可忽略) */
export function fingerprintOf(text: string): string {
  const norm = normalizeTitle(text)
  if (!norm) return ''
  let h = 0x811c9dc5
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 中文二元词组集合(规范化后不足 2 字时退化为整串) */
export function bigrams(text: string): Set<string> {
  const norm = normalizeTitle(text)
  const out = new Set<string>()
  if (norm.length < 2) {
    if (norm) out.add(norm)
    return out
  }
  for (let i = 0; i < norm.length - 1; i++) out.add(norm.slice(i, i + 2))
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** 标题相似度 0~1:bigram Jaccard(短标题另有规范化相等与标签/hook 组合判断,在 scorer) */
export function titleSimilarity(a: string, b: string): number {
  return jaccard(bigrams(a), bigrams(b))
}

/** 短标题(规范化后 <4 字)语义重复判断:规范化相等或一方包含另一方 */
export function shortTitleDuplicate(a: string, b: string): boolean {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return false
  return na === nb || (Math.min(na.length, nb.length) < 4 && (na.includes(nb) || nb.includes(na)))
}

// ---------- 雷区 ----------

/** 雷区词切分(与旧 pickTopic 同语义:逗号/顿号/分号/换行分隔) */
export function parseBanWords(ban: string | undefined | null): string[] {
  return (ban ?? '')
    .split(/[,，、;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function hitsBan(text: string, banWords: readonly string[]): boolean {
  return banWords.some((w) => text.includes(w))
}

/** 卡片雷区检查:标题 + hook + tags 全查,任一命中即出局 */
export function cardHitsBan(card: TopicCard, banWords: readonly string[]): boolean {
  if (banWords.length === 0) return false
  return (
    hitsBan(card.title, banWords) ||
    hitsBan(card.hook, banWords) ||
    card.tags.some((t) => hitsBan(t, banWords))
  )
}

/** 雷区指纹:预生成缓存兼容令牌之一(雷区变更 → 旧缓存作废);无雷区为空串 */
export function banHashOf(ban: string | undefined | null): string {
  const words = parseBanWords(ban).sort()
  if (words.length === 0) return ''
  return fingerprintOf(words.join('\u0001'))
}

// ---------- 模式内容指纹 ----------

/** 模式内容指纹:自定义模式编辑(prompt/topics/tone 等)后,按旧模式生成的缓存剧本不误用 */
export function modeHashOf(mode: DialogMode): string {
  return fingerprintOf(
    JSON.stringify([mode.id, mode.label, mode.prompt, mode.tone ?? '', mode.gap, mode.topics ?? []]),
  )
}

// ---------- 口味聚合(episodeSignals → 指纹口味分) ----------

/** 聚合信号投影为指纹口味分:完播/赞/收藏为正,跳过/踩为负,钳制 [-2,+2] */
export function verdictScores(signals: Record<string, EpisodeTopicSignal>): Map<string, number> {
  const acc = new Map<string, { done: number; skip: number; up: number; down: number; fav: number }>()
  for (const s of Object.values(signals)) {
    if (!s.fingerprint) continue
    const a = acc.get(s.fingerprint) ?? { done: 0, skip: 0, up: 0, down: 0, fav: 0 }
    if (s.completed) a.done++
    if (s.skippedProgress !== undefined) a.skip++
    if (s.rating === 'up') a.up++
    if (s.rating === 'down') a.down++
    if (s.favored) a.fav++
    acc.set(s.fingerprint, a)
  }
  const out = new Map<string, number>()
  for (const [fp, a] of acc) {
    out.set(fp, Math.max(-2, Math.min(2, a.done * 0.5 + a.up * 1.5 + a.fav * 2 - a.skip * 1.5 - a.down * 1.5)))
  }
  return out
}

// ---------- 候选评分 ----------

/** recent 条目的最小形状(RecentTopic 的结构子集) */
export interface RecentLike {
  fingerprint: string
  title: string
  category: string
  source: string
}

export interface ScoreContext {
  /** 最近话题(旧→新;去重与疲劳的依据) */
  recent: readonly RecentLike[]
  /** 指纹口味分(verdictScores 聚合结果) */
  verdicts: ReadonlyMap<string, number>
  /** 旧版 topicStats 种子权重(只读 legacy;键=旧标题,命中即加分,≤0 减分) */
  legacyWeights: Record<string, number>
  /** 使用者兴趣关键词(likes 切分) */
  interests: readonly string[]
  modeId: string
  /** 模式专属池卡 id 集合(硬域内 modeFit 满分) */
  modeTopicIds: ReadonlySet<string>
}

export interface ScoredCard {
  card: TopicCard
  score: number
  /** 与最近话题的最大相似度(诊断/测试用) */
  maxSimilarity: number
}

/** 单卡评分(V2 §6 公式):score = 各正项加权和 − 相似/分类疲劳/来源疲劳惩罚 */
export function scoreCard(card: TopicCard, ctx: ScoreContext): ScoredCard | null {
  const recent = ctx.recent
  // 硬排除:最近 20 集相同 fingerprint
  if (recent.some((r) => r.fingerprint === card.fingerprint)) return null
  // 相似度:与最近 10 集的 bigram Jaccard 最大值;短标题重复直接视为顶格
  let maxSimilarity = 0
  for (const r of recent.slice(-10)) {
    if (shortTitleDuplicate(card.title, r.title)) {
      maxSimilarity = 1
      break
    }
    maxSimilarity = Math.max(maxSimilarity, titleSimilarity(card.title, r.title))
  }
  // 软硬阈值:>0.6 语义重复出局(硬排除的另一半)
  if (maxSimilarity > 0.6) return null

  // relevance:兴趣命中 + legacy 口味 + 反馈口味,围绕 0.4 基线
  let relevance = 0.4
  const text = `${card.title} ${card.hook} ${card.tags.join(' ')}`
  if (ctx.interests.some((k) => k && text.includes(k))) relevance += 0.3
  const legacy = ctx.legacyWeights[card.title]
  if (legacy !== undefined) relevance += legacy > 0 ? Math.min(0.2, legacy * 0.04) : -0.2
  relevance += Math.max(-0.2, Math.min(0.2, (ctx.verdicts.get(card.fingerprint) ?? 0) * 0.1))
  relevance = Math.max(0, Math.min(1, relevance))

  const novelty = 1 - maxSimilarity

  // modeFit:专属池/亲和卡满分,其余中性(自定义模式无 modeAffinity 时不歧视)
  const modeFit =
    (card.modeAffinity?.includes(ctx.modeId) ?? false) || ctx.modeTopicIds.has(card.id) ? 1 : 0.55

  // continuity:与上一集相似度落在"能自然接上但不重复"的区间最高
  const last = recent[recent.length - 1]
  let continuity = 0.7
  if (last) {
    const lastSim = shortTitleDuplicate(card.title, last.title)
      ? 1
      : titleSimilarity(card.title, last.title)
    continuity = lastSim >= 0.1 && lastSim <= 0.45 ? 0.9 : 0.5
  }

  // diversity:最近 3 集同类/同源占比越低越好
  const near = recent.slice(-3)
  const clash = near.filter((r) => r.category === card.category || r.source === card.source).length
  const diversity = 1 - clash / 3

  const catFatigue = recent.slice(-10).filter((r) => r.category === card.category).length
  const srcFatigue = recent.slice(-5).filter((r) => r.source === card.source).length
  const penalty = Math.max(0, maxSimilarity - 0.35) * 2 + catFatigue * 0.08 + srcFatigue * 0.06

  const score =
    relevance * 0.25 +
    novelty * 0.3 +
    modeFit * 0.2 +
    continuity * 0.15 +
    diversity * 0.1 -
    penalty
  return { card, score, maxSimilarity }
}

/** 前 K 名按得分加权随机(防评分模型形成新固定套路);k=4 */
export function pickWeightedTopK(
  scored: ScoredCard[],
  rng: () => number,
  k = 4,
): ScoredCard | null {
  if (scored.length === 0) return null
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, k)
  const min = top[top.length - 1]!.score
  const weights = top.map((s) => Math.pow(s.score - min + 0.05, 3))
  const total = weights.reduce((a, b) => a + b, 0)
  let roll = rng() * total
  for (let i = 0; i < top.length; i++) {
    roll -= weights[i]!
    if (roll < 0) return top[i]!
  }
  return top[top.length - 1]!
}

// ---------- 转场 ----------

/** 依跳跃距离生成转场线索;near/medium 必有,far 半数给、半数不衔接(完全换台) */
export function buildBridge(
  lastTitle: string,
  card: TopicCard,
  distance: TopicDistance,
  rng: () => number,
): string | undefined {
  if (!lastTitle) return undefined
  if (distance === 'near')
    return `上一集刚聊到「${lastTitle}」,开场先接一句上一集的尾巴,再顺势转到「${card.title}」`
  if (distance === 'medium')
    return `从「${lastTitle}」自然过渡:抓住一个共同的词或共同的感受,把话头带到「${card.title}」`
  return rng() < 0.5 ? `完全换台,直接开新场面:「${card.title}」,不用衔接` : undefined
}

// ---------- 时间与环境素材(类别级,不含原始窗口/屏幕内容) ----------

export type TimeBucket = 'deep-night' | 'morning' | 'afternoon' | 'evening'

export function timeBucketOf(ts: number): TimeBucket {
  const h = new Date(ts).getHours()
  if (h >= 23 || h < 5) return 'deep-night'
  if (h < 11) return 'morning'
  if (h < 17) return 'afternoon'
  return 'evening'
}

const ENV_APP_CARDS: Record<string, { title: string; hook: string; category: TopicCard['category'] }> = {
  editor: {
    title: '连续忙碌两小时后,大脑的缓存该清了',
    hook: '甲认为硬撑是敬业,乙认为休息才是效率,拿眼前这位当实验对象',
    category: 'work',
  },
  browser: {
    title: '三十个标签页不敢关是什么心态',
    hook: '甲说这是数字囤积,乙说这是知识焦虑,最后谁也没关掉谁的',
    category: 'technology',
  },
  terminal: {
    title: '命令行敲错一个字母的连锁反应',
    hook: '甲主张小心驶得万年船,乙认为快速试错才是王道,现场演示各自翻车',
    category: 'technology',
  },
  media: {
    title: '一边放歌一边干活,歌词会不会偷偷进脑子',
    hook: '甲说背景音乐助产灵感,乙说歌词是注意力小偷,赌了一局',
    category: 'life',
  },
}

const TIME_CARDS: Record<TimeBucket, { title: string; hook: string; category: TopicCard['category'] }> = {
  'deep-night': {
    title: '道理都懂,为什么还是熬到这个点',
    hook: '甲把熬夜归罪于报复心理,乙归罪于手机,先把对方熬困算赢',
    category: 'health',
  },
  morning: {
    title: '早晨的第一个决定为什么最难做',
    hook: '甲从闹钟按掉几次聊起,乙从早饭选择困难聊起,殊途同归地指责床',
    category: 'life',
  },
  afternoon: {
    title: '下午三点的困意是不是全人类同步的',
    hook: '甲坚称是生物钟,乙坚称是午饭吃多了,决定做个非正式调查',
    category: 'work',
  },
  evening: {
    title: '下班后的第一件事暴露了什么',
    hook: '甲瘫着刷手机,乙马上换衣服出门,互相诊断对方的心理状态',
    category: 'life',
  },
}

function envCard(def: { title: string; hook: string; category: string }, idKey: string, now: number): TopicCard {
  return {
    id: `env-${idKey}`,
    title: def.title,
    hook: def.hook,
    category: def.category as TopicCard['category'],
    tags: ['环境'],
    source: 'environment',
    fingerprint: fingerprintOf(def.title),
    sensitivity: 'normal',
    generatedAt: now,
  }
}

/** 环境源候选:前台应用类别卡(仅类别级标签)+ 时段卡;不再细分、不上传任何原始内容 */
export function environmentCards(envCategory: string | null, bucket: TimeBucket, now: number): TopicCard[] {
  const out: TopicCard[] = []
  if (envCategory && ENV_APP_CARDS[envCategory]) {
    out.push(envCard(ENV_APP_CARDS[envCategory]!, `app-${envCategory}`, now))
  }
  out.push(envCard(TIME_CARDS[bucket], `time-${bucket}`, now))
  return out
}

// ---------- AI 生成候选的清洗(sanitizer) ----------

export interface GeneratedCardChecks {
  banWords: readonly string[]
  /** 已占用的指纹(候选仓 + 最近话题),命中即拒 */
  existingFingerprints: ReadonlySet<string>
  now: number
}

/** AI 生成的候选卡清洗:字段/长度/分类/雷区/语义重复全检,任一不过返回 null。
 *  语义底线:标题必须是"可演出的局面"(≥6 字)且 hook 不得照抄标题 */
export function sanitizeGeneratedCard(raw: unknown, checks: GeneratedCardChecks): TopicCard | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title.trim() : ''
  const hook = typeof o.hook === 'string' ? o.hook.trim() : ''
  if (title.length < 6 || title.length > 40) return null
  if (hook.length < 10 || hook.length > 80) return null
  if (!(TOPIC_CATEGORIES as readonly string[]).includes(o.category as string)) return null
  const tags = Array.isArray(o.tags)
    ? o.tags
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        .map((t) => t.trim().slice(0, 8))
        .slice(0, 5)
    : []
  if (tags.length === 0) return null
  const card: TopicCard = {
    id: `gen-${fingerprintOf(title)}`,
    title,
    hook,
    category: o.category as TopicCard['category'],
    tags,
    source: 'generated',
    fingerprint: fingerprintOf(title),
    sensitivity: 'normal',
    generatedAt: checks.now,
    expiresAt: checks.now + 14 * 24 * 60 * 60 * 1000,
  }
  if (typeof o.bridge === 'string' && o.bridge.trim().length >= 6 && o.bridge.trim().length <= 80) {
    card.bridge = o.bridge.trim()
  }
  if (cardHitsBan(card, checks.banWords)) return null
  if (checks.existingFingerprints.has(card.fingerprint)) return null
  return card
}
