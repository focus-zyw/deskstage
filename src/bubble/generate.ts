// AI 生成:自然语言需求 → 三个设计意图(受约束的槽位制)→ 引擎编译成完整 V2 主题。
// LLM 只产出设计决策(模板/材质/气质/主色),不再自由生成几十个 CSS 参数;
// 槽位制保证三候选方向性差异(忠实/表现/克制),程序只做兼容修正与补位,不随机换模板。
import { complete, type CompletionOptions } from '../engine/llmGateway'
import { BUBBLE_MATERIAL_DEFAULTS, BUBBLE_TEMPLATES, compatibleMaterial } from './catalog'
import { autoFixPalette } from './palette'
import { normalizeBubbleTheme } from './normalize'
import {
  BUBBLE_FONT_PRESETS,
  BUBBLE_MATERIAL_IDS,
  BUBBLE_NAMEPLATE_STYLES,
  BUBBLE_TEMPLATE_IDS,
  type BubbleDesignIntent,
  type BubbleThemeV2,
} from './types'

export interface BubbleCandidate {
  slot: BubbleDesignIntent['slot']
  theme: BubbleThemeV2
  fixes: string[]
}

/** 槽位 → 气质 → 模板 的补位映射(仅当 LLM 输出缺失/非法时使用,不用于改写合法输出) */
const MOOD_TEMPLATE: Record<BubbleDesignIntent['mood'], BubbleThemeV2['templateId']> = {
  cute: 'cloud',
  cool: 'rpg',
  warm: 'soft-chat',
  dramatic: 'comic-burst',
  minimal: 'caption',
}

function fallbackIntent(slot: BubbleDesignIntent['slot'], mood: BubbleDesignIntent['mood']): BubbleDesignIntent {
  const templateId = MOOD_TEMPLATE[mood]
  return {
    slot,
    label: slot === 'faithful' ? '贴合版' : slot === 'expressive' ? '张扬版' : '克制版',
    templateId,
    materialId: BUBBLE_TEMPLATES[templateId].defaultMaterial,
    mood,
    lightness: slot === 'expressive' ? 'dark' : 'light',
    primaryColor: slot === 'expressive' ? '#8f7ff0' : slot === 'restrained' ? '#7f8fa6' : '#e98050',
    typographyPreset: 'friendly',
    nameplateStyle: 'badge',
  }
}

/** 严格差异补位池:任意两项在模板、材质、主色三个维度上都完全不同。
 * 最多只有两个已接纳候选,因此总能找到与它们分别至少两项不同的确定性方向。 */
const DIVERSITY_PRESETS: ReadonlyArray<Omit<BubbleDesignIntent, 'slot' | 'label'>> = [
  { templateId: 'soft-chat', materialId: 'gradient', mood: 'warm', lightness: 'light', primaryColor: '#e98050', typographyPreset: 'friendly', nameplateStyle: 'badge' },
  { templateId: 'comic-burst', materialId: 'neon', mood: 'dramatic', lightness: 'dark', primaryColor: '#8f7ff0', typographyPreset: 'comic', nameplateStyle: 'badge' },
  { templateId: 'caption', materialId: 'glass', mood: 'minimal', lightness: 'dark', primaryColor: '#7f8fa6', typographyPreset: 'clean', nameplateStyle: 'inline' },
  { templateId: 'sticker', materialId: 'paper', mood: 'cute', lightness: 'light', primaryColor: '#d99058', typographyPreset: 'pixel', nameplateStyle: 'inline' },
  { templateId: 'rpg', materialId: 'solid', mood: 'cool', lightness: 'dark', primaryColor: '#4b7bec', typographyPreset: 'clean', nameplateStyle: 'tab' },
]

function directionDistance(a: BubbleThemeV2, b: BubbleThemeV2): number {
  return Number(a.templateId !== b.templateId)
    + Number(a.material.id !== b.material.id)
    + Number(a.palette.primary !== b.palette.primary)
}

function diverseFromAll(theme: BubbleThemeV2, accepted: readonly BubbleThemeV2[]): boolean {
  return accepted.every((prior) => directionDistance(theme, prior) >= 2)
}

