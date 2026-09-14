// 精选演出话题库的深模块:query(分类推荐/搜索/去重/排序)/resolve(按 ID 找卡)/
// candidates(给自动选题的完整候选池)。分类计数、空分类隐藏、角色 applicability
// 门控、雷区与近期排除全部封装在此,调用方(UI 与导演)不再各自筛选。
// 数据在 catalogContent.ts;指纹/雷区/评分等纯函数在 planner.ts;本文件只学习接口。
// hook 与随机纪律:模块加载期不做任何随机,无手写 hook 的卡按标题哈希确定性选模板。

import type { ActorSlot, PersonaSourceSlot } from '../engine/persona'
import type { DialogMode } from '../performer/modes'
import type { TopicCard, TopicCategory, TopicSuggestion } from './types'
import { cardHitsBan, fingerprintOf } from './planner'
import {
  ANGLES_BY_CATEGORY,
  ALLOWED_SIMILAR_PAIRS,
  CORE_SEEDS,
  HOOK_TEMPLATES,
  TOPIC_CATEGORY_LABELS,
  TOPIC_PACKS,
  type SeedCard,
} from './catalogContent'

export { ANGLES_BY_CATEGORY, ALLOWED_SIMILAR_PAIRS, TOPIC_CATEGORY_LABELS }
export type { SeedCard }

/** 分类默认 tags(粗粒度:评分用于 modeFit/diversity) */
const CATEGORY_TAGS: Record<TopicCategory, string[]> = {
  consumption: ['消费', '搞钱'],
  work: ['职场', '通勤'],
  life: ['生活', '居住'],
  social: ['社交', '人情'],
  emotion: ['情绪', '心态'],
  technology: ['AI', '数码'],
  health: ['健康', '自我'],
  imagination: ['脑洞', '假设'],
  'character-history': ['角色往事'],
}

function hash32(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0
  return Math.abs(h)
}

function makeCard(
  title: string,
  category: TopicCategory,
  source: TopicCard['source'],
  idPrefix: string,
  extra?: {
    tags?: string[]
    hook?: string
    modeAffinity?: string[]
    generatedAt?: number
    expiresAt?: number
  },
): TopicCard {
  // 确定性选模板:同标题永远同一 hook(不用模块加载期 Math.random)
  const templates = HOOK_TEMPLATES[category]
  const tpl = templates[hash32(title) % templates.length]!
  const card: TopicCard = {
    id: `${idPrefix}-${fingerprintOf(title)}`,
    title,
    hook: extra?.hook ?? tpl.replace('{t}', title),
    category,
    tags: extra?.tags ?? CATEGORY_TAGS[category],
    source,
    fingerprint: fingerprintOf(title),
    sensitivity: 'normal',
    generatedAt: extra?.generatedAt ?? 0,
  }
  if (extra?.modeAffinity) card.modeAffinity = extra.modeAffinity
  if (extra?.expiresAt) card.expiresAt = extra.expiresAt
  return card
}

/** 结构化种子 → 卡(声明即文案;angles/roles/applicability 原样携带) */
function makeSeedCard(seed: SeedCard, idPrefix: string): TopicCard {
  const card = makeCard(seed.title, seed.category, 'curated', idPrefix, { hook: seed.hook })
  if (seed.sensitivity) card.sensitivity = seed.sensitivity
  if (seed.angles && seed.angles.length > 0) card.angles = seed.angles
  if (seed.roles) card.roles = seed.roles
  if (seed.applicability?.actors && Object.keys(seed.applicability.actors).length > 0) {
    card.applicability = seed.applicability
  }
  return card
}

/** 核心精选池:通用骨架,任何人设下都成立 */
export const CURATED_CARDS: TopicCard[] = CORE_SEEDS.map((s) => makeSeedCard(s, 'cur'))

/** 默认人设专属包(仅分组;门控看逐卡 applicability) */
export const TOPIC_PACK_CARDS: { id: string; label: string; cards: TopicCard[] }[] = TOPIC_PACKS.map(
  (p) => ({ id: p.id, label: p.label, cards: p.cards.map((s) => makeSeedCard(s, `pk-${p.id}`)) }),
)

const PACK_CARDS: readonly TopicCard[] = TOPIC_PACK_CARDS.flatMap((p) => p.cards)

// ---------- 转换:模式专属池 / 手动话题文本(保留旧导出) ----------

