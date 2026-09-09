import type { DialogLine } from '../performer/player'
import { modeOf, type Mode } from '../performer/modes'
import type { Relationship } from '../performer/modes/relationships'
import { currentTimeSlot } from './timeAware'
import type { UserProfile } from '../storage/configStore'

const ACTIONS = 'idle, talk, happy, laugh, shy, sleepy, wave, thinking, angry, sad, surprise, shake, jump'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/** 使用者上下文:画像(手填)+ 口味摘要 + 记忆事实(机器提取) + 角色世界,由调用方组装后注入 */
export interface UserContext {
  profile?: UserProfile
  /** 口味摘要,如"减肥、上班摸鱼"(来自行为偏好统计) */
  taste?: string
  /** 记忆事实内容列表(pinned 优先) */
  facts?: string[]
  /** 角色世界:两人之间的老梗与未了结事件(与观众隐私无关,适合制造 callbacks) */
  story?: { gags: string[]; threads: string[] }
}

/** 观众语境:称呼/画像/口味/记忆事实。观众资料只用于亲切感,禁止当包袱素材 */
export function renderAudienceContext(ctx: UserContext): string {
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
  if (ctx.facts?.length) parts.push(`你已经记住的关于观众的事(只用于称呼和亲切感语境,不得作为嘲讽、秘密或包袱素材):\n${ctx.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`)
  return parts.length ? `\n\n使用者画像：${parts.join(' ')}` : ''
}

/** 角色世界:两人之间的老梗/未了结事件。这是笑点 callback 的唯一合法来源 */
export function renderStoryContext(story?: UserContext['story']): string {
  const parts: string[] = []
  if (story?.gags.length) parts.push(`可回收的老梗(最多自然回收 1 个,别强行):${story.gags.join(';')}。`)
  if (story?.threads.length) parts.push(`未了结的事件(适合在包袱里了结):${story.threads.join(';')}。`)
  if (!parts.length) return ''
  parts.push('笑点素材只能来自本集场景卡和角色世界;观众的私人信息不是包袱。')
  return `\n\n角色世界（两人的共同经历）：${parts.join(' ')}`
}

/** 组装 prompt：人设 + 使用者画像 + 输出协议 + 模式指令 + 上段结尾衔接 + 话题。
 *  人设/协议是所有模式共享的"父类公共代码"，模式差异来自 DialogMode.prompt。
 *  topicFixed = 用户手动锁定的主题:措辞升级为硬约束,防跑题。
 *  relationship = 本集临时关系(可选):决定双方攻守姿态,写进场景卡 */
export function buildMessages(
  mode: Mode,
  topic: string,
  recentLines: DialogLine[],
  topicFixed?: boolean,
  userInterests?: string,
  userCtx?: UserContext,
  relationship?: Relationship,
): ChatMessage[] {
  const persona = `角色设定：
- 甲（speaker 用 "A"）：精力充沛、爱吹牛、脑洞大、说话夸张，满嘴跑火车还特别得意，常用"我跟你说""好家伙"当口头禅
- 乙（speaker 用 "B"）：冷静毒舌、专拆台、话少但一针见血，惯用反问和吐槽拆穿甲的牛皮，偶尔冷幽默
- 两人是老搭档，互怼但有默契，节奏像传统相声里的逗哏和捧哏`

  // 手法说教刻意做减法:结构/节拍由场景卡的 escalation 承担,避免固定套路疲劳
  const craft = `创作要求（这是喜剧，好笑比什么都重要）：
- 场景卡的 escalation 就是包袱节拍：前一拍铺垫、后一拍意外反转，最后一句必须是响底的包袱收束
- secret 是反转的底气：揭晓时要"出人意料但回头看合理"
- callback 是本集自己的梗：结尾回收前面埋的线，形成"老观众才懂"的呼应
- 台词全部口语化，像真说话，不要书面语；允许"哎""嚯""好家伙""就这？"这类语气词
- 关系决定说法：按本集关系状态写出"想说不敢说/嘴硬/试探/讨好"这些姿态差异，不要俩人从头吵到尾
- 话题活化：话题只是种子，把它翻译成当下年轻人真实的生活场景——具体的 app 名、场景、行为习惯、当代情绪，不要干巴巴围绕话题词打转`

  // 旧字段兜底:userCtx 未传时回退到 legacy userInterests
  const legacy = userInterests?.trim()
    ? `\n\n使用者画像：我们的观众朋友有以下兴趣爱好：${userInterests.trim()}。聊天中可以自然地偶尔聊到这些（不要刻意每句都提）。`
    : ''
  const profile = userCtx ? renderAudienceContext(userCtx) : legacy
  const storyCtx = userCtx ? renderStoryContext(userCtx.story) : ''

  const slot = currentTimeSlot()
  const timeCtx = `\n\n现实时间：现在是${slot.label}，${slot.scene}。段子的场景和情绪可以贴合这个时间段。`

  const relCtx = relationship
    ? `\n\n本集关系状态（必须遵守,写进场景卡的 relationship 字段）：${relationship.label}——${relationship.desc}。关系只改变本集攻守,甲乙的基础性格与说话风格不变。`
    : ''

  const protocol = `输出协议（严格遵守）：
- 只输出一个 JSON 对象，不要输出任何其他文字
- 先写场景卡再写台词，格式：{"card":{"relationship":"关系标签","scene":"具体场景一句话","goalA":"甲想要什么","goalB":"乙想要什么","secret":"被隐瞒的关键信息(一方或双方知道)","escalation":["节拍1","节拍2","节拍3"],"callback":"结尾回收的本集铺垫"},"dialog":[{"speaker":"A","text":"台词","action":"动作"},...]}
- dialog 必须逐拍实现 card.escalation；secret 在结尾反转揭晓；callback 必须回收本集前面埋的线
- speaker 只能是 "A" 或 "B"
- action 只能是这些词之一（禁止用 card 的字段名或其他词）：${ACTIONS}
- 一段共 14~22 句，两人交替说话
- 每句口语化，不超过 25 个字
- 台词只写 text/action 两个字段,不要附加任何其他字段`

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
      content: `你是一位擅长传统相声和网络脱口秀的资深喜剧编剧,给桌面双人情景剧写段子。${persona}${relCtx}${profile}${storyCtx}${timeCtx}\n\n${craft}\n\n${protocol}\n\n${modeOf(mode).prompt}`,
    },
    {
      role: 'user',
      content: `${history}${topicText}\n请先定场景卡,再输出这一段完整对话的 JSON。`,
    },
  ]
}
