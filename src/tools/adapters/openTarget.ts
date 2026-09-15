// open_target 工具:用系统默认方式打开网址/文件/文件夹(external,需确认)。
// 可执行文件在此拒(黑名单见 desktopCommon)——启动应用是另一把更重的钥匙 run_app。
import { invoke } from '@tauri-apps/api/core'
import { scoreByRules } from '../candidateGate'
import { type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'
import { validateOpenInput } from './desktopCommon'

const inputSchema: ToolInputSchema = {
  properties: {
    kind: { type: 'string', enum: ['url', 'path'], description: 'url=网址,path=文件或文件夹路径' },
    target: { type: 'string', maxLength: 2048, description: '网址或完整路径' },
  },
  required: ['kind', 'target'],
}

const manifest: ToolManifest = {
  id: 'open_target',
  label: '打开',
  description: '用系统默认方式打开网址或文件/文件夹(可执行文件除外)',
  risk: 'external',
  inputSchema,
  timeoutMs: 15_000,
  defaultEnabled: false,
  match: (text) =>
    scoreByRules(text, [
      { re: /(打开|开一下|帮我开)(一下)?(这个|那个|一个)?(网址|网页|链接|网站)/, weight: 0.95 },
      { re: /(打开|开一下)(一下)?(这个|那个|一个)?(文件|文件夹|目录|路径)/, weight: 0.95 },
      { re: /打开/, weight: 0.5 },
    ]),
  presentation: { actor: 'C', pendingText: '我来打开…', action: 'thinking' },
}

export const openTargetTool: CharacterTool = {
  manifest,
  available: () => true,
  validate: (input) => validateOpenInput(inputSchema, input),
  async execute(input) {
    const { kind, target } = input as { kind: string; target: string }
    await invoke('system_open', { kind, target })
    return { ok: true, summary: kind === 'url' ? '已用浏览器打开网址' : '已用系统默认方式打开' }
  },
}
