import type { DialogLine } from '../performer/player'
import { modeOf, type Mode } from '../performer/modes'

const ACTIONS = 'idle, talk, happy, angry, sad, surprise, shake, jump'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/** 组装 prompt：人设 + 输出协议 + 模式指令 + 上段结尾衔接 + 话题。
 *  人设/协议是所有模式共享的"父类公共代码"，模式差异来自 DialogMode.prompt。
 *  topicFixed = 用户手动锁定的主题:措辞升级为硬约束,防跑题 */
export function buildMessages(
  mode: Mode,
  topic: string,
  recentLines: DialogLine[],
  topicFixed?: boolean,
): ChatMessage[] {
  const persona = `角色设定：
- 甲（speaker 用 "A"）：精力充沛、爱吹牛、脑洞大、说话夸张
- 乙（speaker 用 "B"）：冷静毒舌、专拆台、话少但一针见血`

  const protocol = `输出协议（严格遵守）：
- 只输出一个 JSON 对象，不要输出任何其他文字
- 格式：{"dialog":[{"speaker":"A","text":"台词","action":"动作"},...]}
- speaker 只能是 "A" 或 "B"
- action 只能是这些词之一：${ACTIONS}
- 一段共 14~22 句，两人交替说话
- 每句口语化，不超过 25 个字`

  const history = recentLines.length
    ? `上一段的结尾（新的一段要自然衔接，不要重复内容）：\n${recentLines
        .slice(-4)
        .map((l) => `${l.speaker === 'A' ? '甲' : '乙'}：${l.text}`)
        .join('\n')}\n\n`
    : ''

  const topicText = topicFixed
    ? `本段话题（必须全程围绕此话题展开，不要偏题）：${topic}`
    : `本段话题：${topic}`

  return [
    {
      role: 'system',
      content: `你是一个桌面双人情景剧的编剧。${persona}\n\n${protocol}\n\n${modeOf(mode).prompt}`,
    },
    {
      role: 'user',
      content: `${history}${topicText}\n请输出这一段完整对话的 JSON。`,
    },
  ]
}