function diversityIntent(slot: BubbleDesignIntent['slot'], preset: (typeof DIVERSITY_PRESETS)[number]): BubbleDesignIntent {
  return {
    slot,
    label: slot === 'faithful' ? '贴合版' : slot === 'expressive' ? '张扬版' : '克制版',
    ...preset,
  }
}

function buildSystemPrompt(): string {
  return [
    '你是桌面虚拟角色的"气泡美术总监"。根据用户描述,给出三个方向不同的台词气泡设计方案。',
    '只输出一个 JSON 数组(长度 3),不要解释、不要代码围栏。三个槽位必须方向不同:',
    '槽位1 slot="faithful":最贴近用户描述的忠实方案;',
    '槽位2 slot="expressive":表现方案,轮廓或材质更强(如漫画爆发框、霓虹),适合喊话与强调;',
    '槽位3 slot="restrained":克制方案,更简洁、适合长时间阅读(如极简字幕、RPG 框)。',
    '每个元素字段:',
    '{',
    '  "slot": "faithful|expressive|restrained",',
    '  "label": "方案名,2~6个汉字",',
    '  "templateId": "soft-chat|pill|comic-burst|cloud|sticker|rpg|caption 之一",',
    '  "materialId": "solid|gradient|glass|paper|neon 之一(必须适合该模板:comic-burst 只能 solid/neon,cloud 不能 paper/neon,sticker 只能 solid/gradient/paper)",',
    '  "mood": "cute|cool|warm|dramatic|minimal",',
    '  "lightness": "light|dark",',
    '  "primaryColor": "#RRGGBB 主色(用户提到颜色/风格时优先贴合)",',
    '  "typographyPreset": "friendly|comic|clean|pixel",',
    '  "nameplateStyle": "badge|tab|inline|hidden"',
    '}',
    '三个候选的 templateId、materialId、primaryColor 至少两项彼此不同。',
  ].join('\n')
}

/** 从 LLM 原始输出里抠 JSON 数组(容忍代码围栏与混杂文本) */
function parseIntentArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // 落到正则抠取
  }
  const m = raw.match(/\[[\s\S]*\]/)
  if (m) {
    try {
      const parsed = JSON.parse(m[0])
      if (Array.isArray(parsed)) return parsed
    } catch {
      // 继续落到抛错
    }
  }
  throw new Error('输出中找不到 JSON 数组')
}

function intentOf(raw: unknown, slot: BubbleDesignIntent['slot']): BubbleDesignIntent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const label = typeof o.label === 'string' ? o.label.trim().slice(0, 10) : ''
  const templateId = BUBBLE_TEMPLATE_IDS.find((t) => t === o.templateId)
  const materialId = BUBBLE_MATERIAL_IDS.find((m) => m === o.materialId)
  if (!label || !templateId) return null
  const mood = (['cute', 'cool', 'warm', 'dramatic', 'minimal'] as const).find((m) => m === o.mood) ?? 'warm'
  const lightness = o.lightness === 'dark' ? 'dark' : 'light'
  const primaryColor = typeof o.primaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.primaryColor.trim()) ? o.primaryColor.trim().toLowerCase() : '#e98050'
  const typographyPreset = BUBBLE_FONT_PRESETS.find((f) => f === o.typographyPreset) ?? 'friendly'
  const nameplateStyle = BUBBLE_NAMEPLATE_STYLES.find((n) => n === o.nameplateStyle) ?? 'badge'
  return { slot, label, templateId, materialId: materialId ?? BUBBLE_TEMPLATES[templateId].defaultMaterial, mood, lightness, primaryColor, typographyPreset, nameplateStyle }
}