/** 关键词分类猜测(自定义模式 topics / 手动话题没有声明分类时用) */
export function categoryGuess(text: string): TopicCategory {
  const t = text.toLowerCase()
  const has = (...ws: string[]) => ws.some((w) => t.includes(w))
  if (has('加班', '老板', '上班', '周报', '会议', '工资', '简历', '面试', '同事', '摸鱼', '通勤')) return 'work'
  if (has('ai', '手机', '算法', '密码', '验证码', 'app', '直播', '网')) return 'technology'
  if (has('恋', '相亲', '朋友', '家长', '亲戚', '群', '社交', '已读')) return 'social'
  if (has('emo', '焦虑', '恐惧', '压力', '内耗', '崩溃', '破防')) return 'emotion'
  if (has('减肥', '健身', '熬夜', '养生', '体检', '失眠', '医院')) return 'health'
  if (has('买', '外卖', '红包', '省钱', '氪', '购物', '双十一', '包邮', '种草', '拔草')) return 'consumption'
  return 'life'
}

/** 模式专属话题池 → 卡(source=curated,modeAffinity 锁定该模式;硬领域约束的素材) */
export function cardsFromSeeds(seeds: readonly string[], modeId: string): TopicCard[] {
  return seeds
    .map((s) => s.trim())
    .filter(Boolean)
    .map((t) =>
      makeCard(t.slice(0, 40), categoryGuess(t), 'curated', 'mode', {
        modeAffinity: [modeId],
        tags: [`模式:${modeId}`],
      }),
    )
}

/** 手动话题文本 → 卡(source=manual;一次性点播与自定义输入共用) */
export function manualCardFromText(text: string): TopicCard {
  const title = text.trim().slice(0, 60)
  return makeCard(title, categoryGuess(title), 'manual', 'manual', { generatedAt: Date.now() })
}

// ---------- 角度 ----------

/** 卡的可用角度:卡自身声明优先,否则用分类角度池 */
export function anglesFor(card: TopicCard): string[] {
  return card.angles && card.angles.length > 0 ? card.angles : ANGLES_BY_CATEGORY[card.category]
}

/** 排除已用角度后随机选一个切口;全用过则退回全池(循环可用) */
export function pickAngle(card: TopicCard, usedAngles: readonly string[], rng: () => number): string {
  const all = anglesFor(card)
  if (all.length === 0) return ''
  const fresh = all.filter((a) => !usedAngles.includes(a))
  const pool = fresh.length > 0 ? fresh : all
  return pool[Math.floor(rng() * pool.length)]!
}

/** 一集的切口文本:70% 概率叠角度(切口是本集抓手,多数给),30% 裸 hook */
export function focusForCard(
  card: TopicCard,
  usedAngles: readonly string[],
  rng: () => number,
): { focus: string; angle: string } {
  if (rng() < 0.3) return { focus: card.hook, angle: '' }
  const angle = pickAngle(card, usedAngles, rng)
  return { focus: angle ? `${card.hook}(${angle})` : card.hook, angle }
}

// ---------- TopicCatalog:深模块(query / resolve / candidates) ----------

export interface CategoryStat {
  id: TopicCategory
  label: string
  count: number
}

/** 真实角色往事的极简形状(由 storyStore threads 映射;没有则该分类自动隐藏) */
export interface HistoryPiece {
  id: string
  title: string
  hook: string
}

export interface TopicQueryCtx {
  /** 当前模式:专属池卡入池,亲和卡排序加分 */
  mode?: Pick<DialogMode, 'id' | 'topics'>
  /** 各槽位人设来源(applicability 门控;缺省按全默认处理) */
  actorWorld?: Partial<Record<ActorSlot, PersonaSourceSlot>>
  banWords?: readonly string[]
  category?: TopicCategory
  text?: string
  excludeFingerprints?: readonly string[]
  /** 同 seed 同结果(确定性排序);缺省 0 */
  seed?: number
  limit?: number
}

export interface TopicQueryResult {
  items: TopicSuggestion[]
  /** 分类统计与 items 同源:同一个人设/模式/雷区门控池,空分类天然不出现 */
  facets: CategoryStat[]
}

export interface TopicCatalogDeps {
  /** AI 候选仓(点卡 resolve 的第一优先级) */
  getReservoir: () => readonly TopicCard[]
  /** 真实角色往事;空数组 = 无往事,character-history 分类自动隐藏 */
  getHistoryPieces: () => readonly HistoryPiece[]
}

