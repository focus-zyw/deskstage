// 气泡工坊的 AI 生成:自然语言风格需求 → 一套气泡主题数据(BubbleTheme 纯数据)。
// 走与对话相同的 LLM 通道;输出必须过 sanitizeBubbleTheme 校验清洗,
// 生成失败或格式不合法抛错,由 UI 回落手填表单,绝不静默存坏数据。
import { complete } from './llmGateway'
import { sanitizeBubbleTheme, type BubbleTheme } from '../storage/bubbleThemesStore'

/** 内置两套主题作 few-shot(结构与取值范围的活例子,省得模型瞎编字段) */
const FEW_SHOT = [
  {
    label: '柔彩',
    bg: '#faf7f2', text: '#26232f', stroke: '#92887e',
    accA: '#e98050', accB: '#5f86da', accC: '#8572d8',
    bgA: '#fff4eb', bgB: '#edf5ff', bgC: '#f5f0ff',
    strokeA: '#dd8b62', strokeB: '#688fd5', strokeC: '#8974d0',
    bgOpacity: 0.93, strokeW: 1, blurPx: 0, fontSize: 16, maxWidth: 320, radius: 18,
    shape: 'rounded', tailStyle: 'droplet', shadow: 'soft',
    fontWeight: 650, lineHeight: 1.58, paddingX: 17, paddingY: 15,
  },
  {
    label: '夜色玻璃',
    bg: '#1b1e2f', text: '#f2f4ff', stroke: '#a399d5',
    accA: '#ffb066', accB: '#7db3ff', accC: '#a89bff',
    bgA: '#302328', bgB: '#1b2740', bgC: '#2b2343',
    strokeA: '#ffb066', strokeB: '#7db3ff', strokeC: '#a89bff',
    bgOpacity: 0.88, strokeW: 1, blurPx: 14, fontSize: 16, maxWidth: 320, radius: 18,
    shape: 'rounded', tailStyle: 'sharp', shadow: 'strong',
    fontWeight: 650, lineHeight: 1.58, paddingX: 17, paddingY: 15,
  },
]

function buildSystemPrompt(): string {
  return [
    '你是桌面虚拟角色的"气泡美术师"。根据用户描述,设计一套台词气泡的视觉主题。',
    '只输出一个 JSON 对象,不要解释、不要代码围栏,字段与取值要求:',
    '{',
    '  "label": "主题名,2~6个汉字",',
    '  "bg": "#RRGGBB 气泡通用底色", "text": "#RRGGBB 台词文字色", "stroke": "#RRGGBB 描边色",',
    '  "accA": "#RRGGBB 角色A名签强调色", "accB": "…B…", "accC": "…C…",',
    '  "bgA": "#RRGGBB 角色A底色(带角色色偏的浅色)", "bgB": "…", "bgC": "…",',
    '  "strokeA": "#RRGGBB 角色A描边", "strokeB": "…", "strokeC": "…",',
    '  "bgOpacity": 0.5~1 的底色不透明度(玻璃风低些,纸面风高些),',
    '  "strokeW": 1~3 描边宽px, "blurPx": 0~24 背景模糊px(0=无,玻璃风14左右),',
    '  "fontSize": 12~22 台词基准字号, "maxWidth": 240~480 最大宽度px, "radius": 6~28 圆角px',
    '  "shape": "rounded|pill|square|cloud 之一(柔和/胶囊/方角/云朵轮廓)",',
    '  "tailStyle": "droplet|sharp|round|none 之一(水滴/尖角/圆泡/隐藏)",',
    '  "shadow": "none|soft|strong 之一, "fontWeight": 400~800 字重,',
    '  "lineHeight": 1.2~1.9 行高, "paddingX": 10~28 左右留白px, "paddingY": 10~28 上下留白px',
    '}',
    '所有颜色一律 #RRGGBB 六位十六进制。三个角色的底色/名签色要有可辨识的区分(参考示例的思路:各自取主题色系)。深色底配浅色字,浅色底配深色字,保证可读。',
    '示例(仅供参考结构与取值范围):',
    JSON.stringify(FEW_SHOT[0]),
    JSON.stringify(FEW_SHOT[1]),
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

/** 生成一套气泡主题(不含 id,由调用方补);LLM 出错或格式不合法抛 Error */
export async function generateBubbleTheme(
  requirement: string,
  deps: { complete: typeof complete } = { complete },
): Promise<Omit<BubbleTheme, 'id'>> {
  const req = requirement.trim()
  if (!req) throw new Error('请先描述你想要的风格')
  let raw: string
  try {
    raw = await deps.complete({
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: req },
      ],
      temperature: 0.8,
      maxTokens: 900,
      jsonMode: true,
      timeoutMs: 60_000,
    })
  } catch (e) {
    throw new Error(`AI 调用失败:${String((e as Error)?.message ?? e).slice(0, 80)}`)
  }
  const o = parseJsonObject(raw)
  const theme = sanitizeBubbleTheme({ ...o, id: 'custom_preview' })
  if (!theme) throw new Error('AI 生成的主题缺关键字段(label/颜色),可重试或手填')
  const { id: _id, ...rest } = theme
  return rest
}