/** 意图 → 完整 V2 主题:骨架/版式取模板默认,配色走派生,材质越界降级,最后过一遍对比度自动修复 */
export function compileIntent(intent: BubbleDesignIntent): { theme: BubbleThemeV2; fixes: string[] } {
  const tpl = BUBBLE_TEMPLATES[intent.templateId]
  const materialId = compatibleMaterial(intent.templateId, intent.materialId)
  const theme = normalizeBubbleTheme({
    version: 2,
    id: 'custom_preview',
    label: intent.label,
    templateId: intent.templateId,
    material: { id: materialId, opacity: BUBBLE_MATERIAL_DEFAULTS[materialId].opacity, blur: BUBBLE_MATERIAL_DEFAULTS[materialId].blur },
    palette: {
      mode: 'per-speaker',
      primary: intent.primaryColor,
      lightness: intent.lightness,
      speakerStrength: 60,
    },
    frame: tpl.defaults.frame,
    typography: {
      fontPreset: intent.typographyPreset,
      size: 16,
      weight: tpl.defaults.typography.weight,
      lineHeight: tpl.defaults.typography.lineHeight,
      align: tpl.defaults.typography.align,
    },
    nameplate: { style: intent.nameplateStyle, position: tpl.defaults.nameplate.position },
    tail: tpl.defaults.tail,
    layout: tpl.defaults.layout,
    effects: tpl.defaults.effects,
  })
  if (!theme) throw new Error('设计意图编译失败')
  const fixed = autoFixPalette(theme)
  return { theme: fixed.theme, fixes: fixed.fixes }
}

/**
 * 生成三个候选。LLM 失败或槽位缺失时不整体失败:
 * 保留有效候选,缺失槽位按同 mood 的内置变体补位;绝不随机改写合法候选的模板。
 */
export async function generateBubbleCandidates(
  requirement: string,
  deps: { complete: typeof complete } = { complete },
): Promise<BubbleCandidate[]> {
  const req = requirement.trim()
  if (!req) throw new Error('请先描述你想要的风格')
  let raw: string
  const options: CompletionOptions = {
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: req },
    ],
    temperature: 0.85,
    maxTokens: 1200,
    jsonMode: true,
    timeoutMs: 90_000,
  }
  try {
    raw = await deps.complete(options)
  } catch (e) {
    throw new Error(`AI 调用失败:${String((e as Error)?.message ?? e).slice(0, 80)}`)
  }
  // 纯垃圾输出(找不到数组)不算失败:按 0 个有效候选处理,三槽位全部走内置变体补位
  let arr: unknown[] = []
  try {
    arr = parseIntentArray(raw)
  } catch {
    arr = []
  }
  const slots: BubbleDesignIntent['slot'][] = ['faithful', 'expressive', 'restrained']
  const FALLBACK_MOOD: Record<BubbleDesignIntent['slot'], BubbleDesignIntent['mood']> = {
    faithful: 'warm',
    expressive: 'dramatic',
    restrained: 'minimal',
  }
  // 元素自带合法 slot 时按 slot 归位,否则按数组顺序落入对应槽位;每个槽位只收第一个有效项
  const bySlot: Partial<Record<BubbleDesignIntent['slot'], BubbleDesignIntent>> = {}
  arr.forEach((item, i) => {
    const declared = (item as Record<string, unknown>)?.slot
    const slot = slots.find((s) => s === declared) ?? slots[Math.min(i, slots.length - 1)]
    if (!bySlot[slot]) {
      const intent = intentOf(item, slot)
      if (intent) bySlot[slot] = intent
    }
  })
  const intents = slots.map((slot) => bySlot[slot] ?? fallbackIntent(slot, FALLBACK_MOOD[slot]))
  // 编译 + 严格差异保证:每一对候选在(模板,降级后材质,主色)里至少两项不同。
  // 不足时从固定方向池轮换补位,不使用随机改写,相同输入得到稳定结构。
  const accepted: BubbleThemeV2[] = []
  const batchId = Date.now().toString(36)
  return intents.slice(0, 3).map((intent, i) => {
    let compiled = compileIntent(intent)
    if (!diverseFromAll(compiled.theme, accepted)) {
      const replacement = DIVERSITY_PRESETS
        .map((preset) => compileIntent(diversityIntent(intent.slot, preset)))
        .find((candidate) => diverseFromAll(candidate.theme, accepted))
      if (!replacement) throw new Error('无法生成方向足够不同的气泡候选')
      compiled = {
        ...replacement,
        fixes: [...replacement.fixes, '已轮换模板/材质方向,避免三个候选过于相似'],
      }
    }
    accepted.push(compiled.theme)
    // 槽位后缀保证同一批三个 id 互不相同(同毫秒生成也不撞)
    const slotTag = ['-f', '-e', '-r'][i] ?? `-${i}`
    return { slot: intent.slot, theme: { ...compiled.theme, id: `custom_${batchId}${slotTag}` }, fixes: compiled.fixes }
  })
}
