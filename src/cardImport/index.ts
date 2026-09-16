// 角色卡导入编排:parse → 分区烘焙 → 留档 → 返回结果。
// 不直接写配置:persona/names 的落盘由设置页经 saveField 原子保存
// (persona 与 personaSource 同存,经既有 bridgeServer 差分 → setPersonaOverride 生效)。
// 留档失败不影响导入结果(人设已在返回值里,警告里提示一句)。
import { composePersona, NAME_CAP } from './composePersona'
import { parseCharacterCard } from './parseCard'
import { saveCardImport } from '../storage/cardImportStore'

export interface CardImportOutcome {
  ok: boolean
  error?: string
  /** 烘焙完成的人设全文(≤ PERSONA_BUDGET) */
  personaText?: string
  /** 截到 12 字的角色名(可直接存 config.names.a/b) */
  name?: string
  /** 未截断的原始角色名(人设文本内使用全名) */
  fullName?: string
  warnings?: string[]
}

export async function importCharacterCard(
  input: { bytes?: Uint8Array; jsonText?: string },
  slot: 'a' | 'b',
  userName: string,
): Promise<CardImportOutcome> {
  const parsed = parseCharacterCard(input)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const card = parsed.card
  const composed = composePersona(card, { user: userName.trim() || '你' })
  const warnings = [...composed.warnings]
  try {
    await saveCardImport(slot, {
      importedAt: Date.now(),
      spec: card.spec,
      ...(card.creator ? { creator: card.creator } : {}),
      ...(card.characterVersion ? { characterVersion: card.characterVersion } : {}),
      tags: card.tags,
      styleExamples: composed.styleExamples,
      bakedLore: composed.bakedLore.map((e) => ({
        keys: e.keys,
        content: e.content,
        constant: true,
        priority: e.priority,
        enabled: e.enabled,
        ...(e.comment ? { comment: e.comment } : {}),
      })),
      keywordLore: composed.keywordLore.map((e) => ({
        keys: e.keys,
        content: e.content,
        constant: e.constant,
        priority: e.priority,
        enabled: e.enabled,
        ...(e.comment ? { comment: e.comment } : {}),
      })),
      alternateGreetings: card.alternateGreetings,
      raw: parsed.sourceJson,
    })
  } catch {
    warnings.push('导入留档保存失败(不影响人设生效)')
  }
  return {
    ok: true,
    personaText: composed.personaText,
    name: card.name.slice(0, NAME_CAP),
    fullName: card.name,
    warnings,
  }
}

export { parseCharacterCard, resolveMacros } from './parseCard'
export { composePersona, PERSONA_BUDGET, CORE_BUDGET, STYLE_BUDGET, LORE_BUDGET } from './composePersona'
