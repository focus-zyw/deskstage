import type { DialogLine } from '../performer/player'
import type { Mode } from '../performer/scripts'

const ACTIONS = 'idle, talk, happy, angry, sad, surprise, shake, jump'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/** 组装 prompt：人设 + 输出协议 + 模式指令 + 上段结尾衔接 + 话题 */
export function buildMessages(
  mode: Mode,
  topic: string,
  recentLines: DialogLine[],
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

  const modeText =
    mode === 'crosstalk'
      ? '当前是【相声】模式：甲是逗哏（负责铺陈和抖包袱），乙是捧哏（用"哦？""好家伙""嗐！"这类短句接话、拆台）。结构：开头垫话 1~2 句，中间正活层层展开，最后 1 句必须是收底的包袱。'
      : '当前是【日常】模式：两个朋友自然闲聊，有来有回，情绪有起伏（好奇、吐槽、小争执、和解），像真人聊天一样。'

  const history = recentLines.length
    ? `上一段的结尾（新的一段要自然衔接，不要重复内容）：\n${recentLines
        .slice(-4)
        .map((l) => `${l.speaker === 'A' ? '甲' : '乙'}：${l.text}`)
        .join('\n')}\n\n`
    : ''

  return [
    {
      role: 'system',
      content: `你是一个桌面双人情景剧的编剧。${persona}\n\n${protocol}\n\n${modeText}`,
    },
    {
      role: 'user',
      content: `${history}本段话题：${topic}\n请输出这一段完整对话的 JSON。`,
    },
  ]
}
