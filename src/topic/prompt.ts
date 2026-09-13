// AI 候选发现的提示词组装:输入只含类别级语境(兴趣关键词/最近话题标题+标签/
// 粗时段/前台应用类别/模式基调/雷区/跳跃距离),原始屏幕、窗口标题、剪贴板
// 永不进入本链路。输出协议:{"cards":[{title,hook,category,tags,bridge?}]}
import type { ChatMessage } from '../engine/promptBuilder'
import type { TopicDistance } from './types'

export interface DiscoveryInput {
  interests: readonly string[]
  /** 最近话题(最多 20 条:标题 + 标签),让模型避开它们 */
  recentTopics: readonly { title: string; tags?: readonly string[] }[]
  /** 粗粒度时段:deep-night/morning/afternoon/evening */
  timeBucket: string
  /** 前台应用类别(editor/browser/terminal/media;null=不可用) */
  envCategory: string | null
  /** 模式基调提示(可选,如"相声互怼" / "日常闲聊") */
  toneHint?: string
  /** 雷区原文(逗号/顿号分隔) */
  banText: string
  distance: TopicDistance
}

const DISTANCE_TEXT: Record<TopicDistance, string> = {
  near: '贴近日常近处:与常见话题同域,但切口要新',
  medium: '中等跳跃:从日常出发,联想一个有点意外但能接上的领域',
  far: '远距离:跨到一个天马行空的领域,但要能落地成具体生活场景',
}

const TIME_TEXT: Record<string, string> = {
  'deep-night': '深夜',
  morning: '早晨',
  afternoon: '午后',
  evening: '晚间',
}

/** 每个候选必须满足的六条生成约束(V2 §5),逐条写进 system prompt */
export function buildDiscoveryMessages(input: DiscoveryInput): ChatMessage[] {
  const recent = input.recentTopics
    .slice(-20)
    .map((t) => `- ${t.title}${t.tags?.length ? `（${t.tags.join('/')}）` : ''}`)
    .join('\n')
  const system = [
    '你是桌面虚拟角色的话题策划。任务:为甲乙丙三人的情景喜剧扩充候选话题池。',
    '只输出一个 JSON 对象,不要解释、不要代码围栏,格式:',
    '{"cards":[{"title":"话题标题","hook":"本集要聊的具体矛盾","category":"life|work|social|emotion|technology|health|consumption|imagination","tags":["标签1","标签2"],"bridge":"从别的话题转到它的自然衔接句(可选)"}]}',
    '每个候选必须同时满足:',
    '1. 有一个具体生活场景(有画面、有人物处境),不能只是名词或概念;',
    '2. 有一个可产生分歧的问题(甲乙能有两种立场);',
    '3. 标题本身就要有戏剧性(像段子题目),而不是报事实;',
    '4. 与"最近聊过的话题"核心矛盾不同,不得换个说法重复;',
    '5. 不碰雷区,不涉及具体真实个人隐私;',
    '6. 只输出结构化 JSON。',
    `本次生成 6 张候选;跳跃距离:${DISTANCE_TEXT[input.distance]}。`,
    `时段语境:${TIME_TEXT[input.timeBucket] ?? '日常'}${input.envCategory ? `;观众此刻前台开着${input.envCategory === 'editor' ? '代码编辑器' : input.envCategory === 'browser' ? '浏览器' : input.envCategory === 'terminal' ? '终端命令行' : '音视频播放器'}` : ''}(只作氛围参考,不要聊"用户正在用XX")。`,
    input.toneHint ? `模式基调参考:${input.toneHint}。` : '基调参考:日常吐槽与相声互怼皆可。',
    input.banText.trim() ? `雷区(绝对不要碰,出现即作废):${input.banText.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const userParts = [
    input.interests.length ? `观众感兴趣的事:${input.interests.join('、')}。可从中取材,但切口必须新。` : '无已知兴趣。',
    input.recentTopics.length ? `最近聊过的话题(禁止重复或换皮):\n${recent}` : '暂无历史话题。',
    '请生成 6 张候选话题卡。',
  ]
  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.filter(Boolean).join('\n\n') },
  ]
}

/** 从模型输出里抠 cards 数组(容忍代码围栏与混杂文本);找不到返回空数组 */
export function parseDiscoveryCards(raw: string): unknown[] {
  try {
    const obj = JSON.parse(raw) as { cards?: unknown }
    if (Array.isArray(obj.cards)) return obj.cards
  } catch {
    // 落到正则兜底
  }
  const m = raw.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { cards?: unknown }
      if (Array.isArray(obj.cards)) return obj.cards
    } catch {
      // 非法输出
    }
  }
  return []
}
