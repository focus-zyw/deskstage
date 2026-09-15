// 表达导演 · 领域类型(纯声明,无运行时依赖)。
//
// 定位(docs/表达导演设计方案.md):在"角色收到消息"和"模型生成文字"之间,
// 由 ExpressionDirector 决定这轮"怎么说"(动作/立场/长度/旧梗),模型只负责把
// 决定写成自然台词。规划全程不调用远程模型,单轮目标耗时 < 2ms。
//
// 不变量(方案 §二):
// · 不能越过 limits.maySpeak=false 强迫角色发言(worker 侧保证);
// · 规划失败回退普通直接回答策略,不阻断聊天(director.plan 捕获一切异常);
// · 每轮最多一个意外表达动作(单轮单动作,trace.surprise 标注);
// · 旧梗只能从输入提供的真实记忆中选择,不允许编造(callbackPicker 只看 context.gags)。

import type { Speaker } from '../performer/dialogSchema'

/** 表达动作:这轮台词的"手法",概率由代码抽取,不让模型自己遵守百分比 */
export type ExpressionMove =
  | 'direct' // 直接回应
  | 'tease' // 轻微调侃
  | 'challenge' // 不完全同意、反问前提
  | 'absurd-leap' // 突然但可理解的荒诞联想
  | 'literalize' // 故意或自然地字面理解
  | 'callback' // 回收共同旧梗
  | 'deflect' // 嘴硬、岔开、掩饰
  | 'vulnerable' // 短暂暴露真实情绪
  | 'pivot' // 主动开启相关新话题
  | 'close' // 自然结束,不强行追问

/** 立场:对刺激内容的表态方向(渲染成一行指令,不给模型自由发挥空间) */
export type ExpressionStance = 'agree' | 'neutral' | 'doubt' | 'disagree'

/** 本轮意图:任务优先级的载体——mustAnswerTask 时 intent 恒为 'answer' */
export type ExpressionIntent = 'answer' | 'react' | 'ask' | 'defend' | 'shift' | 'close'

/** 长度档:群聊协议 80 字硬上限不变,这里决定"实际要求多短" */
export type ExpressionLength = 'micro' | 'short' | 'medium'

/** 长度档字数区间(方案 §六);maxChars 取档位上限 */
export const LENGTH_BOUNDS: Record<ExpressionLength, { min: number; max: number }> = {
  micro: { min: 2, max: 12 },
  short: { min: 8, max: 30 },
  medium: { min: 20, max: 60 },
}

/** 旧梗引用:只能指向宿主提供的真实记忆条目(id = story.json 的 gag id) */
export interface CallbackRef {
  id: string
  text: string
}

/** 表达通道:首期只接 'group-chat';其余通道是二阶段的接入面,先收进类型 */
export type ExpressionChannel =
  | 'group-chat'
  | 'legacy-chat'
  | 'interjection'
  | 'live'
  | 'idle'
  | 'performance'

/** 一次规划的输入:宿主(worker)组好的上下文,导演不自己取数 */
export interface ExpressionInput {
  actor: Speaker
  channel: ExpressionChannel
  /** 本轮最需要回应的那条消息(批次主消息文本) */
  stimulus: string
  /** 最近对话(含未读批次,时间序;已截尾,通常 ≤ 12 条) */
  recent: ReadonlyArray<{ author: 'user' | Speaker; text: string }>
  context: {
    mood?: string
    facts?: string[]
    /** 宿主从 story.json 只读预选的真实旧梗候选(导演绝不使用其它来源) */
    gags?: Array<{ id: string; text: string }>
    mode?: string
  }
  limits: {
    /** false = 本轮以倾听为主;导演不得产生"必须发言"的指令 */
    maySpeak: boolean
    /** 通道协议允许的硬上限(群聊 = 80) */
    maxChars: number
    /** false = 上一条自己回复已在反问,本轮禁再反问 */
    mayAskQuestion: boolean
  }
  /** 生效人设全文:自定义人设据此派生 VoiceMechanics(方案 §四) */
  personaText?: string
}

/** 规划结果:内部保留结构化 Plan,最后一步才 render 成 instruction */
export interface ExpressionPlan {
  intent: ExpressionIntent
  move: ExpressionMove
  stance: ExpressionStance
  length: ExpressionLength
  callback?: CallbackRef
  constraints: {
    mayAskQuestion: boolean
    mustAnswerTask: boolean
    maxChars: number
  }
  /** 注入 prompt 的本轮表达指令(执行即可,不得复述) */
  instruction: string
  trace: ExpressionTrace
  /** 口头禅冷却中:本词已被指令点名字面禁用,质量闸据时检测(与 instruction 同源) */
  bannedCatchphrase?: string
}

/** 一次规划的留痕:仅枚举与 id,无正文——聊天日志 trace 槽/诊断都按此隐私红线 */
export interface ExpressionTrace {
  id: string
  actor: Speaker
  channel: ExpressionChannel
  move: ExpressionMove
  stance: ExpressionStance
  length: ExpressionLength
  surprise: 'none' | 'mild'
  callbackId?: string
}

/** 质量闸问题类别(方案 §九;repetition/echo 不可轻修复,其余可) */
export type GateIssue =
  | 'repetition' // 与该角色最近六条回复完全或高度重复
  | 'service-tone' // "作为 AI"等客服腔
  | 'echo' // 无意义复述用户原句
  | 'over-length' // 超出长度计划
  | 'question-ban' // 连续反问
  | 'catchphrase-cooldown' // 口头禅冷却未结束
