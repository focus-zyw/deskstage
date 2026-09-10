import type { DialogLine } from '../performer/player'
import { modeOf, type Mode } from '../performer/modes'
import type { Relationship } from '../performer/modes/relationships'
import { currentTimeSlot } from './timeAware'
import { fullPersona, nameOf } from './persona'
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
  if (story?.gags.length) parts.push(`与本段话题相关的老梗:${story.gags.join(';')}。最多自然回收 1 个;接不上就不用,不得为了 callback 扭曲本段话题。`)
  if (story?.threads.length) parts.push(`与本段话题相关的未了结事件(适合时再了结):${story.threads.join(';')}。`)
  if (!parts.length) return ''
  parts.push('笑点素材只能来自本集场景卡和角色世界;观众的私人信息不是包袱。')
  return `\n\n角色世界（两人的共同经历）：${parts.join(' ')}`
}

/** 组装 prompt：人设 + 使用者画像 + 输出协议 + 模式指令 + 可选续聊上下文 + 话题。
 *  人设/协议是所有模式共享的"父类公共代码"，模式差异来自 DialogMode.prompt。
 *  topicFixed = 用户手动锁定的主题:措辞升级为硬约束,防跑题。
 *  relationship = 本集临时关系(可选):决定双方攻守姿态,写进场景卡
 *  interactionRecap = 互动账本摘录(可选):观众上集捣乱行为,注入为开场抱怨素材
 *  allowChoice/lastChoice = 观众抉择点开关与上集观众的选择(可选) */
