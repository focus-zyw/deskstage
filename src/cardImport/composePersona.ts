// 角色卡 → 人设文本编译器(纯函数):三段式分区烘焙。
// 【核心人设】description/personality/scenario(预算内尽量不截,单条超支才截断加省略号)
// 【表达风格参考】mes_example 前 3 组(优先)+ first_mes(预算不够先弃)——只作口吻
//   参考,固定前导明示"不代表当前情境,不要机械复述"
// 【长期背景设定】character_book 仅 constant===true 条目,按 priority 降序逐条装入,
//   装不下即停(完整条目语义,绝不切半句)
// 各段预算含本段标题与前导;每一段跳过/截断都产生用户可见的 warning。
import type { CardLoreEntry, RawCard } from './parseCard'
import { resolveMacros } from './parseCard'

export const PERSONA_BUDGET = 8000
export const CORE_BUDGET = 4800
export const STYLE_BUDGET = 2000
export const LORE_BUDGET = 1200
/** mes_example 最多取前几组(<START> 分组) */
export const MES_EXAMPLE_GROUPS = 3

/** 名字保存上限(与 config.names 清洗一致) */
export const NAME_CAP = 12

const STYLE_PREAMBLE =
  '以下内容仅用于理解该角色的说话方式、措辞、语气和互动风格,不代表当前情境,不要机械复述。'
const LORE_PREAMBLE = '以下是该角色始终知道的重要世界背景:'

export interface ComposeResult {
  personaText: string
  warnings: string[]
  /** 实际烘焙进人设的常驻世界书条目 */
  bakedLore: CardLoreEntry[]
  /** 未烘焙留档的关键词条目(非 constant / 预算外),供未来世界书系统迁移 */
  keywordLore: CardLoreEntry[]
  /** 烘焙的风格示例(mes 组在前,first_mes 在后,宏已替换) */
  styleExamples: string[]
}

const LABELS = { description: '角色描述', personality: '性格', scenario: '场景背景' } as const

/** 单条超支时的截断:优先回退到段落/行边界(避免半句切断),
 *  单段落超长才按字符硬切;结尾加省略号并计 warning */
function trimToFit(text: string, budget: number, warn: string, warnings: string[]): string {
  const cap = Math.max(budget - 1, 0)
  let cut = text.slice(0, cap)
  const para = cut.lastIndexOf('\n\n')
  const line = cut.lastIndexOf('\n')
  const at = para >= cap * 0.5 ? para : line >= cap * 0.5 ? line : -1
  if (at > 0) cut = cut.slice(0, at)
  warnings.push(warn)
  return cut.trimEnd() + '\n…'
}

export function composePersona(card: RawCard, ctx: { user: string }): ComposeResult {
  const warnings: string[] = []
  if (card.name.length > NAME_CAP) {
    warnings.push(`角色名「${card.name}」超过 ${NAME_CAP} 字,保存时将截断`)
  }
  const mac = (text: string): string => resolveMacros(text, { char: card.name, user: ctx.user })

  // ---------- 第一段:核心人设 ----------
  const coreHead = '【核心人设】'
  const coreLines: string[] = [coreHead]
  let coreUsed = coreHead.length
  for (const key of ['description', 'personality', 'scenario'] as const) {
    const raw = mac(card[key])
    if (!raw) continue
    const line = `${LABELS[key]}:${raw}`
    if (coreUsed + 1 + line.length <= CORE_BUDGET) {
      coreLines.push(line)
      coreUsed += 1 + line.length
    } else {
      const remain = CORE_BUDGET - coreUsed - 1
      if (remain > 20) {
        coreLines.push(`${LABELS[key]}:${trimToFit(raw, remain, `「${LABELS[key]}」超出核心人设预算,已截断`, warnings)}`)
        coreUsed = CORE_BUDGET
      } else {
        warnings.push(`「${LABELS[key]}」超出核心人设预算,未能装入`)
      }
    }
  }
  const coreSection = coreLines.length > 1 ? coreLines.join('\n') : ''

  // ---------- 第二段:表达风格参考 ----------
  const styleLines: string[] = ['【表达风格参考】', STYLE_PREAMBLE]
  let styleUsed = styleLines[0].length + 1 + styleLines[1].length
  const styleExamples: string[] = []
  // mes_example:<START> 分组取前 3 组(按原始顺序;空组丢弃)
  const groups = card.mesExample
    .split('<START>')
    .map((g) => mac(g).trim())
    .filter(Boolean)
    .slice(0, MES_EXAMPLE_GROUPS)
  groups.forEach((g, i) => styleExamples.push(`示例${i + 1}:\n${g}`))
  if (card.firstMes) styleExamples.push(`开场示例:\n${mac(card.firstMes)}`)
  let droppedStyle = 0
  for (const item of styleExamples) {
    if (styleUsed + 1 + item.length <= STYLE_BUDGET) {
      styleLines.push(item)
      styleUsed += 1 + item.length
    } else {
      droppedStyle += 1
    }
  }
  if (droppedStyle > 0) {
    warnings.push(`表达风格示例有 ${droppedStyle} 条超出预算未装入(mes_example 优先,开场示例先弃)`)
  }
  const styleSection = styleLines.length > 2 ? styleLines.join('\n') : ''

  // ---------- 第三段:常驻世界设定 ----------
  const allLore = card.loreBook ?? []
  const constants = allLore
    .filter((e) => e.constant && e.enabled)
    .sort((a, b) => b.priority - a.priority)
  const loreLines: string[] = ['【长期背景设定】', LORE_PREAMBLE]
  let loreUsed = loreLines[0].length + 1 + loreLines[1].length
  const bakedLore: CardLoreEntry[] = []
  for (const e of constants) {
    const line = `- ${mac(e.content)}`
    if (loreUsed + 1 + line.length <= LORE_BUDGET) {
      loreLines.push(line)
      loreUsed += 1 + line.length
      bakedLore.push(e)
    } else {
      warnings.push(`常驻世界设定超出预算,有 ${constants.length - bakedLore.length} 条未装入(按优先级保留前者)`)
      break
    }
  }
  const loreSection = bakedLore.length > 0 ? loreLines.join('\n') : ''
  const keywordLore = allLore.filter((e) => !bakedLore.includes(e))

  const personaText = [coreSection, styleSection, loreSection].filter(Boolean).join('\n\n')
  if (!personaText) warnings.push('这张卡没有可用的设定内容,人设为空')

  return { personaText, warnings, bakedLore, keywordLore, styleExamples }
}
