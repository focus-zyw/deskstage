// 翻译深模块:对外只有一个 translate()。UI/OCR/快捷键不接触提示词、
// JSON 解析与模型参数;稳定性参数与创作通道隔离(低温、30s、json_mode)。
import { complete } from '../engine/llmGateway'
import { describeLlmError } from '../engine/llmClient'
import { buildTranslationMessages } from './prompt'
import type { TranslationRequest, TranslationResult } from './types'

/** 单次输入上限(超出在 UI 层截断) */
export const MAX_INPUT_CHARS = 6000
/** 超过此长度按段落切块翻译,防止单次输出 token 不够导致译文被截断 */
const SEGMENT_CHARS = 2800

const TRANSLATE_PARAMS = {
  temperature: 0.2,
  maxTokens: 3000,
  timeoutMs: 30_000,
}

/** 请求一次翻译(单块)。端点不支持 response_format(400)时去掉 json_mode 重试一次 */
async function translateChunk(
  text: string,
  req: TranslationRequest,
  signal?: AbortSignal,
): Promise<TranslationResult> {
  const messages = buildTranslationMessages({ ...req, text })
  let raw: string
  try {
    raw = await complete({ messages, jsonMode: true, ...TRANSLATE_PARAMS, signal })
  } catch (e) {
    if ((e as { status?: number }).status !== 400) throw e
    raw = await complete({ messages, jsonMode: false, ...TRANSLATE_PARAMS, signal })
  }
  return parseTranslation(raw, req)
}

/** 容忍围栏/混杂文本,取出规定的 JSON 并逐字段校验钳位 */
function parseTranslation(raw: string, req: TranslationRequest): TranslationResult {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('模型未返回规定的 JSON')
  const obj = JSON.parse(m[0]) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  let translation = str(obj.translation) || str(obj.translatedText)
  // 模型偶尔把译文包进引号
  translation = translation.replace(/^["'「『]|["'」』]$/g, '')
  if (!translation) throw new Error('模型未返回译文')
  const list = (v: unknown, cap: number, len: number): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map((x) => x.trim().slice(0, len))
          .slice(0, cap)
      : []
  const detected = str(obj.detectedLanguage).slice(0, 24) ||
    (req.sourceLanguage && req.sourceLanguage !== 'auto' ? req.sourceLanguage : 'auto')
  return {
    detectedLanguage: detected,
    targetLanguage: str(obj.targetLanguage).slice(0, 24) || req.targetLanguage,
    translation: translation.slice(0, 30_000),
    alternatives: list(obj.alternatives, 2, 500),
    notes: list(obj.notes, 3, 200),
  }
}

/** 按段落切块(整行挪动,行内换行结构原样保留);超长单行硬切 */
function splitByParagraphs(text: string, cap: number): string[] {
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? [text]
  const chunks: string[] = []
  let cur = ''
  for (const line of lines) {
    if (line.length > cap) {
      if (cur.trim()) chunks.push(cur)
      cur = ''
      for (let i = 0; i < line.length; i += cap) chunks.push(line.slice(i, i + cap))
      continue
    }
    if (cur.length + line.length > cap && cur.trim()) {
      chunks.push(cur)
      cur = ''
    }
    cur += line
  }
  if (cur.trim()) chunks.push(cur)
  return chunks
}

/**
 * 翻译入口。超长文本按段落切块顺序翻译,拼接时保留段落结构;
 * 某块失败不拖垮整体——失败位置留占位说明,其余块照常返回,重试即整篇重翻。
 */
export async function translate(
  request: TranslationRequest,
  signal?: AbortSignal,
): Promise<TranslationResult> {
  const text = request.text
  if (!text.trim()) throw new Error('没有可翻译的文本')
  if (text.length <= SEGMENT_CHARS) {
    return translateChunk(text, request, signal)
  }
  const chunks = splitByParagraphs(text, SEGMENT_CHARS)
  const parts: string[] = []
  const alternatives: string[] = []
  const notes: string[] = []
  let detected = ''
  for (const chunk of chunks) {
    try {
      const r = await translateChunk(chunk, request, signal)
      parts.push(r.translation)
      if (!detected) detected = r.detectedLanguage
      for (const a of r.alternatives) {
        if (alternatives.length < 2 && !alternatives.includes(a)) alternatives.push(a)
      }
      for (const n of r.notes) {
        if (notes.length < 4 && !notes.includes(n)) notes.push(n)
      }
    } catch (e) {
      if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e
      parts.push(`[本段翻译失败:${await describeLlmError(e)}]`)
    }
  }
  // 块自带段内换行;只在块边界缺失换行时补一个,不叠加空行
  let merged = ''
  for (const p of parts) {
    if (merged && !merged.endsWith('\n') && !p.startsWith('\n')) merged += '\n'
    merged += p
  }
  return {
    detectedLanguage: detected || 'auto',
    targetLanguage: request.targetLanguage,
    translation: merged,
    alternatives,
    notes,
  }
}
