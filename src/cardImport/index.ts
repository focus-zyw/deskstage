// 角色卡导入编排:parse → 按需语义本地化(非中文字段译中)→ 分区烘焙 → 留档 → 返回结果。
// 不直接写配置:persona/names 的落盘由设置页经 saveField 原子保存
// (persona 与 personaSource 同存,经既有 bridgeServer 差分 → setPersonaOverride 生效)。
// 留档失败不影响导入结果(人设已在返回值里,警告里提示一句)。
import { composePersona, NAME_CAP } from './composePersona'
import { cardNeedsLocalization, localizeRawCard } from './localize'
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
  /** 非中文卡已完成语义本地化 */
  localized?: boolean
  /** 卡来源元数据(入库用) */
  card?: { spec: string; creator?: string; characterVersion?: string }
}

export async function importCharacterCard(
  input: { bytes?: Uint8Array; jsonText?: string },
  slot: 'a' | 'b',
  userName: string,
  opts: { localize?: boolean } = {},
): Promise<CardImportOutcome> {
  const parsed = parseCharacterCard(input)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  let card = parsed.card
  const warnings: string[] = []
  let localized = false
  // 非中文字段语义本地化(默认开):失败 fail-open 按原文导入
  if (opts.localize !== false && cardNeedsLocalization(card)) {
    const r = await localizeRawCard(card)
    card = r.card
    localized = r.localized
    warnings.push(...r.warnings)
  }
  const composed = composePersona(card, { user: userName.trim() || '你' })
  warnings.push(...composed.warnings)
  try {
    await saveCardImport(slot, {
      importedAt: Date.now(),
      spec: card.spec,
      ...(card.creator ? { creator: card.creator } : {}),
      ...(card.characterVersion ? { characterVersion: card.characterVersion } : {}),
      tags: card.tags,
      localized,
      styleExamples: composed.styleExamples,
      bakedLore: composed.bakedLore.map((e) => ({
        keys: e.keys,
        content: e.content,
        constant: true,
        priority: e.priority,
        enabled: e.enabled,
        ...(e.aliases && e.aliases.length > 0 ? { aliases: e.aliases } : {}),
        ...(e.comment ? { comment: e.comment } : {}),
      })),
      keywordLore: composed.keywordLore.map((e) => ({
        keys: e.keys,
        content: e.content,
        constant: e.constant,
        priority: e.priority,
        enabled: e.enabled,
        ...(e.aliases && e.aliases.length > 0 ? { aliases: e.aliases } : {}),
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
    localized,
    card: { spec: card.spec, ...(card.creator ? { creator: card.creator } : {}), ...(card.characterVersion ? { characterVersion: card.characterVersion } : {}) },
  }
}

export { parseCharacterCard, resolveMacros } from './parseCard'
export { composePersona, PERSONA_BUDGET, CORE_BUDGET, STYLE_BUDGET, LORE_BUDGET } from './composePersona'
export { cardNeedsLocalization, localizeRawCard } from './localize'
