// 决策协议解析(纯函数):模型原始输出 → ToolDecision,解析纪律从严——
// · 容忍代码围栏与前后说明文字,但只取第一个合法 JSON 对象;
// · 未知工具名一律拒绝:不做字符串相似度"猜测"(把 screen_ocr 猜成 ocr_screen
//   就是让模型用输出改注册表);参数必须是对象;
// · 多余字段视而不见,缺 kind / kind 不认识 / 结构不对 → null(调用方回落普通聊天,
//   不重试——网页通道一次 CDP 很贵,错了就当模型说"不用工具")。

import type { ToolDecision } from '../types'

export function parseToolDecision(raw: string, validTools: ReadonlySet<string>): ToolDecision | null {
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
  if (o.kind === 'none') return { kind: 'none' }
  if (o.kind === 'clarify') {
    const q = typeof o.question === 'string' ? o.question.trim().slice(0, 200) : ''
    return q ? { kind: 'clarify', question: q } : null
  }
  if (o.kind === 'call') {
    if (typeof o.tool !== 'string' || !validTools.has(o.tool)) return null
    if (typeof o.arguments !== 'object' || o.arguments === null || Array.isArray(o.arguments)) return null
    return { kind: 'call', tool: o.tool, arguments: o.arguments as Record<string, unknown> }
  }
  return null
}
