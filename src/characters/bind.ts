// 槽位绑定投影(纯函数):角色库是事实源,绑定 = 把角色字段投影进槽位配置
// (names/genders/persona/personaSource + slotBindings 指针),经 saveField 原子落盘、
// bridgeServer 既有差分即时生效;解绑 = 投影空值(空名回退甲/乙/丙、空人设回内置
// 人设、personaSource='default')。生成管线零改动。
// 注意:config 的 names/genders/persona 等都是整对象存储,sanitizePartial 不做槽位级
// 合并——补丁必须从 current 展开全量对象、只覆盖目标槽,否则其他槽会被重置。
import type { AppConfig } from '../storage/configStore'
import type { CharacterDef } from '../storage/charactersStore'
import type { ActorSlot } from '../engine/persona'
import { defaultPersonaText } from '../engine/persona'

export type SlotKey = 'a' | 'b' | 'c'

/** 内置默认性别(解绑还原用;与 persona.ts DEFAULTS 对应) */
const BUILTIN_GENDER: Record<SlotKey, '女' | '男'> = { a: '女', b: '男', c: '女' }

export interface SlotBindings {
  a: string | null
  b: string | null
  c: string | null
}

/** 绑定补丁的输入快照(从当前配置取这五个字段) */
export interface BindingCurrent {
  names: AppConfig['names']
  genders: AppConfig['genders']
  persona: AppConfig['persona']
  personaSource: AppConfig['personaSource']
  slotBindings: SlotBindings
}

/** 构造绑定/解绑的配置补丁(char=null = 解绑)。只覆盖目标槽,其余槽原样保留。
 *  内置条目 persona 留空 → 投影内置模板、personaSource 保持 default(话题包/画像/
 *  口头禅保真);其余投影 'custom' */
export function buildBindingPatch(
  slot: SlotKey,
  char: (Pick<CharacterDef, 'id' | 'name' | 'gender' | 'persona'> & Partial<Pick<CharacterDef, 'builtin'>>) | null,
  current: BindingCurrent,
): Partial<AppConfig> {
  return {
    names: { ...current.names, [slot]: char ? char.name : '' },
    genders: { ...current.genders, [slot]: char ? char.gender : BUILTIN_GENDER[slot] },
    persona: { ...current.persona, [slot]: char ? effectivePersona(char, defaultPersonaText) : '' },
    personaSource: { ...current.personaSource, [slot]: char ? projectedPersonaSource(char) : 'default' },
    slotBindings: { ...current.slotBindings, [slot]: char ? char.id : null },
  }
}

/** 角色当前绑定的槽位列表 */
export function slotsBoundTo(bindings: SlotBindings | undefined, characterId: string): SlotKey[] {
  if (!bindings) return []
  return (['a', 'b', 'c'] as const).filter((s) => bindings[s] === characterId)
}

/** 某槽位绑定的角色 id(null = 内置默认) */
export function boundCharacterId(bindings: SlotBindings | undefined, slot: SlotKey): string | null {
  return bindings?.[slot] ?? null
}

/** 其余槽位是否占用了某角色(下拉标注用);excludeSlot = 本槽不算自己 */
export function occupiedByElse(bindings: SlotBindings | undefined, characterId: string, excludeSlot: SlotKey): SlotKey | null {
  for (const s of ['a', 'b', 'c'] as const) {
    if (s !== excludeSlot && bindings?.[s] === characterId) return s
  }
  return null
}

const HOME_ACTOR: Record<string, ActorSlot> = { a: 'A', b: 'B', c: 'C' }

/** 内置条目 persona 留空 = 跟随内置模板(defaultPersonaText 按当前配置名替换);
 *  其余(非内置/已固化文本)用自身文本 */
export function effectivePersona(
  char: Pick<CharacterDef, 'persona' | 'builtin'>,
  defaultPersonaText: (slot: ActorSlot) => string,
): string {
  if (char.builtin && !char.persona.trim()) return defaultPersonaText(HOME_ACTOR[char.builtin])
  return char.persona
}

/** 投影 personaSource:内置未改(留空跟模板)= 'default'(默认职业话题包/四维画像/
 *  默认口头禅保真);其余 = 'custom' */
export function projectedPersonaSource(char: Pick<CharacterDef, 'persona' | 'builtin'>): 'default' | 'custom' {
  if (char.builtin && !char.persona.trim()) return 'default'
  return 'custom'
}
