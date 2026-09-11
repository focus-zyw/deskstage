// 模式工坊的 AI 生成:自然语言需求 → 一份 DialogMode 数据(模式即数据)。
// 走与对话相同的 LLM 通道;输出必须过 sanitizeCustomMode 校验清洗,
// 生成失败或格式不合法抛错,由 UI 回落手填表单,绝不静默存坏数据。
import { complete } from './llmGateway'
import { VALID_ACTIONS } from '../performer/dialogSchema'
import { MODES, type DialogMode } from '../performer/modes'
import { sanitizeCustomMode } from '../storage/customModesStore'

/** 内置模式摘录作 few-shot:只取轻量字段,剧本截两句示例省 token */
function fewShotExcerpt(mode: DialogMode): Record<string, unknown> {
  return {
    id: mode.id,
    label: mode.label,
    accent: mode.accent,
    gap: mode.gap,
    prompt: mode.prompt,
    interestTopicChance: mode.interestTopicChance,
    triggers: mode.triggers,
    script_sample: mode.script.slice(0, 2),
  }
}

function buildSystemPrompt(): string {
  const actions = [...VALID_ACTIONS].join('、')
  return [
    '你是桌面虚拟角色的"模式编剧"。根据用户需求,设计一个新的演出模式(类似相声、日常闲聊那种可点播的对话风格)。',
    '只输出一个 JSON 对象,不要解释、不要代码围栏,字段如下:',
    '{',
    '  "id": "custom_"开头的小写英文/数字(如 custom_roast,用于存储,勿用中文),',
    '  "label": "模式名,2~6个汉字,显示在按钮上",',
    '  "accent": "#十六进制颜色,与日常/相声区分开",',
    '  "gap": 台词间奏毫秒数(200~600,快嘴互怼小、慢节奏大),',
    '  "prompt": "该模式的编剧指令:角色关系、话语结构、包袱/收尾方式,150字内",',
    '  "script": [兜底剧本,A/B 交替 4~8 句,每句 {"speaker":"A|B","text":"台词","action":"动作词"},最后一句带 "pauseAfter":1200 留白],',
    `  "interestTopicChance": 0~1 小数(该模式聊到使用者兴趣的概率,闲聊类高、结构化类低),`,
    '  "triggers": ["自然语言点播触发词,1~3个中文词,第一个必须是 label"]',
    '}',
    `action 只能取这些词:${actions}。`,
    '示例(仅供参考结构):',
    JSON.stringify(fewShotExcerpt(MODES.daily)),
    JSON.stringify(fewShotExcerpt(MODES.crosstalk)),
  ].join('\n')
}

/** 从 LLM 原始输出里抠 JSON(容忍代码围栏与混杂文本) */
function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('输出中找不到 JSON')
    return JSON.parse(m[0]) as Record<string, unknown>
  }
}

/** 生成一个自定义模式:成功返回已校验的数据;LLM 出错或格式不合法抛 Error */
export async function generateCustomMode(
  requirement: string,
  deps: { complete: typeof complete } = { complete },
): Promise<DialogMode> {
  const req = requirement.trim()
  if (!req) throw new Error('请先描述你想要的模式')
  let raw: string
  try {
    raw = await deps.complete({
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: req },
      ],
      temperature: 0.8,
      maxTokens: 1500,
      jsonMode: true,
      timeoutMs: 60_000,
    })
  } catch (e) {
    throw new Error(`AI 调用失败:${String((e as Error)?.message ?? e).slice(0, 80)}`)
  }
  const mode = sanitizeCustomMode(parseJsonObject(raw))
  if (!mode) throw new Error('AI 生成的模式缺关键字段(id/label/prompt/剧本),可重试或手填')
  return mode
}
