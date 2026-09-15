// 招牌怪癖·类型事实源(设计方案 docs/招牌怪癖系统设计方案.md §2)。
// 怪癖是"情境 → 行为"的条件触发式角色素材:模型生成、用户锁定/清除、演出注入为背景倾向。

export type QuirkValence = 'red' | 'blue'
export type QuirkCauseType = 'memory' | 'interaction' | 'inferred'
export type QuirkSource = 'cold' | 'crystallized'

export const QUIRK_TYPES = ['触发式', '仪式式', '规则式', '积累式', '观察式', '防御式', '社交式'] as const
export type QuirkType = (typeof QUIRK_TYPES)[number]

export interface QuirkEntry {
  id: string
  /** 触发情境(一句,日常对话里真实可能出现) */
  trigger: string
  /** 可观察行为(一句,别人看得到) */
  behavior: string
  /** red=怪/执拗/冲突向;blue=温柔/仪式/陪伴向(非负面/正面) */
  valence: QuirkValence
  type: QuirkType
  /** 解释该习惯为何形成的最小因果(不是背景故事);本身是可回收的谈资素材 */
  cause: string
  /** memory=明确来自已有经历;interaction=与用户长期互动形成;inferred=模型按人格轻量推导 */
  causeType: QuirkCauseType
  /** cold=按人设冷启动;crystallized=从近期对话结晶 */
  source: QuirkSource
  /** 用户锁定;锁定者不被自动替换(每价态至多 3 条) */
  locked: boolean
  /** 获取时的主演出集数 */
  createdAtEp: number
  /** 导演/注入侧冷却记账(P2 接线),未用过为 -1 */
  lastUsedEp: number
}

/** 每角色怪癖册:A/B/C 各一份 */
export type QuirkBook = Record<'A' | 'B' | 'C', QuirkEntry[]>

export type ActorSlot = 'A' | 'B' | 'C'

export const QUIRK_SLOTS: readonly ActorSlot[] = ['A', 'B', 'C']
