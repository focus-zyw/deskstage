// list_desktop_files 工具:桌面文件清单(仅元数据,默认开可关)。
// 只拿名称/类型/大小/修改时间——文件名本身可能敏感,设置里有开关;
// 永不读文件内容。摘要人话化:数量 + 最近动过的几件,清单原文进 data。
import { invoke } from '@tauri-apps/api/core'
import { scoreByRules } from '../candidateGate'
import { validateToolInput, type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'

const inputSchema: ToolInputSchema = { properties: {} }

export interface DesktopFileMeta {
  name: string
  isDir?: boolean
  sizeBytes?: number | null
  modifiedMs?: number | null
}

/** 纯函数摘要(单测覆盖):数量概览 + 最近动过的至多 3 件 */
export function summarizeDesktopFiles(files: DesktopFileMeta[]): string {
  if (files.length === 0) return '桌面上一张纸都没有,挺整洁'
  const recent = files.slice(0, 3).map((f) => `「${f.name}」`)
  return `桌面共 ${files.length} 个文件,最近动过的是 ${recent.join('')}`
}

const manifest: ToolManifest = {
  id: 'list_desktop_files',
  label: '看桌面',
  description: '查看桌面上的文件清单(名称/大小/修改时间,不读内容)',
  risk: 'read',
  inputSchema,
  timeoutMs: 8_000,
  defaultEnabled: true,
  match: (text) =>
    scoreByRules(text, [
      { re: /(桌面(上|有)?(什么|哪些)?(文件|东西|图标)|桌面清单|整理桌面)/, weight: 1 },
      { re: /(桌面|desktop)/i, weight: 0.4 },
    ]),
  presentation: { actor: 'C', pendingText: '我看看桌面…', action: 'thinking' },
}

export const listDesktopFilesTool: CharacterTool = {
  manifest,
  available: () => true,
  validate: (input) => validateToolInput(inputSchema, input),
  async execute(_input) {
    const files = await invoke<DesktopFileMeta[]>('desktop_files_list')
    return { ok: true, summary: summarizeDesktopFiles(files), data: { files } }
  },
}
