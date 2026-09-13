// recognize_text 工具:屏幕/剪贴板图片识字(read 级)。
// 复用 translation/ocr.ts 的整条识别链(AI 视觉优先 + 本地 OCR 兜底 + 熔断),
// 工具层只决定"字从哪来":source=screen 先走全屏截屏链,clipboard 直接读剪贴板。
import { extractTextFromClipboard } from '../../translation/ocr'
import { captureFullScreenToClipboard } from './captureCommon'
import { scoreByRules } from '../candidateGate'
import { validateToolInput, type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'

const inputSchema: ToolInputSchema = {
  properties: {
    source: { type: 'string', enum: ['screen', 'clipboard'], description: '文字来源,缺省 screen' },
  },
}

const manifest: ToolManifest = {
  id: 'recognize_text',
  label: '识字',
  description: '识别屏幕或剪贴板图片里的文字(AI 视觉优先,本地 OCR 兜底)',
  risk: 'read',
  inputSchema,
  timeoutMs: 60_000, // AI 25s 超时 + 本地兜底 + 可能的截屏链,留足余量
  defaultEnabled: true,
  match: (text) =>
    scoreByRules(text, [
      { re: /(识字|文字识别|识别文字|提取文字|ocr)/i, weight: 0.95 },
      { re: /(写的?什么|写了些?什么|报错|屏幕上的字|念念|读一下|看一下.{0,8}(字|内容|代码)|看看.{0,8}(字|内容|代码))/, weight: 0.85 },
      { re: /(剪贴板)/, weight: 0.6 },
    ]),
  presentation: { actor: 'C', pendingText: '我认一下字…', action: 'thinking' },
}

export const recognizeTextTool: CharacterTool = {
  manifest,
  available: () => true,
  validate: (input) => validateToolInput(inputSchema, input),
  async execute(input, ctx) {
    const v = validateToolInput(inputSchema, input)
    if (!v.ok) return { ok: false, summary: v.reason, errorCode: 'invalid' }
    if ((v.value.source ?? 'screen') === 'screen') {
      await captureFullScreenToClipboard(ctx.report)
    }
    const r = await extractTextFromClipboard((s) => ctx.report?.(s))
    if (r.lines.length === 0) return { ok: true, summary: '没有识别出文字', data: r }
    return {
      ok: true,
      summary: `识别到文字(${r.via === 'api' ? 'AI' : '本地'}):\n${r.lines.join('\n')}`,
      data: { lines: r.lines, via: r.via },
    }
  },
}
