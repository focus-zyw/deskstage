// read_clipboard 工具:读取剪贴板文本(pull 制,默认关)。
// 为什么 defaultEnabled: false 且永不进世界状态轮询:密码/验证码常躺在剪贴板里,
// 环境式读取风险不成比例——只在用户明确说"看看我复制的"时按需读一次,
// 摘要预览截断(防灌入),完整内容进 data 供当轮深用、不落盘。
import { invoke } from '@tauri-apps/api/core'
import { scoreByRules } from '../candidateGate'
import { validateToolInput, type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'

const inputSchema: ToolInputSchema = { properties: {} }

const PREVIEW_CHARS = 120

const manifest: ToolManifest = {
  id: 'read_clipboard',
  label: '读剪贴板',
  description: '读取剪贴板里的文字(只在用户要求时读取一次)',
  risk: 'read',
  inputSchema,
  timeoutMs: 5_000,
  defaultEnabled: false,
  match: (text) =>
    scoreByRules(text, [
      { re: /(剪贴板|粘贴板|clipboard)/i, weight: 1 },
      { re: /(我复制的|复制的东西|复制的内容|刚复制的)/i, weight: 0.95 },
    ]),
  presentation: { actor: 'C', pendingText: '我看看剪贴板…', action: 'thinking' },
}

export const readClipboardTool: CharacterTool = {
  manifest,
  available: () => true,
  validate: (input) => validateToolInput(inputSchema, input),
  async execute(_input) {
    const text = await invoke<string>('clipboard_read_text').catch(() => '')
    const trimmed = text.trim()
    if (!trimmed) return { ok: true, summary: '剪贴板里没有文字' }
    const preview = trimmed.slice(0, PREVIEW_CHARS)
    return {
      ok: true,
      summary: `剪贴板里有 ${trimmed.length} 个字:「${preview}${trimmed.length > PREVIEW_CHARS ? '…' : ''}」`,
      data: { text: trimmed },
    }
  },
}
