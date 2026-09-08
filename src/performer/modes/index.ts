// 模式注册表：DialogMode 是"抽象父类"契约，每个模式文件是一个"子类"。
// 新增模式 = 新建一个 ts 文件导出 DialogMode + 在 MODES 里加一项，
// 分段按钮/历史徽标/重放节奏/LLM 指令全部自动感知，其余代码零改动。
import { crosstalkMode } from './crosstalk'
import { dailyMode } from './daily'
import type { DialogLine } from '../player'

export interface DialogMode<ID extends string = string> {
  /** 注册键，落盘到历史的 mode 字段 */
  id: ID
  /** 分段按钮/历史徽标显示名 */
  label: string
  /** 徽标等场景的强调色 */
  accent: string
  /** 台词间奏（毫秒） */
  gap: number
  /** LLM 生成失败时的兜底剧本 */
  script: DialogLine[]
  /** 该模式的编剧指令，拼进 system prompt */
  prompt: string
  /** 可选：专属话题池，缺省用全局池（topicSeeds） */
  topics?: string[]
  /** 可选：随机话题时改用"使用者兴趣"作主题的概率(0~1,缺省 0)。
   *  日常闲聊适合高些,相声等结构化模式只宜点缀 */
  interestTopicChance?: number
}

export const MODES = {
  daily: dailyMode,
  crosstalk: crosstalkMode,
} satisfies Record<string, DialogMode>

/** 由注册表键自动派生；注册表加一项，类型自动扩展 */
export type Mode = keyof typeof MODES

/** UI 按此顺序渲染分段选择器 */
export const modeList = Object.values(MODES)

/** 历史/落盘里的 mode 是任意字符串，未知 id 回退日常 */
export function modeOf(id: string): DialogMode {
  return (MODES as Record<string, DialogMode>)[id] ?? MODES.daily
}
