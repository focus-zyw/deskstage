import type { DialogLine } from '../performer/player'
import { modeOf, type Mode } from '../performer/modes'
import { currentTimeSlot } from './timeAware'
import type { UserProfile } from '../storage/configStore'

const ACTIONS = 'idle, talk, happy, angry, sad, surprise, shake, jump'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/** 使用者上下文:画像(手填)+ 口味摘要 + 记忆事实(机器提取),由调用方组装后注入 */
export interface UserContext {
  profile?: UserProfile
  /** 口味摘要,如"减肥、上班摸鱼"(来自行为偏好统计) */
  taste?: string
  /** 记忆事实内容列表(pinned 优先) */
  facts?: string[]
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/** 把画像/口味/记忆事实渲染成一段"观众画像"文本,空字段自动省略 */
export function renderUserContext(ctx: UserContext): string {
  const p = ctx.profile
  const parts: string[] = []
  const bits: string[] = []
  if (p?.userName) bits.push(`称呼为"${p.userName}"`)
  if (p?.occupation) bits.push(`身份是${p.occupation}`)
  if (p?.likes) bits.push(`喜欢:${p.likes}`)
  if (p?.dislikes) bits.push(`不喜欢:${p.dislikes}`)
  if (bits.length) parts.push(`我们的观众朋友${bits.join(';')}。聊天中可以自然地带到这些(不要刻意每句都提)。`)
  if (p?.banTopics) parts.push(`雷区(绝对不要聊):${p.banTopics}。`)
  if (ctx.taste) parts.push(`观众最近爱听的话题:${ctx.taste}。`)
  if (ctx.facts?.length) parts.push(`你已经记住的关于观众的事:\n${ctx.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`)
  return parts.length ? `\n\n使用者画像：${parts.join(' ')}` : ''
}

/** 组装 prompt：人设 + 使用者画像 + 输出协议 + 模式指令 + 上段结尾衔接 + 话题。
 *  人设/协议是所有模式共享的"父类公共代码"，模式差异来自 DialogMode.prompt。
 *  topicFixed = 用户手动锁定的主题:措辞升级为硬约束,防跑题 */
export function buildMessages(
  mode: Mode,
  topic: string,
  recentLines: DialogLine[],
  topicFixed?: boolean,
  userInterests?: string,
  userCtx?: UserContext,
): ChatMessage[] {
  const persona = `角色设定：
- 甲（speaker 用 "A"）：精力充沛、爱吹牛、脑洞大、说话夸张，满嘴跑火车还特别得意，常用"我跟你说""好家伙"当口头禅
- 乙（speaker 用 "B"）：冷静毒舌、专拆台、话少但一针见血，惯用反问和吐槽拆穿甲的牛皮，偶尔冷幽默
- 两人是老搭档，互怼但有默契，节奏像传统相声里的逗哏和捧哏`

  const craft = `创作要求（这是喜剧，好笑比什么都重要）：
- 结构：开场两人快速入活 → 中段围绕话题至少抖出 2~3 个包袱 → 结尾留一个响底的包袱收束
- 包袱手法：三翻四抖（连续铺垫两次，第三次意外反转）、谐音梗、故意曲解、一本正经地胡说八道
- 甲负责铺和吹，乙负责戳破和翻包袱；反转要出人意料但回头看又合理
- 台词全部口语化，像真说话，不要书面语；允许"哎""嚯""好家伙""就这？"这类语气词
- 话题活化：给定的话题只是种子，要把它翻译成当下年轻人真实的生活场景——用具体的细节（真实感的app名、场景、行为习惯）、当代情绪和热词，让它一听就有共鸣，而不是干巴巴地围绕话题词打转`

  // 旧字段兜底:userCtx 未传时回退到 legacy userInterests
  const legacy = userInterests?.trim()
    ? `\n\n使用者画像：我们的观众朋友有以下兴趣爱好：${userInterests.trim()}。聊天中可以自然地偶尔聊到这些（不要刻意每句都提）。`
    : ''
  const profile = userCtx ? renderUserContext(userCtx) : legacy

  const slot = currentTimeSlot()
  const timeCtx = `\n\n现实时间：现在是${slot.label}，${slot.scene}。段子的场景和情绪可以贴合这个时间段。`

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
      content: `你是一位擅长传统相声和网络脱口秀的资深喜剧编剧,给桌面双人情景剧写段子。${persona}${profile}${timeCtx}\n\n${craft}\n\n${protocol}\n\n${modeOf(mode).prompt}`,
    },
    {
      role: 'user',
      content: `${history}${topicText}\n请输出这一段完整对话的 JSON。`,
    },
  ]
}
