// 记忆语义槽位注册表:slot 是封闭词表——"住上海→住北京"这类冲突替代只在同 slot
// 之间成立;开放式字符串会产生 profile.currentResidence / user.currentCity 等同义
// 不同名,永远无法互相识别。模型只能从白名单里提 slot,清洗时白名单外的归 undefined。
// SLOT_POLICY 是 slot 的本地策略事实源:volatility/sensitivity/确认窗一律以注册表
// 为准,模型标注只是输入(取严合并,见 memoryPolicy.mergeSensitivity)。
export const MEMORY_SLOTS = [
  'profile.name',
  'profile.currentResidence',
  'profile.hometown',
  'profile.currentJob',
  'profile.school',
  'preference.food',
  'preference.hobby',
  'health.allergy',
  'health.medication',
] as const

export type MemorySlot = (typeof MEMORY_SLOTS)[number]

export interface SlotPolicy {
  volatility: 'stable' | 'changeable'
  sensitivity: 'normal' | 'private' | 'restricted'
  /** 建议确认窗(天);null = stable 事实不按时间要求重新确认 */
  confirmDays: number | null
}

export const SLOT_POLICY: Record<MemorySlot, SlotPolicy> = {
  'profile.name': { volatility: 'stable', sensitivity: 'normal', confirmDays: null },
  'profile.currentResidence': { volatility: 'changeable', sensitivity: 'private', confirmDays: 90 },
  'profile.hometown': { volatility: 'stable', sensitivity: 'normal', confirmDays: null },
  'profile.currentJob': { volatility: 'changeable', sensitivity: 'normal', confirmDays: 120 },
  'profile.school': { volatility: 'stable', sensitivity: 'normal', confirmDays: null },
  'preference.food': { volatility: 'changeable', sensitivity: 'normal', confirmDays: 180 },
  'preference.hobby': { volatility: 'changeable', sensitivity: 'normal', confirmDays: 180 },
  'health.allergy': { volatility: 'changeable', sensitivity: 'restricted', confirmDays: 7 },
  'health.medication': { volatility: 'changeable', sensitivity: 'restricted', confirmDays: 7 },
}

export function isMemorySlot(x: unknown): x is MemorySlot {
  return typeof x === 'string' && (MEMORY_SLOTS as readonly string[]).includes(x)
}

const REGION_SUFFIX = /(市|地区|自治州|盟|省|自治区|特别行政区)+$/

/** 按 slot 规范化取值:同义写法("北京市"/"北京")必须归一,否则产生伪冲突替代 */
export function normalizeSlotValue(slot: MemorySlot, raw: string): string {
  const v = raw.trim().replace(/\s+/g, '')
  if (!v) return ''
  if (slot === 'profile.currentResidence' || slot === 'profile.hometown') {
    const stripped = v.replace(REGION_SUFFIX, '')
    return stripped || v
  }
  return v
}
