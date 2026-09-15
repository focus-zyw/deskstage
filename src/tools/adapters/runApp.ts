// run_app 工具:启动 .exe 应用(external,需确认;比 open_target 更重的一把钥匙)。
import { invoke } from '@tauri-apps/api/core'
import { scoreByRules } from '../candidateGate'
import { type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'
import { validateRunAppInput } from './desktopCommon'

const inputSchema: ToolInputSchema = {
  properties: {
    target: { type: 'string', maxLength: 1024, description: '.exe 绝对路径或系统可解析的程序名(如 notepad.exe)' },
  },
  required: ['target'],
}

const manifest: ToolManifest = {
  id: 'run_app',
  label: '启动应用',
  description: '启动一个 .exe 应用程序(需要完整路径或系统程序名)',
  risk: 'external',
  inputSchema,
  timeoutMs: 15_000,
  defaultEnabled: false,
  match: (text) =>
    scoreByRules(text, [
      { re: /(启动|运行|开)(一下)?(一个)?(应用|程序|软件|记事本|计算器|游戏)/, weight: 0.95 },
      { re: /(launch|run)\s+\S+\.exe/i, weight: 0.95 },
      { re: /打开.*(应用|程序|软件)/, weight: 0.85 },
    ]),
  presentation: { actor: 'C', pendingText: '我来启动…', action: 'thinking' },
}

export const runAppTool: CharacterTool = {
  manifest,
  available: () => true,
  validate: (input) => validateRunAppInput(inputSchema, input),
  async execute(input) {
    const target = String((input as { target: string }).target)
    await invoke('system_run_app', { target })
    return { ok: true, summary: '已启动应用' }
  },
}
