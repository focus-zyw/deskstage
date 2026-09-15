// 确定性操作工具(阶段3)· 共享校验(纯函数,单测覆盖)。
// 这里是第一道白名单闸:可执行扩展/非 http(s) 网址在这里就拒;
// Rust 侧 desktop_ops.rs 有独立的第二道硬校验,两层规则刻意保持一致。
import { validateToolInput, type ToolInputSchema } from '../schema'

export const OPEN_BLOCKED_EXTS = [
  'exe', 'bat', 'cmd', 'com', 'pif', 'scr', 'ps1', 'psm1', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'hta', 'msi', 'msp', 'mst', 'jar', 'apk', 'reg',
]

export type OpenCheck =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string }

/** open_target 的参数校验:网址仅 http/https,路径拒可执行扩展(启动应用请走 run_app) */
export function validateOpenInput(schema: ToolInputSchema, input: unknown): OpenCheck {
  const v = validateToolInput(schema, input)
  if (!v.ok) return v
  const kind = String(v.value.kind ?? '')
  const target = String(v.value.target ?? '')
  if (kind === 'url') {
    if (!(target.startsWith('http://') || target.startsWith('https://'))) {
      return { ok: false, reason: '网址只支持 http/https' }
    }
  } else if (kind === 'path') {
    const ext = target.includes('.') ? (target.split('.').pop() ?? '').toLowerCase() : ''
    if (OPEN_BLOCKED_EXTS.includes(ext)) {
      return { ok: false, reason: '可执行文件请用「启动应用」(需要确认)' }
    }
  } else {
    return { ok: false, reason: `未知类型:${kind}` }
  }
  return { ok: true, value: { kind, target } }
}

/** run_app 的参数校验:仅 .exe(绝对路径或系统可解析的程序名) */
export function validateRunAppInput(schema: ToolInputSchema, input: unknown): OpenCheck {
  const v = validateToolInput(schema, input)
  if (!v.ok) return v
  const target = String(v.value.target ?? '')
  const lower = target.toLowerCase()
  const bare = !lower.includes('\\') && !lower.includes('/')
  const legalChar = /^[\w.\- ]+\.exe$/.test(lower)
  const isBare = bare && legalChar
  const isPath = !bare && lower.endsWith('.exe')
  if (!isBare && !isPath) {
    return { ok: false, reason: '只支持启动 .exe 程序(绝对路径或系统可解析的程序名)' }
  }
  return { ok: true, value: { target } }
}

/** 音量参数校验:level 0~100;mute 与 level 至少给一个 */
export function validateVolumeInput(input: unknown): OpenCheck {
  const v = input as { level?: unknown; mute?: unknown } | null
  const level = typeof v?.level === 'number' ? v.level : undefined
  const mute = typeof v?.mute === 'boolean' ? v.mute : undefined
  if (level === undefined && mute === undefined) {
    return { ok: false, reason: '至少提供 level 或 mute 之一' }
  }
  if (level !== undefined && !(level >= 0 && level <= 100 && Number.isFinite(level))) {
    return { ok: false, reason: '音量要在 0~100 之间' }
  }
  return { ok: true, value: { ...(level !== undefined ? { level } : {}), ...(mute !== undefined ? { mute } : {}) } }
}
