// 角色共同记忆(角色世界):appData/data/story.json。
// gags[]:两人之间的固定笑点/歪理(如"冰箱是甲的健身器材"),后续剧集可自然回收;
// threads[]:尚未了结的事件线(如"乙还欠甲一杯奶茶"),适合在包袱里了结。
// 与 memoryStore(观众事实)刻意分离:笑点回调只用角色共同经历,观众隐私只作亲切感语境。
// 全部写操作走 withFileLock;浏览器预览降级 localStorage。失败静默不影响演出。

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'
import { migrateStoryData } from './storyMigration'
import { nameOf } from '../engine/persona'
import type { MoodEventCandidate } from '../engine/moodState'

export interface StoryGag {
  id: string
  text: string
  lastSeen: number
  hits: number
  /** 最近一次被放进创作提示词的时间；用于冷却轮换，0 = 从未注入 */
  lastInjectedAt: number
}

export interface StoryThread {
  id: string
  text: string
  lastSeen: number
  /** 最近一次被放进创作提示词的时间；用于冷却轮换，0 = 从未注入 */
  lastInjectedAt: number
}

export interface StoryArc {
  id: string
  title: string
  /** 已演出的拍数;第 1 拍 = newArc 时的那集 */
  stage: number
  /** 下一拍要演出的进展/悬念;完结后为空串 */
  nextHook: string
  /** 完结线的收尾存档(最后一拍演了什么);活跃线没有此字段 */
  ending?: string
  status: 'active' | 'done'
  lastSeen: number
}

export interface StoryData {
  version: 2
  gags: StoryGag[]
  threads: StoryThread[]
  arcs: StoryArc[]
  /** 两角色的长期关系数值:缓慢衰减,由拖拽距离等互动缓慢漂移 */
  bond: Bond
}

/** 关系事件类别:先记具体事件,再小步聚合到 trust/rivalry(避免数值变化没有来由) */
export type RelationshipEventKind = 'support' | 'betrayal' | 'repair' | 'rivalry' | 'user-sided'

/** 一笔关系事件:台词里明确发生的和解/背叛/支持/较劲/观众站队。
 *  涉及丙(C)的事件只记进账本当叙事记忆,不驱动 A:B 的关系数值 */
export interface RelationshipEvent {
  kind: RelationshipEventKind
  /** 谁发起,对谁 */
  actor: 'A' | 'B' | 'C' | 'audience'
  target: 'A' | 'B' | 'C'
  /** 程度 0.5~1,聚合时缩放数值变化 */
  weight: number
  /** 一句话:谁对谁做了什么 */
  summary: string
  ts: number
  eid?: string
}

export interface Bond {
  /** 信任 -3(互相看不顺眼)..3(很铁) */
  trust: number
  /** 摩擦 0(相安无事)..5(天天较劲) */
  rivalry: number
  updatedAt: number
  /** 最近的关系事件账本(新在前,最多 20 条) */
  events?: RelationshipEvent[]
}

const MAX_GAGS = 30
const MAX_THREADS = 15
const MAX_ACTIVE_ARCS = 3
/** 剧情线拍到第 4 拍自动完结(多集小剧情,不宜无限拖) */
const MAX_ARC_STAGE = 4
const LS_KEY = 'vc-story'
const DEFAULT_BOND: Bond = { trust: 1, rivalry: 0, updatedAt: 0 }
const EMPTY: StoryData = { version: 2, gags: [], threads: [], arcs: [], bond: { ...DEFAULT_BOND, updatedAt: 0 } }

const clampTrust = (v: number): number => Math.min(3, Math.max(-3, v))
const clampRivalry = (v: number): number => Math.min(5, Math.max(0, v))

let cache: StoryData | null = null

function clone(data: StoryData): StoryData {
  return JSON.parse(JSON.stringify(data)) as StoryData
}

async function storyFile(): Promise<string> {
  const base = await appDataDir()
  const dir = await join(base, 'data')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return join(dir, 'story.json')
}

