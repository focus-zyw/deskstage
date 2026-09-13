// 工具输入的最小 schema 与白名单式清洗(纯函数)。
// 为什么不用 JSON Schema 库:工具输入都很小(一两句话/一个枚举),全量 spec 是浅接口;
// 这里只保留"类型 + 必填 + 枚举 + 截断"四个决策点,validate 的输出直接就是可执行参数。
// 清洗纪律(与 endpoint_proxy 的硬化思路一致):未知键丢弃、字符串超长截断、
// 类型不对就拒绝——绝不按相似度"猜"模型本来想填什么。

export interface ToolInputField {
  type: 'string' | 'number' | 'boolean'
  /** 参数含义(决策 prompt 的参数提示;给模型看,也给确认卡拼 detail) */
  description?: string
  /** 字符串最长长度;超长静默截断(防灌入,不因长度拒绝明确意图)。缺省 200 */
  maxLength?: number
  /** 枚举白名单;不在表内 = 拒绝 */
  enum?: string[]
}

export interface ToolInputSchema {
  properties: Record<string, ToolInputField>
  required?: string[]
}

export type ToolValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string }

export const DEFAULT_STRING_MAX = 200

export function validateToolInput(schema: ToolInputSchema, input: unknown): ToolValidation {
  if (input === undefined || input === null) input = {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: '参数必须是对象' }
  }
  const raw = input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of schema.required ?? []) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') {
      return { ok: false, reason: `缺少参数 ${key}` }
    }
  }
  for (const [key, field] of Object.entries(schema.properties)) {
    const v = raw[key]
    if (v === undefined || v === null || v === '') continue
    if (field.type === 'string') {
      if (typeof v !== 'string') return { ok: false, reason: `参数 ${key} 应为字符串` }
      const cap = field.maxLength ?? DEFAULT_STRING_MAX
      out[key] = v.slice(0, cap)
    } else if (field.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, reason: `参数 ${key} 应为数字` }
      out[key] = v
    } else {
      if (typeof v !== 'boolean') return { ok: false, reason: `参数 ${key} 应为布尔` }
      out[key] = v
    }
    if (field.enum && !field.enum.includes(String(out[key]))) {
      return { ok: false, reason: `参数 ${key} 只能是:${field.enum.join('/')}` }
    }
  }
  return { ok: true, value: out }
}

/** 渲染决策 prompt 的参数提示行:"text(必填,≤30字):要发送的内容" */
export function describeSchema(schema: ToolInputSchema): string {
  const rows = Object.entries(schema.properties).map(([key, f]) => {
    const bits: string[] = [f.type]
    if ((schema.required ?? []).includes(key)) bits.push('必填')
    if (f.type === 'string') bits.push(`≤${f.maxLength ?? DEFAULT_STRING_MAX}字`)
    if (f.enum) bits.push(`可选:${f.enum.join('/')}`)
    return `${key}(${bits.join(',')})${f.description ? `:${f.description}` : ''}`
  })
  return rows.length > 0 ? rows.join(';') : '无参数'
}
