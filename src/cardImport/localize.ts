// 角色卡语义本地化:非中文卡在导入时译成中文人设(语义等价,不是逐词直译)。
// 三路并行:core(描述/性格/场景)/ style(first_mes + mes_example,保留 <START>)/
// lore(条目正文中文化,keys 生成中文别名→最终 keys = 原文 + 中文别名)。
// 识别:逐字段启发式(CJK 占比 + 假名/谚文信号)——全中卡的导入零 LLM 调用。
// 纪律:失败 fail-open(该路按原文导入 + warning);complete 可注入,测试零网络。
import { complete } from '../engine/llmGateway'
import type { CardLoreEntry, RawCard } from './parseCard'

/** 单字段超过此长度按段落切块顺序翻译(拼接保留段落结构,translator.ts 同款思路) */
const FIELD_CHUNK_CHARS = 3600
/** lore 本地化输入总量护栏:超出部分按优先级放弃本地化(原样留档) */
const LORE_INPUT_CHARS_MAX = 12_000

/** 是否需要本地化为中文:CJK(汉字)占比高且无假名/谚文 → 视为中文。
 *  先剥离 <START> 等尖括号标记,避免协议标签的拉丁字符污染占比 */
export function needsLocalization(text: string): boolean {
  const t = text.replace(/<[^<>\n]{0,24}>/g, ' ').trim()
  if (!t) return false
  let ideograph = 0
  let kana = 0
  let hangul = 0
  let latin = 0
  let total = 0
  for (const ch of t) {
    if (/\s/.test(ch)) continue
    total += 1
    const code = ch.codePointAt(0)!
    if (code >= 0x4e00 && code <= 0x9fff) ideograph += 1
    else if (code >= 0x3040 && code <= 0x30ff) kana += 1
    else if (code >= 0xac00 && code <= 0xd7af) hangul += 1
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1
  }
  if (total === 0) return false
  if (kana / total > 0.05) return true // 日文(含汉字假名混排)
  if (hangul / total > 0.1) return true // 韩文
  if (latin / total > 0.4) return true // 拉丁字母为主
  return ideograph / total < 0.3 // 其余:汉字占比不足即视为外语
}

export interface LocalizeDeps {
  /** 网关补全(默认 llmGateway.complete);测试注入 fake */
  complete?: (input: { messages: Array<{ role: string; content: string }>; maxTokens: number }) => Promise<string>
}

export interface LocalizeOutcome {
  card: RawCard
  /** true = 至少一个字段被本地化过 */
  localized: boolean
  warnings: string[]
}

const SYSTEM_CORE =
  '你是角色卡本地化专家。把角色设定忠实译成简体中文:语义等价、设定细节一条不增不减、不解释不加评;人名等专有名词可保留原文或用通用中文译名,全篇必须一致;口语自然,无翻译腔。只输出一个 JSON 对象,不要任何其他文字。'
const SYSTEM_STYLE =
  '你是角色卡本地化专家。把角色对话示例/开场白忠实译成简体中文:严格保留 <START> 分隔符、说话人前缀与换行排版;语气口语自然,无翻译腔。只输出一个 JSON 对象,不要任何其他文字。'
const SYSTEM_LORE =
  '你是角色卡本地化专家。输入是世界书条目数组:把每条 content 忠实译成简体中文(不增不减),并为每条的 keys 生成 1~3 个中文别名(音译/意译,便于中文关键词检索)。只输出一个 JSON 对象:{"entries":[{"i":条目序号,"content":"中文正文","aliases":["中文别名"]}]},不要任何其他文字。'

async function callJson(deps: LocalizeDeps, system: string, user: string, maxTokens: number): Promise<unknown> {
  const raw = await (deps.complete ?? defaultComplete)({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens })
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('本地化响应不是合法 JSON')
  return JSON.parse(m[0])
}

async function defaultComplete(input: { messages: Array<{ role: string; content: string }>; maxTokens: number }): Promise<string> {
  return await complete({ messages: input.messages, jsonMode: true, temperature: 0.2, maxTokens: input.maxTokens, timeoutMs: 90_000 })
}

/** 超长字段按段落切块顺序翻译再拼接(块间补换行,不叠空行) */
async function localizeLongText(deps: LocalizeDeps, text: string, kind: string): Promise<string> {
  if (text.length <= FIELD_CHUNK_CHARS) {
    const out = await callJson(deps, SYSTEM_CORE, `把下面的"${kind}"译成简体中文,只输出 JSON:{"text":"…"}。\n\n${text}`, 12_000)
    return String((out as { text?: unknown }).text ?? text)
  }
  const chunks: string[] = []
  let cur = ''
  for (const para of text.split(/\n/)) {
    if (cur && cur.length + para.length + 1 > FIELD_CHUNK_CHARS) {
      chunks.push(cur)
      cur = ''
    }
    cur = cur ? `${cur}\n${para}` : para
  }
  if (cur.trim()) chunks.push(cur)
  const parts: string[] = []
  for (const chunk of chunks) {
    const out = await callJson(deps, SYSTEM_CORE, `把下面的"${kind}"片段译成简体中文(它是长文的连续片段,只译不续写),只输出 JSON:{"text":"…"}。\n\n${chunk}`, 12_000)
    parts.push(String((out as { text?: unknown }).text ?? chunk))
  }
  return parts.join('\n')
}

async function localizeCore(deps: LocalizeDeps, card: RawCard): Promise<{ description?: string; personality?: string; scenario?: string }> {
  // 逐字段独立判定;整字段走切块路径,只有短字段才合批
  const fields = (['description', 'personality', 'scenario'] as const).filter((k) => needsLocalization(card[k]))
  const out: { description?: string; personality?: string; scenario?: string } = {}
  for (const key of fields) {
    out[key] = await localizeLongText(deps, card[key], LABELS[key])
  }
  return out
}

