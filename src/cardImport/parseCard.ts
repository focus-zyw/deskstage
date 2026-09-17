// 酒馆 Character Card 解析(纯函数,零网络):PNG(tEXt/zTXt 内嵌 base64 JSON)或裸 JSON
// → 归一化 RawCard。spec 兼容 chara_card_v2 / chara_card_v3 / 平铺 v1;
// PNG 文本块关键字 'ccv3'(V3)优先于 'chara'(V1/V2 通用)。宏替换仅做
// {{char}}/<BOT>/{{user}}/<USER> 四种高频项,其余宏原样保留。
// 字节遍历只认 PNG 结构,不校验 CRC(解析元数据不需要);zTXt 走 zlib inflate(pako)。
import { inflate } from 'pako'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export interface CardLoreEntry {
  keys: string[]
  content: string
  /** 常驻条目(每次注入)——只有这些会被烘焙进人设 */
  constant: boolean
  priority: number
  enabled: boolean
  comment?: string
  /** 本地化生成的中文别名(keys = 原文 + 别名;留档与未来世界书检索用) */
  aliases?: string[]
}

export interface RawCard {
  spec: 'v1' | 'chara_card_v2' | 'chara_card_v3'
  name: string
  description: string
  personality: string
  scenario: string
  firstMes: string
  mesExample: string
  alternateGreetings: string[]
  creatorNotes: string
  creator: string
  characterVersion: string
  tags: string[]
  loreBook?: CardLoreEntry[]
}

export type ParseCardResult =
  | { ok: true; card: RawCard; /** 原始 JSON 文本(留档用,store 侧另有体积护栏) */ sourceJson: string }
  | { ok: false; error: string }

/** bytes → latin1 文本(tEXt/zTXt 的编码约定) */
function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]!)
  return out
}

/** 遍历 PNG chunk,收集 tEXt / zTXt 文本块 */
export function pngTextChunks(bytes: Uint8Array): Array<{ keyword: string; text: string }> {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('不是有效的 PNG 文件')
  }
  const out: Array<{ keyword: string; text: string }> = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 8
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at)
    const type = latin1(bytes, at + 4, at + 8)
    const dataStart = at + 8
    const dataEnd = dataStart + len
    if (dataEnd + 4 > bytes.length) break // 结构损坏:已收集到的先行返回
    if (type === 'tEXt' || type === 'zTXt') {
      const data = bytes.subarray(dataStart, dataEnd)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = latin1(data, 0, nul)
        try {
          if (type === 'tEXt') {
            out.push({ keyword, text: latin1(data, nul + 1, data.length) })
          } else {
            // zTXt: keyword\0 压缩方法(1 字节,0=zlib/deflate) 压缩文本
            const method = data[nul + 1]
            if (method === 0) {
              const raw = inflate(data.subarray(nul + 2))
              out.push({ keyword, text: latin1(raw, 0, raw.length) })
            }
          }
        } catch {
          // 单块损坏不影响其他块
        }
      }
    }
    if (type === 'IEND') break
    at = dataEnd + 4
  }
  return out
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

/** base64(可含换行/空白)→ JSON 文本 */
function decodeBase64Json(b64: string): string {
  const clean = b64.replace(/\s+/g, '')
  const bin = atob(clean)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytesToUtf8(bytes)
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const asBool = (v: unknown): boolean => v === true

function normalizeLoreEntry(raw: unknown): CardLoreEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const content = asText(e.content)
  if (!content) return null
  const ext = (e.extensions ?? {}) as Record<string, unknown>
  const keys = Array.isArray(e.keys)
    ? e.keys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map((k) => k.trim())
    : typeof e.keys === 'string' && e.keys.trim()
      ? [e.keys.trim()]
      : Array.isArray(e.key)
        ? (e.key as unknown[]).filter((k): k is string => typeof k === 'string')
        : typeof e.key === 'string'
          ? [e.key]
          : []
  return {
    keys,
    content,
    constant: asBool(e.constant) || asBool(ext.constant),
    priority: typeof e.priority === 'number' ? e.priority : typeof e.insertion_order === 'number' ? e.insertion_order : 0,
    enabled: e.enabled !== false,
    ...(typeof e.comment === 'string' && e.comment.trim() ? { comment: e.comment.trim().slice(0, 60) } : {}),
  }
}

function normalizeCard(json: unknown): RawCard | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  const spec = o.spec
  // v2/v3:字段在 data 下;平铺 v1:字段就在根上
  const d = (spec === 'chara_card_v2' || spec === 'chara_card_v3' ? o.data : o) as Record<string, unknown> | undefined
  if (!d || typeof d !== 'object') return null
  const name = asText(d.name)
  if (!name) return null
  const book = d.character_book
  const loreBook =
    book && typeof book === 'object' && Array.isArray((book as Record<string, unknown>).entries)
      ? ((book as Record<string, unknown>).entries as unknown[])
          .map(normalizeLoreEntry)
          .filter((e): e is CardLoreEntry => e !== null)
      : undefined
  return {
    spec: spec === 'chara_card_v3' ? 'chara_card_v3' : spec === 'chara_card_v2' ? 'chara_card_v2' : 'v1',
    name,
    description: asText(d.description),
    personality: asText(d.personality),
    scenario: asText(d.scenario),
    firstMes: asText(d.first_mes),
    mesExample: asText(d.mes_example),
    alternateGreetings: Array.isArray(d.alternate_greetings)
      ? d.alternate_greetings.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map((g) => g.trim())
      : [],
    creatorNotes: asText(d.creator_notes),
    creator: asText(d.creator),
    characterVersion: asText(d.character_version),
    tags: Array.isArray(d.tags) ? d.tags.filter((t): t is string => typeof t === 'string').slice(0, 30) : [],
    ...(loreBook && loreBook.length > 0 ? { loreBook } : {}),
  }
}

/** 解析角色卡:PNG 字节或裸 JSON 文本二选一。失败给可读中文错误 */
export function parseCharacterCard(input: { bytes?: Uint8Array; jsonText?: string }): ParseCardResult {
  let jsonText: string
  try {
    if (input.bytes) {
      const chunks = pngTextChunks(input.bytes)
      // ccv3(V3)优先于 chara(V1/V2 通用)——同一张图同时带两块时取新
      const pick = chunks.find((c) => c.keyword === 'ccv3') ?? chunks.find((c) => c.keyword === 'chara')
      if (!pick) return { ok: false, error: 'PNG 中没有角色卡数据(缺少 chara/ccv3 文本块)' }
      jsonText = decodeBase64Json(pick.text)
    } else if (input.jsonText) {
      jsonText = input.jsonText
    } else {
      return { ok: false, error: '没有可解析的内容' }
    }
    const card = normalizeCard(JSON.parse(jsonText))
    if (!card) return { ok: false, error: '不是有效的角色卡(缺少 name 字段或结构不认识)' }
    return { ok: true, card, sourceJson: jsonText }
  } catch (e) {
    return { ok: false, error: `角色卡解析失败:${String((e as Error)?.message ?? e).slice(0, 120)}` }
  }
}

/** 高频宏替换:{{char}}/<BOT> → 角色名,{{user}}/<USER> → 使用者称呼 */
export function resolveMacros(text: string, ctx: { char: string; user: string }): string {
  return text
    .replace(/\{\{char\}\}/gi, ctx.char)
    .replace(/<BOT>/gi, ctx.char)
    .replace(/\{\{user\}\}/gi, ctx.user)
    .replace(/<USER>/gi, ctx.user)
}
