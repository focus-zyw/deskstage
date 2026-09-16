// 聊天回复情绪标签(方案 docs/自由聊天情绪标签设计方案.md):纯逻辑,无 IO。
// 自由聊天回复常缺"这一句什么情绪"的可视反馈(呈现恒 talk 姿势),由模型在回复
// 尾部自报情绪标签,这里负责协议的纯部分:解析/剥除/词表映射/情绪增量换算。
//
// 词表对齐自家立绘动作(spriteSets actions),不引入没有资产的情绪;
// 标签只在 plain 直答通道作为 in-band 载体,schema 群聊走既有 reply.action 字段,
// 两条通道在呈现侧经 emotionActionOf() 查同一张表。

export type MoodTagId = 'happy' | 'laugh' | 'surprise' | 'sad' | 'angry' | 'shy' | 'sleepy'

const TAG_IDS: readonly MoodTagId[] = ['happy', 'laugh', 'surprise', 'sad', 'angry', 'shy', 'sleepy']

/** 标签 → 立绘动作 + moodState 增量(无标签的回复不产生增量,防漂移) */
export const MOOD_TAG_TABLE: Record<
  MoodTagId,
  { action: string; dValence: number; dEnergy: number }
> = {
  happy: { action: 'happy', dValence: 0.4, dEnergy: 0.2 },
  laugh: { action: 'laugh', dValence: 0.6, dEnergy: 0.4 },
  surprise: { action: 'surprise', dValence: 0, dEnergy: 0.4 },
  sad: { action: 'sad', dValence: -0.6, dEnergy: -0.3 },
  angry: { action: 'angry', dValence: -0.8, dEnergy: 0.4 },
  shy: { action: 'shy', dValence: -0.1, dEnergy: -0.2 },
  sleepy: { action: 'sleepy', dValence: -0.1, dEnergy: -0.6 },
}

/** 主格式 <mood:X>;大小写与空格容错 */
const TAG_RE = /<\s*mood\s*:\s*([a-zA-Z_-]+)\s*>/gi
/** 笔误形式 <X>:只认白名单词(如 <shy>),其余 <> 内容绝不能误吞(如 <think>) */
const TYPO_RE = /<\s*(happy|laugh|surprise|sad|angry|shy|sleepy)\s*>/gi

function normTag(v: string): MoodTagId | null {
  const t = v.trim().toLowerCase() as MoodTagId
  return TAG_IDS.includes(t) ? t : null
}

export interface MoodTagParse {
  /** 剥除全部标签形残渣后的正文(trim 过) */
  text: string
  /** 最后一个合法标签;null = 未输出或不在白名单 */
  tag: MoodTagId | null
}

/** 解析情绪标签:主格式优先,无主格式才认笔误形式;剥除在解析时一次完成 */
export function parseMoodTag(raw: string): MoodTagParse {
  const src = String(raw ?? '')
  let tag: MoodTagId | null = null
  for (const m of src.matchAll(TAG_RE)) {
    const t = normTag(m[1])
    if (t) tag = t
  }
  if (!tag) {
    for (const m of src.matchAll(TYPO_RE)) {
      const t = normTag(m[1])
      if (t) tag = t
    }
  }
  const text = src.replace(TAG_RE, '').replace(TYPO_RE, '').trim()
  return { text, tag }
}

/** 显示层兜底:任何聊天文本渲染/朗读前剥除标签形残渣(防历史/回放泄漏) */
export function stripMoodTag(text: string): string {
  return String(text ?? '').replace(TAG_RE, '').replace(TYPO_RE, '')
}

/** 回复 action 归一:白名单内原样,其余(含空/未知)回落 talk */
export function emotionActionOf(action: string | undefined | null): string {
  const a = String(action ?? '').trim()
  return TAG_IDS.some((t) => MOOD_TAG_TABLE[t].action === a) ? a : 'talk'
}

/** action → moodState 增量;无情绪动作(talk/未知)返回 null */
export function moodDeltaOfAction(
  action: string | undefined | null,
): { dValence: number; dEnergy: number } | null {
  const a = emotionActionOf(action)
  if (a === 'talk') return null
  const row = TAG_IDS.map((t) => MOOD_TAG_TABLE[t]).find((r) => r.action === a)
  return row ? { dValence: row.dValence, dEnergy: row.dEnergy } : null
}

/** plain 直答纪律块的标签规则(协议层静态文本,每轮随纪律注入) */
export const MOOD_TAG_RULE =
  '回复带有明显情绪时,在句末同一行最后追加一个情绪标签 <mood:X>' +
  '(X 只能取:happy/laugh/surprise/sad/angry/shy/sleepy);' +
  '情绪平淡的日常对话就不加,不要每句都带。' +
  '标签仅供系统识别,不要解释,也不要输出其他任何标记。'
