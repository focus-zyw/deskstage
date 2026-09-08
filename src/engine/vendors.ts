// 厂商预设:OpenAI 兼容端点。设置面板的厂商下拉只是"填表助手"——
// 选中即带出 baseUrl 与默认模型;apiKey/baseUrl/model 仍是配置的唯一事实源。
// 本地/自定义(如 Ollama)无预设,接口地址与模型自由填写。

export interface VendorPreset {
  id: string
  label: string
  baseUrl: string
  models: string[]
}

export const VENDORS: VendorPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-8k'],
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
  },
  {
    id: 'doubao',
    label: '豆包(火山引擎)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k-250115', 'doubao-1-5-lite-32k-250115'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
  },
]

/** 自定义选项(本地/其他 OpenAI 兼容端点) */
export const CUSTOM_VENDOR_ID = 'custom'

/** 按当前 baseUrl 反查预设厂商 id,匹配不上即自定义 */
export function vendorIdOfBaseUrl(baseUrl: string): string {
  return VENDORS.find((v) => v.baseUrl === baseUrl)?.id ?? CUSTOM_VENDOR_ID
}