export interface TopicCatalog {
  query(ctx?: TopicQueryCtx): TopicQueryResult
  resolve(id: string, ctx?: TopicQueryCtx): TopicCard | null
  /** 自动选题候选池:门控 + 排除 sensitive(sensitive 只允许用户显式选择) */
  candidates(ctx?: TopicQueryCtx): TopicCard[]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createTopicCatalog(deps: TopicCatalogDeps): TopicCatalog {
  function historyCards(): TopicCard[] {
    return deps.getHistoryPieces().map((p) => ({
      id: `th-${p.id}`,
      title: p.title.slice(0, 40),
      hook: p.hook,
      category: 'character-history' as const,
      tags: ['旧事'],
      source: 'character-history' as const,
      fingerprint: `th-${p.id}`,
      sensitivity: 'normal' as const,
      generatedAt: 0,
    }))
  }

  /** applicability 门控:所列槽位的人设来源须与要求一致;未声明世界按全默认处理 */
  function visibleInWorld(
    card: TopicCard,
    world?: Partial<Record<ActorSlot, PersonaSourceSlot>>,
  ): boolean {
    const actors = card.applicability?.actors
    if (!actors) return true
    for (const slot of Object.keys(actors) as ActorSlot[]) {
      const required = actors[slot]
      if (!required) continue
      if ((world?.[slot] ?? 'default') !== required) return false
    }
    return true
  }

  function gatedPool(ctx: TopicQueryCtx): TopicCard[] {
    const modePool = ctx.mode?.topics?.length ? cardsFromSeeds(ctx.mode.topics, ctx.mode.id) : []
    return [...CURATED_CARDS, ...PACK_CARDS, ...modePool, ...historyCards()]
      .filter((c) => visibleInWorld(c, ctx.actorWorld))
      .filter((c) => !cardHitsBan(c, ctx.banWords ?? []))
      .filter((c) => !(ctx.excludeFingerprints ?? []).includes(c.fingerprint))
  }

  function matchesText(card: TopicCard, q: string): boolean {
    const t = q.trim().toLowerCase()
    if (!t) return true
    const hay = [
      card.title,
      card.hook,
      ...card.tags,
      card.roles?.initiator ?? '',
      card.roles?.challenger ?? '',
      ...(card.angles ?? []),
    ]
      .join('\n')
      .toLowerCase()
    return hay.includes(t)
  }

  function toSuggestion(card: TopicCard, matchedBy: TopicSuggestion['matchedBy']): TopicSuggestion {
    return {
      id: card.id,
      title: card.title,
      hook: card.hook,
      category: card.category,
      tags: card.tags,
      source: card.source,
      sensitivity: card.sensitivity,
      matchedBy,
    }
  }

  function query(ctx: TopicQueryCtx = {}): TopicQueryResult {
    const pool = gatedPool(ctx)
    // facets 与 items 同源:同一门控池上统计,分类计数与实际可选永不脱节
    const facets: CategoryStat[] = []
    for (const cat of Object.keys(TOPIC_CATEGORY_LABELS) as TopicCategory[]) {
      const count = pool.filter((c) => c.category === cat).length
      if (count > 0) facets.push({ id: cat, label: TOPIC_CATEGORY_LABELS[cat], count })
    }
    const matched = pool
      .filter((c) => (ctx.category ? c.category === ctx.category : true))
      .filter((c) => matchesText(c, ctx.text ?? ''))
    // 确定性排序:模式亲和优先;同档内按 seed 抖动(同 seed 同结果,同结果前缀稳定)
    const rng = mulberry32(ctx.seed ?? 0)
    const ranked = matched
      .map((c) => ({
        card: c,
        key: (ctx.mode && c.modeAffinity?.includes(ctx.mode.id) ? 2 : 0) + rng() * 1.5,
      }))
      .sort((a, b) => b.key - a.key || (a.card.fingerprint < b.card.fingerprint ? -1 : 1))
    const limit = ctx.limit ?? 4
    return {
      items: ranked
        .slice(0, limit)
        .map((r) => toSuggestion(r.card, ctx.text?.trim() ? 'keyword' : 'category')),
      facets,
    }
  }

  function resolve(id: string, ctx: TopicQueryCtx = {}): TopicCard | null {
    if (!id) return null
    const inReservoir = deps.getReservoir().find((c) => c.id === id)
    if (inReservoir) return inReservoir
    // 直接点播不套近期排除(用户意志优先),但保留世界门控与雷区
    return (
      gatedPool({ mode: ctx.mode, actorWorld: ctx.actorWorld, banWords: ctx.banWords }).find(
        (c) => c.id === id,
      ) ?? null
    )
  }

  function candidates(ctx: TopicQueryCtx = {}): TopicCard[] {
    // 自动选题语义:sensitive 不进自动池(只允许用户显式选择)
    return gatedPool(ctx).filter((c) => c.sensitivity !== 'sensitive')
  }

  return { query, resolve, candidates }
}