export function buildMessages(
  mode: Mode,
  topic: string,
  recentLines: DialogLine[],
  topicFixed?: boolean,
  userInterests?: string,
  userCtx?: UserContext,
  relationship?: Relationship,
  interactionRecap?: string,
  allowChoice?: boolean,
  lastChoice?: string,
  /** 连续剧情节拍(可选):本集是多集剧情线的一拍,其他话题铺垫让位于它 */
  arc?: { title: string; hook: string; stage: number },
  /** 环境感知语境(可选):电量/前台应用/连续工作时长,已在引擎侧做过冷却 */
  envNote?: string,
  /** 场外角色乱入(可选):身份名,以电话/画外音形式出现,打破双人固定结构 */
  guest?: string,
  /** 长期关系底色(可选):信任/摩擦的当前状态描述 */
  bondNote?: string,
  /** 只有显式“续聊”才携带上一段原始台词；新主题默认 false，避免内容串味 */
  continueFromPrevious = false,
): ChatMessage[] {
  const persona = fullPersona()

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

  const bondCtx = bondNote?.trim()
    ? `

长期关系背景（影响相互态度与语气,不是本集主要矛盾）：${bondNote.trim()}。`
    : ''

  const recap = interactionRecap?.trim()
    ? `另外,上一集演出时观众没少捣乱:${interactionRecap.trim()}。开场先让两人自然地抱怨一下这个观众,再进入正题。

`
    : ''

  const relCtx = relationship
    ? `\n\n本集关系状态（必须遵守,写进场景卡的 relationship 字段）：${relationship.label}——${relationship.desc}。关系只改变本集攻守,甲乙的基础性格与说话风格不变。`
    : ''

  // 连续剧情节拍:本集是多集剧情线的一拍,话题让位,结尾留下一拍的钩子
  const arcCtx = arc
    ? `\n\n连续剧情（本集属于多集剧情线的一拍,话题铺垫让位于它）：《${arc.title}》已演出 ${arc.stage} 拍。本拍必须演出的进展：${arc.hook}。结尾不收死,留下引向下一拍的新悬念/新进展。`
    : ''

  // 场外角色乱入:电话/门外画外音形式,只占 C 的台词,不抢甲乙的场景卡
  const guestRule = guest
    ? `

场外角色乱入(本段允许):${guest} 以“打电话/门外喊话”的画外音形式乱入 1~3 句,出现位置在中段或临近结尾;这些台词的 speaker 用 "C";C 不进场景卡,只搅局不接管剧情。`
    : ''

  // 观众抉择点:由调用方掷骰决定(约 30% 的集数),中段安排一次站队,两分支各 3~5 句,结尾汇合同一包袱
  const choiceRule = allowChoice
    ? '\n\n观众互动(本段必须包含,恰好在剧情冲突最激烈的中段安排一次):在 dialog 数组中插入恰好一个抉择对象:{"choice":{"prompt":"向观众提出的站队问题,15字内","options":[{"id":"<英文短id>","label":"<中文选项>"},{"id":"<英文短id2>","label":"<中文选项2>"}]}},共两个选项;choice 之后的每句台词都必须额外带 "branch":"<所支持选项id>" 字段,两个分支各 3~5 句,两个分支结尾收同一个底包袱;两个选项可以都不是好选择,喜剧效果更好。其余集数不要输出 choice。'
    : ''

  const lastChoiceText = lastChoice?.trim()
    ? `\n上集观众做出了选择:"${lastChoice.trim()}"(可在开场回应这个选择)。`
    : ''

  const protocol = `输出协议（严格遵守）：
- 只输出一个 JSON 对象，不要输出任何其他文字
- 先写场景卡再写台词，格式：{"card":{"relationship":"关系标签","scene":"具体场景一句话","goalA":"甲想要什么","goalB":"乙想要什么","secret":"被隐瞒的关键信息(一方或双方知道)","escalation":["节拍1","节拍2","节拍3"],"callback":"结尾回收的本集铺垫"},"dialog":[{"speaker":"A","text":"台词","action":"动作"},...]}
- dialog 必须逐拍实现 card.escalation；secret 在结尾反转揭晓；callback 必须回收本集前面埋的线
- speaker 只能是 "A" 或 "B"
- action 只能是这些词之一（禁止用 card 的字段名或其他词）：${ACTIONS}
- 一段共 14~22 句，两人交替说话
- 每句口语化，不超过 25 个字
- 台词可在 text/action 外带可选演出字段(用在该用的地方,没有就省略,别每句都加)：
  "listenerAction":听者此刻的反应动作(词表同 action)、"delivery":"deadpan|excited|slow"(面瘫/兴奋/慢条斯理)、"pauseBefore":毫秒(包袱前 300~600 蓄势)、"pauseAfter":毫秒(只给响底的最后一句,900~1500 留白)
- delivery 使用纪律:默认普通语气(不加字段);同一角色连续同种强情绪最多两句;excited 只用于冲突升级和抖包袱;slow 只用于铺垫、犹豫和揭底`

  const envBlock = envNote?.trim()
    ? `现实环境(可作为素材自然带入,要有喜剧感,别播新闻):${envNote.trim()}。
`
    : ''

  const history = continueFromPrevious && recentLines.length
    ? `上一段的结尾（新的一段要自然衔接，不要重复内容）：\n${recentLines
        .slice(-4)
        .map((l) => `${l.speaker === 'A' ? nameOf('A') : nameOf('B')}：${l.text}`)
        .join('\n')}\n\n`
    : ''

  const topicText = topicFixed
    ? `本段话题（必须全程围绕此话题展开，不要偏题）：${topic}`
    : `本段话题：${topic}`

  return [
    {
      role: 'system',
      content: `你是一位擅长传统相声和网络脱口秀的资深喜剧编剧,给桌面双人情景剧写段子。${persona}${bondCtx}${relCtx}${arcCtx}${guestRule}${profile}${storyCtx}${timeCtx}${choiceRule}\n\n${craft}\n\n${protocol}\n\n${modeOf(mode).prompt}`,
    },
    {
      role: 'user',
      content: `${lastChoiceText}${recap}${envBlock}${history}${topicText}\n请先定场景卡,再输出这一段完整对话的 JSON。`,
    },
  ]
}
