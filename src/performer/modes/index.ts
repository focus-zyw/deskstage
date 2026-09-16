// 模式注册表：DialogMode 是"抽象父类"契约，每个模式文件是一个"子类"。
// 新增内置模式 = 新建一个 ts 文件导出 DialogMode + 在 MODES 里加一项，
// 模式菜单/历史徽标/重放节奏/LLM 指令全部自动感知，其余代码零改动。
// 用户自定义模式(模式工坊)运行时经 allModes()/modeOf() 动态并入,同享以上全部链路。
import { useMemo } from 'react'
import { crosstalkMode } from './crosstalk'
import { dailyMode } from './daily'
import { liveMode } from './live'
import { getCustomModesSnapshot, useCustomModes } from '../../storage/customModesStore'
import type { DialogLine } from '../player'

// 弹幕回复 prompt 需要读 live 的 tone 声明(直播基调不锁死,改 live.ts 即切换)
export { liveMode }


export interface DialogMode<ID extends string = string> {
  /** 注册键，落盘到历史的 mode 字段 */
  id: ID
  /** 模式菜单/历史徽标显示名 */
  label: string
  /** 徽标等场景的强调色 */
  accent: string
  /** 台词间奏（毫秒） */
  gap: number
  /** LLM 生成失败时的兜底剧本 */
  script: DialogLine[]
  /** 该模式的编剧指令，拼进 system prompt */
  prompt: string
  /** 可选：生成策略(relay 模式忽略 prompt 走多会话轮转) */
  /** 可选：专属话题池，缺省用全局池（topicSeeds） */
  topics?: string[]
  /** 可选：随机话题时改用"使用者兴趣"作主题的概率(0~1,缺省 0)。
   *  日常闲聊适合高些,相声等结构化模式只宜点缀 */
  interestTopicChance?: number
  /** 可选：自然语言路由触发词("来一段关于加班的相声"里的"相声");
   *  缺省不可被自然语言点播,只能从模式菜单进。内置模式与模式工坊新模式都靠它进路由 */
  triggers?: string[]
  /** 可选：基调。'comedy' 或缺省 = 默认互怼喜剧全套(包袱/secret反转/逗弄/关系攻守),内置仅 crosstalk 走这档;
   *  其他描述值(如 daily 的 '日常闲聊'、模式工坊的 '温暖治愈')= 非喜剧分支:prompt 裁掉默认喜剧件,tone 值本身也注入 prompt 作基调语境。
   *  live 不声明(不锁死):其弹幕回复 prompt 也读本字段,改 live.ts 一行即可切换直播风格 */
  tone?: string
}

export const MODES = {
  daily: dailyMode,
  crosstalk: crosstalkMode,
  live: liveMode,
} satisfies Record<string, DialogMode>

/** 内置模式的注册键(编译期可枚举) */
export type BuiltinMode = keyof typeof MODES

/** 模式 id:内置键保留自动补全,同时放行自定义模式等任意字符串(历史落盘兼容) */
export type Mode = BuiltinMode | (string & {})

/** UI 按此顺序渲染内置模式(自定义模式追加在后,见 allModes) */
export const modeList = Object.values(MODES)

/** 内置 + 自定义的完整模式列表:模式菜单/命令注册/自然语言路由的动态事实源 */
export function allModes(): DialogMode[] {
  const custom = getCustomModesSnapshot()
  if (custom.length === 0) return modeList
  const builtin = new Set(Object.keys(MODES))
  return [...modeList, ...custom.filter((m) => !builtin.has(m.id))]
}

/** useSyncExternalStore 版 allModes:自定义模式增删时触发重渲染(UI 组件用) */
export function useAllModes(): DialogMode[] {
  const custom = useCustomModes()
  return useMemo(() => {
    const builtin = new Set(Object.keys(MODES))
    return [...modeList, ...custom.filter((m) => !builtin.has(m.id))]
  }, [custom])
}

/** 历史/落盘里的 mode 是任意字符串:内置 → 自定义 → 都没有则回退日常 */
export function modeOf(id: string): DialogMode {
  return (
    (MODES as Record<string, DialogMode>)[id] ??
    getCustomModesSnapshot().find((m) => m.id === id) ??
    MODES.daily
  )
}

/** 该模式是否走默认互怼喜剧全套(tone 缺省或 'comedy');非喜剧模式裁掉喜剧件 */
export function isComedyMode(id: string): boolean {
  const t = modeOf(id).tone?.trim()
  return !t || t === 'comedy'
}
