// Relay 台词解析(纯函数):模型原始输出 → 可上台的一句。
// 解析纪律从严(与工具系统 decisionParse 同款):
// · 容忍代码围栏与前后说明文字,只取第一个合法 JSON 对象;
// · speaker 字段一律忽略——谁发言由本地轮转决定,模型不能指定自己变成谁;
// · action 只认 VALID_ACTIONS 词表,越轨按 talk;
// · intent 只有 'end' 生效,越轨按 continue;
// · 文本截断 80 字:一句口语台词足够,防灌入长文。

import { VALID_ACTIONS } from '../performer/dialogSchema'

export const RELAY_TEXT_MAX = 80

export interface ParsedRelayTurn {
  text: string
  action: string
  intent: 'continue' | 'end'
}

export function parseRelayTurn(raw: string): ParsedRelayTurn | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    try {
      obj = JSON.parse(m[0])
    } catch {
      return null
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text.trim().slice(0, RELAY_TEXT_MAX) : ''
  if (!text) return null
  const action =
    typeof o.action === 'string' && VALID_ACTIONS.has(o.action) ? o.action : 'talk'
  const intent = o.intent === 'end' ? 'end' : 'continue'
  return { text, action, intent }
}

/** 归一化文本(重复检测用):去标点空白、小写——"明显重复"的判定底座 */
export function normalizeRelayText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s,，。、!！?？.。;；~～'"「」『』《》（）()——…·-]/g, '')
}
