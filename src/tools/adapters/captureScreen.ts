// capture_screen 工具:全屏截取进剪贴板(read 级,自动执行)。
import { captureFullScreenToClipboard } from './captureCommon'
import { scoreByRules } from '../candidateGate'
import { validateToolInput, type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'

const inputSchema: ToolInputSchema = { properties: {} }

const manifest: ToolManifest = {
  id: 'capture_screen',
  label: '截屏',
  description: '截取当前屏幕画面(全屏)并复制到剪贴板',
  risk: 'read',
  inputSchema,
  timeoutMs: 15_000,
  defaultEnabled: true,
  match: (text) =>
    scoreByRules(text, [
      { re: /(截屏|截图|截个图|截个屏|抓屏|拍屏|截取屏幕|截一下屏幕)/, weight: 1 },
      { re: /(屏幕|桌面画面|屏幕画面)/, weight: 0.5 },
    ]),
  presentation: { actor: 'C', pendingText: '我看一下屏幕…', action: 'thinking' },
}

export const captureScreenTool: CharacterTool = {
  manifest,
  available: (ctx) => ctx.facts.phase !== 'performing', // 演出播放中不打断(冻结屏会带走字幕气泡)
  validate: (input) => validateToolInput(inputSchema, input),
  async execute(_input, ctx) {
    await captureFullScreenToClipboard(ctx.report)
    return { ok: true, summary: '已截取全屏画面并复制到剪贴板' }
  },
}
