// 提取文字:配置了视觉模型(默认智谱 glm-4.6v-flash,免费)时走 AI 识别,
// 失败或未配置自动回退本地 Windows OCR。原图由 Rust 从剪贴板读出并编码 PNG base64,
// 经 OpenAI 兼容的多模态消息发给视觉模型。为什么要 AI:手写/艺术字/表格/复杂排版
// 是本地引擎的盲区,且智谱免费档对个人使用零成本。
import { invoke } from '@tauri-apps/api/core'
import { complete } from '../engine/llmGateway'
import { describeLlmError } from '../engine/llmClient'
import { getConfig, type OcrConfig } from '../storage/configStore'

/** 稳定性参数:低温;免费档并发低,超时给短些(25s)——卡死了尽快落回本地识别 */
const OCR_PARAMS = {
  temperature: 0.1,
  maxTokens: 3000,
  timeoutMs: 25_000,
}

const OCR_PROMPT = [
  '识别图片中的全部文字,只输出文字本身:',
  '- 按阅读顺序输出,保留原有换行',
  '- 表格按行输出,单元格之间用" | "分隔',
  '- 不要翻译、不要解释、不要输出图片之外的内容',
  '- 图中没有文字时只输出:(无文字)',
].join('\n')

export interface ExtractResult {
  lines: string[]
  /** 结果来源:api = 视觉模型,local = 本地 Windows OCR(卡片提示与排障用) */
  via: 'api' | 'local'
}

/** 提取文字入口:AI 优先,本地兜底。report 用于更新任务卡的进度提示。
 *  本地识别的空结果/无图错误由 Rust 侧直接抛出,保持原有提示文案 */
export async function extractTextFromClipboard(report: (s: string) => void): Promise<ExtractResult> {
  const { ocr } = await getConfig()
  if (ocr.apiKey && ocr.baseUrl && ocr.model) {
    try {
      report('AI 识别剪贴板图片中…')
      const lines = await apiOcrLines(ocr)
      if (lines.length > 0) return { lines, via: 'api' }
      throw new Error('AI 没识别出文字')
    } catch (e) {
      // 中止场景不存在(任务卡不支持取消);其余一律回落本地,原因缩短后上卡
      const reason = await describeLlmError(e)
      report(`AI 识别不可用(${reason.slice(0, 60)}),改用本地识别…`)
    }
  } else {
    report('本地识别剪贴板图片中…')
  }
  const r = await invoke<{ lines: string[]; lang: string }>('ocr_clipboard')
  return { lines: r.lines, via: 'local' }
}

async function apiOcrLines(ocr: OcrConfig): Promise<string[]> {
  const b64 = await invoke<string>('clipboard_image_base64')
  const text = await complete({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: OCR_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
    baseUrl: ocr.baseUrl,
    apiKey: ocr.apiKey,
    model: ocr.model,
    jsonMode: false, // 要纯文本,不要 response_format(免费视觉模型可能不支持)
    ...OCR_PARAMS,
  })
  return text
    .split(/\r?\n/)
    .map((l) => squeezeCjkSpaces(l.trim()))
    .filter((l) => l.length > 0 && l !== '(无文字)')
}

// 与 Rust 侧 is_cjk/squeeze_cjk_spaces 同规则(本地产物已压缩过,这里只管 AI 输出;
// 两侧幂等,重复执行无害):连续空白先收成一个空格,再删掉两侧都是 CJK 的那个空格
function squeezeCjkSpaces(line: string): string {
  const cjk = '\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef'
  return line
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`(?<=[${cjk}]) (?=[${cjk}])`, 'g'), '')
}
