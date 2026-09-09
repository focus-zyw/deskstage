// 翻译模块的对外类型与语言表:UI、OCR 链路、未来划词快捷键都只依赖这里。

export type TranslationStyle = 'natural' | 'literal' | 'polished'

export interface TranslationRequest {
  text: string
  /** 源语言代码;'auto' = 自动检测,缺省亦为 auto */
  sourceLanguage?: string
  /** 目标语言代码(如 zh-CN) */
  targetLanguage: string
  style: TranslationStyle
  /** 保留换行/列表/段落结构;缺省 true */
  preserveFormat?: boolean
}

export interface TranslationResult {
  detectedLanguage: string
  targetLanguage: string
  translation: string
  alternatives: string[]
  notes: string[]
}

/** 首批支持的语言:code 为发给模型的稳定标识,label 为界面中文名 */
export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-Hant', label: '繁体中文' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'ru', label: '俄语' },
]

export const STYLE_LABEL: Record<TranslationStyle, string> = {
  natural: '自然翻译',
  literal: '直译',
  polished: '润色',
}

/** 语言代码 → 中文名;未识别的代码原样展示 */
export function langLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code
}
