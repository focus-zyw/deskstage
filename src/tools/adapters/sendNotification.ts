// send_notification 工具:系统 toast 通知(external,需确认)。
// 角色气泡是应用内通知;用户在全屏应用里看不到角色,高优提醒改走系统 toast。
import { invoke } from '@tauri-apps/api/core'
import { scoreByRules } from '../candidateGate'
import { validateToolInput, type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'

const inputSchema: ToolInputSchema = {
  properties: {
    title: { type: 'string', maxLength: 60, description: '通知标题(可省略)' },
    body: { type: 'string', maxLength: 160, description: '通知内容' },
  },
  required: ['body'],
}

const manifest: ToolManifest = {
  id: 'send_notification',
  label: '系统通知',
  description: '发一条 Windows 系统通知(toast),适合用户在全屏应用里时的高优提醒',
  risk: 'external',
  inputSchema,
  timeoutMs: 8_000,
  defaultEnabled: false,
  match: (text) =>
    scoreByRules(text, [
      { re: /(系统通知|toast|弹(个|一条)?通知|发(个|一条)?通知)/i, weight: 0.95 },
      { re: /提醒我/, weight: 0.5 }, // 一般"提醒"优先走备忘系统,这里是弱关联
    ]),
  presentation: { actor: 'C', pendingText: '我发条系统通知…', action: 'thinking' },
}

export const sendNotificationTool: CharacterTool = {
  manifest,
  available: () => true,
  validate: (input) => validateToolInput(inputSchema, input),
  async execute(input) {
    const { title, body } = input as { title?: string; body: string }
    await invoke('notify_send', { title, body })
    return { ok: true, summary: '系统通知已发出' }
  },
}
