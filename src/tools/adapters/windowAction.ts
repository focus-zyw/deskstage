// window_action 工具:窗口管理(external,需确认)。
// minimize_others = 把其他窗口全部最小化(整理桌面/保护隐私的常见诉求);
// minimize_app / focus_app = 按进程名找回或收起某个应用(如"把微信收起来")。
import { invoke } from '@tauri-apps/api/core'
import { scoreByRules } from '../candidateGate'
import { validateToolInput, type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'

const ACTIONS = ['minimize_others', 'minimize_app', 'focus_app'] as const

const inputSchema: ToolInputSchema = {
  properties: {
    action: { type: 'string', enum: [...ACTIONS], description: 'minimize_others=最小化其他窗口,minimize_app=收起指定应用,focus_app=把指定应用调到前台' },
    target: { type: 'string', maxLength: 100, description: '目标程序名(如 wechat / notepad;minimize_others 不需要)' },
  },
  required: ['action'],
}

const manifest: ToolManifest = {
  id: 'window_action',
  label: '窗口管理',
  description: '最小化其他窗口,或按程序名收起/调前某个应用窗口',
  risk: 'external',
  inputSchema,
  timeoutMs: 10_000,
  defaultEnabled: false,
  match: (text) =>
    scoreByRules(text, [
      { re: /(最小化(其他|所有|全部|别的)?(窗口)?|窗口(整理|全收|收起来)|别偷看)/, weight: 0.95 },
      { re: /(把|将).{1,12}(窗口|微信|QQ|浏览器).{0,6}(调到前台|切到前面|收到|最小化|找回来)/, weight: 0.9 },
      { re: /窗口/, weight: 0.4 },
    ]),
  presentation: { actor: 'C', pendingText: '我来整理窗口…', action: 'thinking' },
}

export const windowActionTool: CharacterTool = {
  manifest,
  available: () => true,
  validate: (input) => {
    const v = validateToolInput(inputSchema, input)
    if (!v.ok) return v
    const action = String(v.value.action)
    const target = v.value.target
    if (action === 'minimize_others' && target !== undefined) {
      return { ok: false, reason: 'minimize_others 不需要目标' }
    }
    if (action !== 'minimize_others' && typeof target !== 'string') {
      return { ok: false, reason: '该动作需要提供目标程序名' }
    }
    return v
  },
  async execute(input) {
    const { action, target } = input as { action: string; target?: string }
    await invoke('window_action', { action, target })
    const label =
      action === 'minimize_others'
        ? '已把其他窗口都最小化'
        : action === 'minimize_app'
          ? '已把目标窗口收起来'
          : '已把目标窗口调到前台'
    return { ok: true, summary: label }
  },
}