const LABELS = { description: '角色描述', personality: '性格', scenario: '场景背景' } as const

async function localizeStyle(deps: LocalizeDeps, card: RawCard): Promise<{ firstMes?: string; mesExample?: string }> {
  const out: { firstMes?: string; mesExample?: string } = {}
  const parts: string[] = []
  if (needsLocalization(card.firstMes)) parts.push(`first_mes:\n${card.firstMes}`)
  if (needsLocalization(card.mesExample)) parts.push(`mes_example:\n${card.mesExample}`)
  if (parts.length === 0) return out
  const json = (await callJson(deps, SYSTEM_STYLE, `把以下字段译成简体中文(保留 <START> 与排版),只输出 JSON:{"first_mes":"…","mes_example":"…"}(源里没有的字段返回空串)。\n\n${parts.join('\n\n')}`, 8000)) as {
    first_mes?: unknown
    mes_example?: unknown
  }
  if (parts.some((p) => p.startsWith('first_mes:')) && typeof json.first_mes === 'string' && json.first_mes.trim()) out.firstMes = json.first_mes.trim()
  if (parts.some((p) => p.startsWith('mes_example:')) && typeof json.mes_example === 'string' && json.mes_example.trim()) out.mesExample = json.mes_example.trim()
  return out
}

interface LorePatch {
  content: string
  aliases: string[]
}

async function localizeLore(deps: LocalizeDeps, entries: CardLoreEntry[]): Promise<Map<number, LorePatch>> {
  const patches = new Map<number, LorePatch>()
  if (entries.length === 0) return patches
  // 输入总量护栏:超限的条目放弃本地化(原样留档)
  const picked: Array<{ index: number; entry: CardLoreEntry }> = []
  let used = 0
  entries.forEach((entry, index) => {
    if (used + entry.content.length > LORE_INPUT_CHARS_MAX) return
    used += entry.content.length
    picked.push({ index, entry })
  })
  const payload = picked.map(({ entry }, i) => ({ i, keys: entry.keys, content: entry.content }))
  const json = (await callJson(
    deps,
    SYSTEM_LORE,
    `条目数组(${payload.length} 条):\n${JSON.stringify(payload)}`,
    12_000,
  )) as { entries?: Array<{ i?: unknown; content?: unknown; aliases?: unknown }> }
  const list = Array.isArray(json.entries) ? json.entries : []
  for (const item of list) {
    if (typeof item?.i !== 'number') continue
    const pickedAt = picked.findIndex((p) => p.index === item.i)
    if (pickedAt < 0) continue
    const { index, entry } = picked[pickedAt]!
    const content = typeof item.content === 'string' && item.content.trim() ? item.content.trim() : entry.content
    const aliases = Array.isArray(item.aliases)
      ? item.aliases.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim()).slice(0, 3)
      : []
    patches.set(index, { content, aliases })
  }
  return patches
}

/** 对卡做按需本地化:返回新卡对象(不修改入参)。任何一路失败按原文继续 + warning */
export async function localizeRawCard(card: RawCard, deps: LocalizeDeps = {}): Promise<LocalizeOutcome> {
  const warnings: string[] = []
  const localizedCard: RawCard = { ...card }
  let localized = false

  const [core, style, lorePatches] = await Promise.all([
    localizeCore(deps, card).catch((e) => {
      warnings.push(`核心设定本地化失败,已按原文导入(${String((e as Error)?.message ?? e).slice(0, 60)})`)
      return {} as { description?: string; personality?: string; scenario?: string }
    }),
    localizeStyle(deps, card).catch((e) => {
      warnings.push(`风格示例本地化失败,已按原文导入(${String((e as Error)?.message ?? e).slice(0, 60)})`)
      return {} as { firstMes?: string; mesExample?: string }
    }),
    card.loreBook
      ? localizeLore(deps, card.loreBook).catch((e) => {
          warnings.push(`世界书本地化失败,已按原文留档(${String((e as Error)?.message ?? e).slice(0, 60)})`)
          return new Map<number, LorePatch>()
        })
      : Promise.resolve(new Map<number, LorePatch>()),
  ])

  for (const key of ['description', 'personality', 'scenario'] as const) {
    if (core[key]) {
      localizedCard[key] = core[key]!
      localized = true
    }
  }
  if (style.firstMes) {
    localizedCard.firstMes = style.firstMes
    localized = true
  }
  if (style.mesExample) {
    localizedCard.mesExample = style.mesExample
    localized = true
  }
  if (localizedCard.loreBook && lorePatches.size > 0) {
    localizedCard.loreBook = localizedCard.loreBook.map((entry, index) => {
      const patch = lorePatches.get(index)
      if (!patch) return entry
      localized = true
      // keys 保留原文 + 中文别名(去重);aliases 单独保留供留档
      const keys = [...new Set([...entry.keys, ...patch.aliases])]
      return { ...entry, content: patch.content, keys, aliases: patch.aliases }
    })
  }
  return { card: localizedCard, localized, warnings }
}

/** 卡级判定:任一主要字段需要本地化即为非中文卡(决定 UI 提示与调用) */
export function cardNeedsLocalization(card: RawCard): boolean {
  const main = [card.description, card.personality, card.scenario, card.firstMes, card.mesExample]
  if (main.some((t) => needsLocalization(t))) return true
  return (card.loreBook ?? []).some((e) => e.enabled && needsLocalization(e.content))
}