function newId(prefix: string): string {
  return `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeGag(v: unknown): StoryGag | null {
  const o = (v ?? {}) as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text.trim().slice(0, 60) : ''
  if (!text) return null
  const now = Date.now()
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : newId('g'),
    text,
    lastSeen: Number(o.lastSeen) || now,
    hits: Math.max(0, Number(o.hits) || 0),
    lastInjectedAt: Math.max(0, Number(o.lastInjectedAt) || 0),
  }
}

function sanitizeThread(v: unknown): StoryThread | null {
  const o = (v ?? {}) as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text.trim().slice(0, 60) : ''
  if (!text) return null
  const now = Date.now()
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : newId('t'),
    text,
    lastSeen: Number(o.lastSeen) || now,
    lastInjectedAt: Math.max(0, Number(o.lastInjectedAt) || 0),
  }
}

function sanitizeArc(v: unknown): StoryArc | null {
  const o = (v ?? {}) as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, 30) : ''
  const hook = typeof o.nextHook === 'string' ? o.nextHook.trim().slice(0, 60) : ''
  const status = o.status === 'done' ? 'done' : 'active'
  // v2 起完结线 nextHook 为空、收尾存于 ending;这里宽容读取,避免旧档被吞
  if (!title || (!hook && status !== 'done')) return null
  const now = Date.now()
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : newId('a'),
    title,
    stage: Math.min(MAX_ARC_STAGE, Math.max(1, Number(o.stage) || 1)),
    nextHook: hook,
    ending:
      status === 'done' && typeof o.ending === 'string' && o.ending.trim()
        ? o.ending.trim().slice(0, 60)
        : undefined,
    status,
    lastSeen: Number(o.lastSeen) || now,
  }
}

function sanitize(data: unknown): StoryData {
  const o = (data ?? {}) as Record<string, unknown>
  const gags = (Array.isArray(o.gags) ? o.gags : [])
    .map(sanitizeGag)
    .filter((g): g is StoryGag => g !== null)
    .slice(0, MAX_GAGS)
  const threads = (Array.isArray(o.threads) ? o.threads : [])
    .map(sanitizeThread)
    .filter((t): t is StoryThread => t !== null)
    .slice(0, MAX_THREADS)
  const arcs = (Array.isArray(o.arcs) ? o.arcs : [])
    .map(sanitizeArc)
    .filter((a): a is StoryArc => a !== null)
    .slice(0, 8)
  const bo = (o.bond ?? {}) as Record<string, unknown>
  const bond: Bond = {
    trust: clampTrust(Number(bo.trust) || 0) || 0,
    rivalry: clampRivalry(Number(bo.rivalry) || 0),
    updatedAt: Number(bo.updatedAt) || 0,
    events: (Array.isArray(bo.events) ? bo.events : [])
      .filter((ev): ev is RelationshipEvent => !!ev && typeof ev === 'object' && typeof (ev as RelationshipEvent).kind === 'string')
      .slice(0, 20),
  }
  return { version: 2, gags, threads, arcs, bond }
}

/** 读档入口:version 1 的旧数据先过内容迁移(老梗合并/事件线清理/完结线收尾入档)再清洗 */
function revive(parsed: unknown): StoryData {
  const version = (parsed as { version?: unknown } | null)?.version
  return sanitize(version === 1 ? migrateStoryData(parsed).data : parsed)
}

async function loadRaw(): Promise<StoryData> {
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return revive(JSON.parse(raw))
    } catch (e) {
      console.warn('浏览器角色世界读取失败', e)
    }
    return clone(EMPTY)
  }
  try {
    const file = await storyFile()
    if (await exists(file)) return revive(JSON.parse(await readTextFile(file)))
  } catch (e) {
    console.warn('角色世界读取失败', e)
  }
  return clone(EMPTY)
}

/** 读全部角色世界(内存缓存) */
export async function getStory(): Promise<StoryData> {
  if (!cache) cache = await loadRaw()
  return clone(cache)
}

/** 变更落盘 */
async function persist(next: StoryData): Promise<void> {
  cache = next
  if (!inTauri) {
    localStorage.setItem(LS_KEY, JSON.stringify(next))
    return
  }
  await writeTextFile(await storyFile(), JSON.stringify(next, null, 2))
}

/** 蒸馏结果里的剧情线记账 */
export interface ArcAdvance {
  id: string
  nextHook: string
}

export interface NewArc {
  title: string
  hook: string
}

/** 候选素材的断言类别:入库政策据此决定"事实保留、吹牛甩锅保语气、反问猜测拒收" */
export type StoryAssertion = 'established' | 'boast' | 'excuse' | 'question' | 'hypothesis'

/** 蒸馏候选:模型给出的新素材,必须附台词证据与断言类别 */
export interface StoryCandidate {
  text: string
  /** 逐字摘自本集台词的片段,入库前由 curator 校验确实出现在台词里 */
  evidence: string[]
  assertion: StoryAssertion
  /** 模型判定该候选只是库存某老梗换了说法时,填那条老梗的编号 */
  sameAsId: string | null
}

/** 模型蒸馏输出(清洗后)。政策判断在 storyCurator,存储不变量在 mergeStory */
export interface DistilledStory {
  newGags: StoryCandidate[]
  newThreads: StoryCandidate[]
  /** 台词里已经了结的已知事件线 id(结案后不再注入) */
  resolvedThreadIds: string[]
  /** 台词里实际回收了的已知老梗 id(真实"被用过"计数) */
  reusedGagIds: string[]
  /** 连续剧情推进一拍(写新钩子,stage 由存储层自增) */
  arcAdvance: ArcAdvance | null
  /** 本集冒出的值得多集延续的新剧情线(最多 1 条),closeThreadIds 为被它吸收的事件线 */
  newArc: (NewArc & { closeThreadIds: string[] }) | null
  /** 台词里明确发生的关系事件(每集最多 1 笔,拿不准为 null) */
  relationshipEvent: RelationshipEventCandidate | null
  /** 本集结尾各角色的情绪余波候选(须过台词证据关,由策展器校验后入 mood.json) */
  mood: MoodEventCandidate[]
}

/** curator 产出、mergeStory 消费的入库补丁:候选已过证据/断言/语义去重关,
 *  这里只做存储层不变量(字数/主体/确定性去重/上限淘汰/生命周期) */
export interface StoryPatch {
  gags: { text: string }[]
  threads: { text: string }[]
  /** sameAs 合并:把库存老梗的措辞更新为更规范的表述,并 hits+1 */
  canonicalizedGags: { id: string; text: string }[]
  reusedGagIds: string[]
  resolvedThreadIds: string[]
  arcAdvance: ArcAdvance | null
  newArc: (NewArc & { closeThreadIds: string[] }) | null
}

const STORY_TEXT_RULES = {
  gag: { min: 8, max: 40 },
  thread: { min: 10, max: 60 },
  arcTitle: { min: 2, max: 15 },
  arcHook: { min: 10, max: 60 },
} as const

export type StoryTextKind = keyof typeof STORY_TEXT_RULES

/** 写入路径的字数/主体校验,返回拒绝原因(null=通过)。只管写入:
 *  加载路径保持宽容,不因收紧规则丢历史数据 */
export function validateStoryText(kind: StoryTextKind, text: string): string | null {
  const { min, max } = STORY_TEXT_RULES[kind]
  const t = text.trim()
  if (t.length < min) return `太短(至少${min}字)`
  if (t.length > max) return `太长(至多${max}字)`
  if (kind === 'gag' || kind === 'thread') {
    // 主体:甲/乙/丙或当前配置名(旧库条目是甲乙丙,新条目按配置名入库)
    const subjects = ['甲', '乙', '丙', nameOf('A'), nameOf('B'), nameOf('C')]
    if (!subjects.some((s) => t.includes(s))) return '缺少角色主体(甲/乙/丙或其配置名)'
  }
  return null
}

/** 去重用规范化:统一"甲家(的)"→"甲",去标点/符号/空白/常见语气词 */
export function normalizeStoryText(text: string): string {
  return text
    .replace(/甲家(的)?/g, '甲')
    .replace(/[\p{P}\p{S}\s]/gu, '')
    .replace(/[吧呢啊嘛哦咯啦呀哈哎嗯]/g, '')
}

/** 中文二元词组 Dice 相似度 0..1(规范化后按字面相近程度合并换说法的重复入库) */
export function storyTextSimilarity(a: string, b: string): number {
  const na = normalizeStoryText(a)
  const nb = normalizeStoryText(b)
  if (na === nb) return 1
  if (na.length < 2 || nb.length < 2) return 0
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const ga = grams(na)
  const gb = grams(nb)
  let inter = 0
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0)
  const total = [...ga.values()].reduce((s, v) => s + v, 0) + [...gb.values()].reduce((s, v) => s + v, 0)
  return total === 0 ? 0 : (2 * inter) / total
}

/** 相似度达到该值视为同一素材:不再新增,只给已有条目计一次使用 */
export const SIMILAR_MERGE_THRESHOLD = 0.7

/** 合并一次入库补丁:
 *  - resolvedThreadIds:台词里已了结的事件线 → 结案移除,不再注入
 *  - reusedGagIds/canonicalizedGags:真实回收 → hits+1(后者顺带把措辞更新为规范表述)
 *  - gags/threads:过字数/主体校验后入库,与库存完全或高度相似(≥0.7)时只计数不新增
 *  - arcAdvance:连续剧情推进一拍;拍到顶自动完结,刚演的拍存为 ending,完结线不再有下一拍
 *  - newArc:新剧情线(活跃线满 3 拒绝),创建同时结案被它吸收的事件线 */
export async function mergeStory(result: StoryPatch): Promise<void> {
  const hasNew = result.gags.length > 0 || result.threads.length > 0 || result.canonicalizedGags.length > 0
  const hasBookkeeping =
    result.resolvedThreadIds.length > 0 ||
    result.reusedGagIds.length > 0 ||
    !!result.arcAdvance ||
    !!result.newArc
  if (!hasNew && !hasBookkeeping) return
  await withFileLock('story', async () => {
    const story = await getStory()
    const now = Date.now()
    // 剧情线推进一拍
    if (result.arcAdvance) {
      const arc = story.arcs.find(
        (a) => a.id === result.arcAdvance!.id && a.status === 'active',
      )
      if (arc) {
        const played = arc.nextHook
        arc.stage += 1
        arc.lastSeen = now
        if (arc.stage >= MAX_ARC_STAGE) {
          // 拍满完结:刚演完的拍存为结局,完结线不再有下一拍
          arc.status = 'done'
          if (played) arc.ending = played
          arc.nextHook = ''
        } else if (!validateStoryText('arcHook', result.arcAdvance.nextHook)) {
          arc.nextHook = result.arcAdvance.nextHook.trim()
        }
      }
    }
    // 新剧情线:活跃位满 3 条时拒绝,防剧情线挤掉日常
    if (result.newArc) {
      const title = result.newArc.title.trim()
      const hook = result.newArc.hook.trim()
      const dup = story.arcs.some(
        (a) =>
          a.status === 'active' &&
          (a.title === title || storyTextSimilarity(a.title, title) >= SIMILAR_MERGE_THRESHOLD),
      )
      if (
        !validateStoryText('arcTitle', title) &&
        !validateStoryText('arcHook', hook) &&
        !dup &&
        story.arcs.filter((a) => a.status === 'active').length < MAX_ACTIVE_ARCS
      ) {
        story.arcs.push({ id: newId('a'), title, stage: 1, nextHook: hook, status: 'active', lastSeen: now })
        // 被剧情线吸收的事件线随之结案:同一件事不得同时挂在事件线和剧情线上
        if (result.newArc.closeThreadIds.length > 0) {
          const absorbed = new Set(result.newArc.closeThreadIds)
          story.threads = story.threads.filter((t) => !absorbed.has(t.id))
        }
      }
    }
    // 结案:已了结的事件线移除
    if (result.resolvedThreadIds.length > 0) {
      story.threads = story.threads.filter((t) => !result.resolvedThreadIds.includes(t.id))
    }
    // 真实回收计数
    for (const id of result.reusedGagIds) {
      const gag = story.gags.find((g) => g.id === id)
      if (gag) {
        gag.hits += 1
        gag.lastSeen = now
      }
    }
    // sameAs 规范化:措辞更新为更自包含的表述,同时计一次使用
    for (const c of result.canonicalizedGags) {
      const gag = story.gags.find((g) => g.id === c.id)
      if (!gag || validateStoryText('gag', c.text)) continue
      gag.text = c.text.trim()
      gag.hits += 1
      gag.lastSeen = now
    }
    for (const { text } of result.gags) {
      if (validateStoryText('gag', text)) continue
      const existing =
        story.gags.find((g) => g.text === text) ??
        story.gags.find((g) => storyTextSimilarity(g.text, text) >= SIMILAR_MERGE_THRESHOLD)
      if (existing) {
        existing.lastSeen = now
        existing.hits += 1
      } else {
        story.gags.push({ id: newId('g'), text: text.trim(), lastSeen: now, hits: 0, lastInjectedAt: 0 })
      }
    }
    for (const { text } of result.threads) {
      if (validateStoryText('thread', text)) continue
      const existing =
        story.threads.find((t) => t.text === text) ??
        story.threads.find((t) => storyTextSimilarity(t.text, text) >= SIMILAR_MERGE_THRESHOLD)
      if (existing) {
        existing.lastSeen = now
      } else {
        story.threads.push({ id: newId('t'), text: text.trim(), lastSeen: now, lastInjectedAt: 0 })
      }
    }
    if (story.gags.length > MAX_GAGS) {
      story.gags = [...story.gags]
        .sort((a, b) => b.lastSeen - a.lastSeen || b.hits - a.hits)
        .slice(0, MAX_GAGS)
    }
    if (story.threads.length > MAX_THREADS) {
      story.threads = [...story.threads].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_THREADS)
    }
    await persist(story)
  })
}

export async function removeStoryItem(kind: 'gags' | 'threads', id: string): Promise<void> {
  await withFileLock('story', async () => {
    const story = await getStory()
    if (kind === 'gags') story.gags = story.gags.filter((x) => x.id !== id)
    else story.threads = story.threads.filter((x) => x.id !== id)
    await persist(story)
  })
}

/** 删除一条剧情线 */
export async function removeArc(id: string): Promise<void> {
  await withFileLock('story', async () => {
    const story = await getStory()
    story.arcs = story.arcs.filter((a) => a.id !== id)
    await persist(story)
  })
}

/** 抽一个连续剧情节拍:30% 概率命中(其余返回 null,本集走普通话题);
 *  多条活跃剧情线时推进"最久没演"的那条。rng 可注入便于测试 */
export function pickArcBeat(
  arcs: StoryArc[],
  rng: () => number = Math.random,
): { id: string; title: string; hook: string; stage: number } | null {
  const active = arcs.filter((a) => a.status === 'active')
  if (active.length === 0 || rng() >= 0.3) return null
  const arc = [...active].sort((a, b) => a.lastSeen - b.lastSeen)[0]!
  return { id: arc.id, title: arc.title, hook: arc.nextHook, stage: arc.stage }
}

const GENERIC_TOPIC_TERMS = new Set([
  '一个', '一下', '已经', '还是', '不是', '这个', '那个', '怎么', '什么', '为什', '到底',
  '可以', '继续', '当前', '本集', '剧情', '下一', '一拍', '观众', '使用', '相关', '事情',
  '进行', '发现', '结果', '最后', '两人', '时候', '现场', '视角',
])

/** 中文没有空格，按 2~4 字片段提取保守关键词；宁可少注入，也不把无关老梗硬塞进新主题。 */
function topicTerms(text: string): Set<string> {
  const out = new Set<string>()
  const chunks = text.toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z\d]{2,}/gu) ?? []
  for (const chunk of chunks) {
    if (/^[a-z\d]+$/.test(chunk)) {
      out.add(chunk)
      continue
    }
    for (const width of [2, 3, 4]) {
      for (let i = 0; i <= chunk.length - width; i++) {
        const term = chunk.slice(i, i + width)
        if (!GENERIC_TOPIC_TERMS.has(term)) out.add(term)
      }
    }
  }
  return out
}

function isTopicRelated(text: string, topicTermsSet: Set<string>): boolean {
  if (topicTermsSet.size === 0) return false
  for (const term of topicTerms(text)) {
    if (topicTermsSet.has(term)) return true
  }
  return false
}

export interface StoryContextSelection {
  gags: StoryGag[]
  threads: StoryThread[]
}

/**
 * 从完整角色世界里挑本轮可注入素材：先按当前主题过滤，再按“最久没注入”轮换。
 * hits 只作低频优先的次级条件，避免越复用越霸榜的正反馈循环。
 */
export function selectStoryItems(
  story: StoryData,
  topic: string,
  maxEach = 2,
): StoryContextSelection {
  const terms = topicTerms(topic)
  const byCooldown = <T extends { lastInjectedAt: number; lastSeen: number; hits?: number }>(
    a: T,
    b: T,
  ): number =>
    a.lastInjectedAt - b.lastInjectedAt ||
    (a.hits ?? 0) - (b.hits ?? 0) ||
    b.lastSeen - a.lastSeen
  return {
    gags: story.gags
      .filter((item) => isTopicRelated(item.text, terms))
      .sort(byCooldown)
      .slice(0, maxEach),
    threads: story.threads
      .filter((item) => isTopicRelated(item.text, terms))
      .sort(byCooldown)
      .slice(0, maxEach),
  }
}

/** 预览模式:选材但不写注入冷却——预生成场景由采纳方在真正开播时调 commitStoryInjection 补记 */
export async function previewStoryContext(
  topic: string,
  maxEach = 2,
): Promise<{ gags: string[]; threads: string[]; gagIds: string[]; threadIds: string[] }> {
  const story = await getStory()
  const selected = selectStoryItems(story, topic, maxEach)
  return {
    gags: selected.gags.map((item) => item.text),
    threads: selected.threads.map((item) => item.text),
    gagIds: selected.gags.map((item) => item.id),
    threadIds: selected.threads.map((item) => item.id),
  }
}

/** 预览过的素材真正开播时补记注入冷却(下轮换位依据) */
export async function commitStoryInjection(gagIds: string[], threadIds: string[]): Promise<void> {
  if (gagIds.length === 0 && threadIds.length === 0) return
  await withFileLock('story', async () => {
    const story = await getStory()
    const now = Date.now()
    let touched = false
    for (const item of story.gags) {
      if (gagIds.includes(item.id)) {
        item.lastInjectedAt = now
        touched = true
      }
    }
    for (const item of story.threads) {
      if (threadIds.includes(item.id)) {
        item.lastInjectedAt = now
        touched = true
      }
    }
    if (touched) await persist(story)
  })
}

/** 注入用：只取与本轮主题相关且已冷却的素材，并持久化本次注入时间用于下轮换位。 */
export async function storyContext(
  topic: string,
  maxEach = 2,
): Promise<{ gags: string[]; threads: string[] }> {
  const selected = await previewStoryContext(topic, maxEach)
  await commitStoryInjection(selected.gagIds, selected.threadIds)
  return { gags: selected.gags, threads: selected.threads }
}

/** 读长期关系:按距上次更新的自然日数做缓慢衰减(每天 trust 向 0 回 0.5、rivalry 降 0.5),
 *  避免角色永久记仇 */
export async function getBond(): Promise<Bond> {
  const story = await getStory()
  const b = story.bond
  const days = Math.floor((Date.now() - b.updatedAt) / 86_400_000)
  const trust = clampTrust(b.trust - days * 0.5 * Math.sign(b.trust || 1))
  const rivalry = clampRivalry(b.rivalry - days * 0.5)
  return { trust, rivalry, updatedAt: b.updatedAt }
}

/** 互动信号回写:拖近/拖远等事件小幅漂移关系,冷却由调用方控制 */
export async function shiftBond(dTrust: number, dRivalry: number): Promise<void> {
  await withFileLock('story', async () => {
    const story = await getStory()
    story.bond.trust = clampTrust(story.bond.trust + dTrust)
    story.bond.rivalry = clampRivalry(story.bond.rivalry + dRivalry)
    story.bond.updatedAt = Date.now()
    await persist(story)
  })
}

/** 关系事件 → 数值变化:单步都很小,方向由事件类别决定 */
const RELATIONSHIP_DELTAS: Record<RelationshipEventKind, { dTrust: number; dRivalry: number }> = {
  support: { dTrust: 0.25, dRivalry: 0 },
  betrayal: { dTrust: -0.5, dRivalry: 0.25 },
  repair: { dTrust: 0.5, dRivalry: -0.25 },
  rivalry: { dTrust: 0, dRivalry: 0.3 },
  'user-sided': { dTrust: 0.25, dRivalry: 0.15 },
}

/** 蒸馏产出的关系事件候选(未落账,缺 ts/eid) */
export interface RelationshipEventCandidate {
  kind: RelationshipEventKind
  actor: 'A' | 'B' | 'C' | 'audience'
  target: 'A' | 'B' | 'C'
  weight: number
  summary: string
}

/** 记一笔关系事件进账本(新在前,最多 20 条)并小步聚合到 trust/rivalry。
 *  "一集最多一笔"由调用方(策展器)保证。
 *  涉及丙的事件只记账不驱动数值:A:B 的信任/摩擦语义对"甲乙逗丙"不成立,
 *  账本保留它只作叙事记忆(下次蒸馏可见) */
export async function applyRelationshipEvent(
  event: RelationshipEventCandidate,
  eid?: string,
): Promise<void> {
  const involvesC = event.actor === 'C' || event.target === 'C'
  await withFileLock('story', async () => {
    const story = await getStory()
    const delta = involvesC ? { dTrust: 0, dRivalry: 0 } : RELATIONSHIP_DELTAS[event.kind] ?? { dTrust: 0, dRivalry: 0 }
    story.bond.trust = clampTrust(story.bond.trust + delta.dTrust * event.weight)
    story.bond.rivalry = clampRivalry(story.bond.rivalry + delta.dRivalry * event.weight)
    story.bond.updatedAt = Date.now()
    story.bond.events = [{ ...event, ts: Date.now(), eid }, ...(story.bond.events ?? [])].slice(0, 20)
    await persist(story)
  })
}

/** 蒸馏/策展用的带 id 库存清单。必须给全量(老梗 30/事件线 15/活跃剧情 3,体量很小):
 *  语义去重要求模型看全库存,只喂热度 top-N 会让它认不出"换说法的重复" */
export interface StoryInventory {
  gags: { id: string; text: string }[]
  threads: { id: string; text: string }[]
  arcs: { id: string; title: string; stage: number; hook: string }[]
  /** 已完结剧情只给标题和结局摘要作背景,不得推进、不得再报成事件线 */
  doneArcs: { id: string; title: string; ending: string }[]
}

export async function storyInventory(): Promise<StoryInventory> {
  const story = await getStory()
  return {
    gags: story.gags.map((g) => ({ id: g.id, text: g.text })),
    threads: story.threads.map((t) => ({ id: t.id, text: t.text })),
    arcs: story.arcs
      .filter((a) => a.status === 'active')
      .map((a) => ({ id: a.id, title: a.title, stage: a.stage, hook: a.nextHook })),
    doneArcs: story.arcs
      .filter((a) => a.status === 'done')
      .map((a) => ({ id: a.id, title: a.title, ending: a.ending ?? '' })),
  }
}
