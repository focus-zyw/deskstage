// 人设 → 说话机制(方案 §四):四维画像(persona.ts)描述"是什么样的人",
// VoiceMechanics 把它翻译成"怎么说话"的可计算机制——长度倾向、碎句概率、
// 同意偏置、调侃强度、招牌动作、防御反应与禁令。
//
// 内置角色用内建表(与 persona.ts 的 DIMENSIONS/DEFAULTS 一一呼应);
// 用户自定义人设接管人格后,不再强加默认机制(persona.ts 分层纪律同款),
// 改用确定性关键词派生 + 中性基线:不完美但稳定、可测试、零模型调用。
// 保存人设时让模型顺便生成结构化 VoiceMechanics 属后续阶段(方案 §十)。

import { defaultCatchphrases, isPersonaCustomized } from '../engine/persona'
import type { Speaker } from '../performer/dialogSchema'
import type { ExpressionMove } from './types'

export interface VoiceMechanics {
  rhythm: {
    preferredLength: 'micro' | 'short' | 'mixed'
    /** 说半截话/碎句的倾向 0~1 */
    fragmentChance: number
    /** 连说多个短句的倾向 0~1 */
    multiSentenceChance: number
  }
  social: {
    /** 同意偏置 0~1:越高越容易先接住对方 */
    agreementBias: number
    /** 调侃强度 0~1:放大 tease/challenge 权重 */
    teasingIntensity: number
    /** 主动度 0~1:放大 pivot/close 权重 */
    initiative: number
  }
  /** 招牌动作:列表内动作权重上浮,列表外下沉——角色辨识度的主要来源 */
  humor: ExpressionMove[]
  /** 防御反应:触发情境 → 本轮改用的动作(如被夸→嘴硬) */
  defense: {
    trigger: string
    response: ExpressionMove
  }
  /** 禁令:逐条渲染进指令,违反由质量闸观测 */
  forbiddenPatterns: string[]
}

/** 中性基线:自定义人设未命中任何关键词时的兜底(不冷不热、短句为主) */
export const NEUTRAL_MECHANICS: VoiceMechanics = {
  rhythm: { preferredLength: 'short', fragmentChance: 0.2, multiSentenceChance: 0.35 },
  social: { agreementBias: 0.5, teasingIntensity: 0.4, initiative: 0.5 },
  humor: [],
  defense: { trigger: '被戳到痛处', response: 'deflect' },
  forbiddenPatterns: ['连续解释大道理', '热情客服式附和'],
}

/** 内置角色机制:A 夸张爱吹牛(逗哏),B 冷静毒舌(捧哏,方案 §四示例),C 呆萌字面(团宠) */
export const BUILTIN_MECHANICS: Record<Speaker, VoiceMechanics> = {
  A: {
    rhythm: { preferredLength: 'mixed', fragmentChance: 0.25, multiSentenceChance: 0.5 },
    social: { agreementBias: 0.55, teasingIntensity: 0.7, initiative: 0.75 },
    humor: ['absurd-leap', 'tease', 'pivot'],
    defense: { trigger: '被戳穿吹牛或被冷场', response: 'deflect' },
    forbiddenPatterns: ['连续解释大道理', '热情客服式附和', '每轮都吹同一种牛'],
  },
  B: {
    rhythm: { preferredLength: 'micro', fragmentChance: 0.45, multiSentenceChance: 0.15 },
    social: { agreementBias: 0.35, teasingIntensity: 0.65, initiative: 0.4 },
    humor: ['challenge', 'deflect', 'callback'],
    defense: { trigger: '被关心或被夸', response: 'deflect' },
    forbiddenPatterns: ['连续解释大道理', '热情客服式附和', '每轮都说"然后呢"'],
  },
  C: {
    rhythm: { preferredLength: 'short', fragmentChance: 0.3, multiSentenceChance: 0.35 },
    social: { agreementBias: 0.7, teasingIntensity: 0.3, initiative: 0.5 },
    humor: ['literalize', 'vulnerable', 'deflect'],
    defense: { trigger: '被逗急了', response: 'literalize' },
    forbiddenPatterns: ['热情客服式附和', '连续用歪理反击'],
  },
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** 自定义人设的确定性派生:关键词命中就微调,未命中保持中性基线。
 *  派生只做加性微调,绝不把内置人格(毒舌/字面)强加回自定义角色 */
export function deriveMechanics(text: string): VoiceMechanics {
  const m: VoiceMechanics = {
    rhythm: { ...NEUTRAL_MECHANICS.rhythm },
    social: { ...NEUTRAL_MECHANICS.social },
    humor: [],
    defense: { ...NEUTRAL_MECHANICS.defense },
    forbiddenPatterns: [...NEUTRAL_MECHANICS.forbiddenPatterns],
  }
  if (/话少|惜字如金|寡言|高冷|冷淡|简短/.test(text)) {
    m.rhythm.preferredLength = 'micro'
    m.rhythm.fragmentChance = 0.4
    m.rhythm.multiSentenceChance = 0.15
  } else if (/话痨|话多|滔滔不绝|啰嗦|夸张|跑火车/.test(text)) {
    m.rhythm.preferredLength = 'mixed'
    m.rhythm.multiSentenceChance = 0.5
  }
  if (/毒舌|吐槽|犀利|一针见血|怼/.test(text)) {
    m.social.teasingIntensity = clamp01(m.social.teasingIntensity + 0.3)
    m.humor.push('challenge')
  }
  if (/温柔|暖心|体贴|治愈|耐心/.test(text)) {
    m.social.agreementBias = clamp01(m.social.agreementBias + 0.3)
  }
  if (/脑洞|爱吹牛|跑火车|联想|想象力/.test(text)) m.humor.push('absurd-leap')
  if (/字面|当真|认真执行|一根筋|较真/.test(text)) m.humor.push('literalize')
  if (/傲娇|嘴硬|掩饰|口是心非|别扭/.test(text)) {
    m.defense = { trigger: '被关心或被夸', response: 'deflect' }
    m.humor.push('deflect')
  }
  if (/反问|抬杠|质疑/.test(text)) m.humor.push('challenge')
  if (/害羞|脸红|情绪|委屈|软/.test(text)) m.humor.push('vulnerable')
  return {
    ...m,
    humor: [...new Set(m.humor)].slice(0, 4),
  }
}

/** 生效语音机制:默认人设用内建表;自定义人设用派生(分层纪律:不强加默认人格) */
export function voiceMechanicsOf(actor: Speaker, personaText?: string): VoiceMechanics {
  if (personaText !== undefined && isPersonaCustomized(actor)) return deriveMechanics(personaText)
  return BUILTIN_MECHANICS[actor]
}

/** 自定义人设文本里的口头禅:匹配内置文案同款写法 口头禅"A" "B" */
function catchphrasesFromText(text: string): string[] {
  const out: string[] = []
  const re = /["“]([^"”]{1,12})["”]/g
  const anchor = text.indexOf('口头禅')
  if (anchor < 0) return out
  for (const match of text.slice(anchor, anchor + 120).matchAll(re)) {
    const phrase = match[1]?.trim()
    if (phrase) out.push(phrase)
    if (out.length >= 3) break
  }
  return out
}

/** 生效口头禅(冷却与禁用指令的依据):默认人设取 persona 内建表;
 *  自定义人设解析不出就返回空表——冷却规则自动失效,不猜不编 */
export function catchphrasesOf(actor: Speaker, personaText?: string): string[] {
  if (personaText !== undefined && isPersonaCustomized(actor)) return catchphrasesFromText(personaText)
  return [...defaultCatchphrases(actor)]
}
