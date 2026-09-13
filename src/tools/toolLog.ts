// 工具调用日志:内存环 50 条(cspMonitor MAX_REPORTS 同款纪律),不落盘不遥测。
// 用途:排障与"角色刚才干了什么"的可回忆性;设置页将来可加只读查看。
// 脱敏纪律:detail 只放适配器给的 summary 截断——密钥/Cookie/完整 URL 在适配器层
// 就不允许出现在 summary 里,这里再兜底截断一次。

import type { ToolLogEntry } from './types'

export const TOOL_LOG_LIMIT = 50

let ring: ToolLogEntry[] = []

export function recordToolLog(entry: ToolLogEntry): void {
  ring = [...ring.slice(-(TOOL_LOG_LIMIT - 1)), { ...entry, detail: entry.detail.slice(0, 120) }]
}

export function getToolLogs(): ToolLogEntry[] {
  return [...ring]
}

/** 测试与设置页"清除记录"用 */
export function clearToolLogs(): void {
  ring = []
}
