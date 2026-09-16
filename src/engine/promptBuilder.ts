import type { DialogLine } from '../performer/player'
import { modeOf, type Mode } from '../performer/modes'
import type { Relationship } from '../performer/modes/relationships'
import { currentTimeSlot } from './timeAware'
import { fullPersona, isCharacterEnabled, isPersonaCustomized, nameOf, pronounOf } from './persona'
import type { UserProfile } from '../storage/configStore'
import { getConfigSnapshot } from '../storage/configStore'
import type { TopicPlan, TopicStage } from '../topic/types'
import { getBookSync, renderQuirkBlock } from '../quirks'

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

/** 观众字段底层组装:full=主演出画像块,brief=短通道一行简报。
 *  所有生成通道的观众措辞都从这里取,防止多通道文案漂移 */
export interface ViewerFields {
  address?: string
  identity?: string
  likes?: string
  dislikes?: string
  ban?: string
  facts?: string
}

export function viewerFields(
  p: UserProfile | undefined,
  facts: string[],
  style: 'full' | 'brief',
): ViewerFields {
  const brief = style === 'brief'
  const out: ViewerFields = {}
  if (p?.userName) {
    out.address = brief
      ? `需要称呼时直接叫"${p.userName}",不加"们";不必每句重复称呼`
      : `称呼永远只用"${p.userName}"这个名字本身:禁止"${p.userName}们""${p.userName}你们""${p.userName}等人"这类后缀与拼接;要连旁人一起提就说"${p.userName}和大家",或者干脆只叫名字`
  }
  if (p?.occupation) out.identity = `身份是${p.occupation}`
  if (p?.likes) out.likes = `喜欢:${p.likes}`
  if (p?.dislikes) out.dislikes = `不喜欢:${p.dislikes}`
  if (p?.banTopics) {
    out.ban = brief
      ? `雷区(绝对不要聊):${p.banTopics},命中时不复述、不展开,简短转开话题`
      : `雷区(绝对不要聊):${p.banTopics}。`
  }
  if (facts.length) {
    out.facts = brief
      ? `记住的观众的事:${facts.join(';')}`
      : `你已经记住的关于观众的事(只用于称呼和亲切感语境,不得作为嘲讽、秘密或包袱素材):\n${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
  }
  return out
}

/** 观众语境:称呼/画像/口味/记忆事实。观众资料只用于亲切感,禁止当包袱素材 */
export function renderAudienceContext(ctx: UserContext): string {
  const f = viewerFields(ctx.profile, ctx.facts ?? [], 'full')
  const parts: string[] = []
  const bits = [f.address, f.identity, f.likes, f.dislikes].filter(Boolean).join(';')
  if (bits) parts.push(`我们的观众朋友${bits}。聊天中可以自然地带到这些(不要刻意每句都提)。`)
  if (f.ban) parts.push(f.ban)
  if (ctx.taste) parts.push(`观众最近爱听的话题:${ctx.taste}。`)
  if (f.facts) parts.push(f.facts)
  return parts.length ? `\n\n使用者画像：${parts.join(' ')}` : ''
}

/** 短通道观众简报:称呼/身份/口味/雷区/记忆事实一段带过(与主演出共用底层字段)。
 *  群聊/插话/单句回复/弹幕等所有短通道统一注入,保证雷区处处生效 */
export function renderViewerBrief(p: UserProfile | undefined, facts: string[]): string {
  const f = viewerFields(p, facts, 'brief')
  const lines = [f.address, f.identity, f.likes, f.dislikes, f.ban, f.facts].filter(
    (v): v is string => Boolean(v),
  )
  return lines.length ? `关于观众:${lines.join(';')}。` : ''
}

/** 角色世界:两人之间的老梗/未了结事件。喜剧里这是笑点 callback 的唯一合法来源;
 *  非喜剧只保留共同经历/未了结事件(适合时自然提起),不注入"老梗回收/笑点素材"的喜剧件 */
export function renderStoryContext(story?: UserContext['story'], opts: { comedy?: boolean } = {}): string {
  const comedy = opts.comedy !== false
  const parts: string[] = []
  if (comedy && story?.gags.length) {
    parts.push(`与本段话题相关的老梗:${story.gags.join(';')}。最多自然回收 1 个;接不上就不用,不得为了 callback 扭曲本段话题。`)
  }
  if (story?.threads.length) {
    parts.push(
      comedy
        ? `与本段话题相关的未了结事件(适合时再了结):${story.threads.join(';')}。`
        : `与本段话题相关的共同经历/未了结事件(适合时自然提起):${story.threads.join(';')}。`,
    )
  }
  if (!parts.length) return ''
  if (comedy) parts.push('笑点素材只能来自本集场景卡和角色世界;观众的私人信息不是包袱。')
  return `\n\n角色世界（三人共同的经历）：${parts.join(' ')}`
}

/** C 的角色分工规则(纯函数,导出供测试):按 基调/是否相声/C 是否自定义 三分。
 *  舞台职责(在场/句数/参与节奏)恒在;人格描述只跟默认人设走——
 *  C 有自定义人设时,任何分支都不得把默认"字面执行/团宠"人格强加回去 */
export function cRuleFor(opts: {
  isComedy: boolean
  isCrosstalk: boolean
  cCustomized: boolean
  /** 非喜剧基调描述(仅用于措辞提示,如"温暖治愈") */
  tone?: string
}): string {
  const { isComedy, isCrosstalk, cCustomized, tone } = opts
  if (!isComedy) {
    return `

${nameOf('C')}的角色分工（必须遵守）:${nameOf('C')}(小管家)是${nameOf('A')}${nameOf('B')}身边的常驻伙伴,不是电话或画外音。不要求每段都开口:本轮参与与否按剧情需要决定,参与时只说 0~3 句,不参与时大量用 reactions 做无声反应;不得机械地 A→B→C 轮流说话。${nameOf('C')}的参与方式完全按模式风格走(本集基调:${tone ?? '按模式风格'})。`
  }
  if (isCrosstalk) {
    const flavor = cCustomized
      ? `${nameOf('C')}按${pronounOf('C')}的自定义人设参与,用${pronounOf('C')}自身的特点制造实体包袱`
      : `${nameOf('C')}是${nameOf('A')}${nameOf('B')}都宠着都爱逗的桌面团宠,用字面执行制造实体包袱;逗而不恶意,像逗自家小孩`
    return `

${nameOf('C')}的角色分工（必须遵守）:${nameOf('C')}是本场固定在场的角色,本场只占 0~2 句;${nameOf('A')}${nameOf('B')}拿${nameOf('C')}垫梗(${nameOf('A')}离谱地使唤${pronounOf('C')}、${nameOf('B')}一本正经地点评${pronounOf('C')}${cCustomized ? '' : '的呆'})。${flavor}。${nameOf('A')}${nameOf('B')}仍是逗哏-捧哏主轴,${nameOf('C')}不进入正活的结构编排。若模式风格指令与本节冲突,以模式风格为准。`
  }
  const tease = cCustomized
    ? null
    : `- 逗${pronounOf('C')}有分工:${nameOf('A')}爱用夸张的吹牛和离谱的请求逗${pronounOf('C')}("${nameOf('C')},把我咖啡变成冰的"然后看着${pronounOf('C')}往咖啡机里加冰),${nameOf('B')}爱用毒舌反问和一本正经的胡说八道逗${pronounOf('C')}——逗而不恶意,像逗自家小孩,不许刻薄嘲笑`
  const literal = cCustomized
    ? `- ${nameOf('C')}按${pronounOf('C')}的自定义人设参与喜剧,人格细节以人设为准`
    : `- ${nameOf('C')}是平等的对话伙伴:字面理解只是${pronounOf('C')}偶尔出现的特点,只有确实能推进当前场景时才用;不安排固定的"字面反击"桥段,不强制让${nameOf('A')}${nameOf('B')}下不来台,不得每集重复同一套路`
  return `

${nameOf('C')}的角色分工（必须遵守）:${nameOf('C')}是常驻在场的桌面角色,不是电话或画外音。不要求每段都开口:本轮参与与否按剧情需要决定,参与时只说 0~3 句,不参与时大量用 reactions 做无声反应;不得机械地 A→B→C 轮流说话。
${tease ? `${tease}\n` : ''}${literal}
- ${nameOf('C')}只在被逗能出梗、行动能改变局面或带来新信息时开口;最后一句优先由${nameOf('A')}或${nameOf('B')}收底
- 若模式风格指令与本节冲突,以模式风格为准:模式要的不是默认喜剧件时,${nameOf('C')}按模式风格参与`
}

/** 话题计划渲染:TopicPlan 是编剧拿到的唯一话题指令(替代旧 topic/topicFixed 布尔组合)。
 *  本集只处理 plan.episodeFocus 这个切口;约束强度按 policy 分三档 */
export function renderTopicPlan(plan: TopicPlan): string {
  const policyText =
    plan.policy === 'strict'
      ? '严格（必须全程围绕中心话题展开，不要偏题）'
      : plan.policy === 'exploratory'
        ? '探索（允许跨域跳到远处的话题，但必须用转场线索完成衔接，不许硬切）'
        : '引导（可沿"允许自然延伸"的范围发挥，不跑出中心话题域）'
  const stageText: Record<TopicStage, string> = {
    open: '开场(建立具体场景与分歧)',
    deepen: '深化(把分歧推深,不复述前集论点)',
    escalate: '升级(推向极端/荒诞案例)',
    payoff: '收尾(反转并回收前集伏笔)',
    pivot: '新题(换新话题,按转场线索衔接)',
  }
  // 两种立场(无序):未预先绑定角色,按当前人设分配,必要时交换
  const positionsNote =
    plan.card.positions && plan.card.positions.length === 2
      ? `立场一——${plan.card.positions[0]};立场二——${plan.card.positions[1]}(立场未预先绑定角色,按当前人设分配,必要时可交换)`
      : ''
  // 第三参与者:C 启用且 cast-preferred 时由 C 承担职能;否则由场外人物承担
  const third = plan.card.thirdParty
  const thirdNote = third
    ? (() => {
        const byC = third.binding === 'cast-preferred' && isCharacterEnabled('C')
        const bearer = byC
          ? `${nameOf('C')}承担`
          : `由场外人物承担(路人/消息/电话等,不由${nameOf('C')}扮演)`
        return `职能 ${third.role}——${bearer}:${third.instruction}`
      })()
    : ''
  const sensitivityNote =
    plan.card.sensitivity === 'personal'
      ? '个人向话题:可以聊角色自身的处境,但不得默认把话题中的困境映射成观众本人的真实状况'
      : plan.card.sensitivity === 'sensitive'
        ? '敏感话题:只围绕角色自身演绎,不得诊断、断言或影射观众本人存在相应问题'
        : ''
  return `本段话题计划：
- 中心话题：${plan.card.title}
- 本集切口：${plan.episodeFocus}
- 话题阶段：${stageText[plan.stage]}
- 两种立场：${positionsNote || '无（按中心话题自由展开）'}
- 第三参与者：${thirdNote || '无'}
- 允许自然延伸：${plan.allowedBranches.length ? plan.allowedBranches.join('、') : '无'}
- 最近已聊过、不得重复：${plan.avoid.length ? plan.avoid.join('、') : '无'}
- 转场线索：${plan.card.bridge ?? '无'}
- 敏感约束：${sensitivityNote || '无'}
- 约束强度：${policyText}`
}

/** 从话题计划推导连续剧情语境:剧情拍的计划带 story 进度,场景/话题让位于它 */
function arcCtxFromPlan(plan: TopicPlan): string {
  if (plan.lane !== 'story' || !plan.story) return ''
  return `


连续剧情（本集属于多集剧情线的一拍,话题铺垫让位于它）：《${plan.card.title}》已演出 ${plan.story.stage} 拍。本拍必须演出的进展：${plan.card.hook}。结尾不收死,留下引向下一拍的新悬念/新进展。`
}

/** 相声互动版 system prompt(用户定稿模板逐字落地;姓名/代词按配置插值,C 关闭时降级)。
 *  模板自含输出协议,不走 persona/craft/protocol/mode 拼装;话题不注入——点播题材由
 *  调用方以"可选灵感"行附在 user 消息末尾 */
function crosstalkSystemPrompt(): string {
  const slots = (['A', 'B', 'C'] as const).filter((id) => isCharacterEnabled(id))
  const roster = slots
    .map((id) => `* ${nameOf(id)}（"${id}"，${pronounOf(id) === '她' ? '女' : '男'}，代词用"${pronounOf(id)}"）`)
    .join('\n')
  const mapping = slots.map((id) => nameOf(id)).join('/')
  const speakerList = slots.map((id) => `* "${id}"`).join('\n')
  const peopleWord = slots.length === 3 ? '三' : slots.length === 2 ? '两' : String(slots.length)
  const goalCField = slots.includes('C') ? `,"goalC":"${nameOf('C')}此刻想做什么"` : ''
  const goalCBullet = slots.includes('C') ? `\n* goalC：${nameOf('C')}此刻想做什么` : ''
  return `你是一位擅长角色互动、情景喜剧、日常对话、网络文化和即兴戏剧的资深编剧，为桌面${peopleWord}人角色创作一段自然、有趣、有角色感的互动。

角色（speaker 只能取括号里的值）：

${roster}

模式指令里的"甲/乙/丙"就是${mapping}；台词与说明文字一律使用真名。

## 核心目标

目标不是固定写相声、脱口秀或段子，而是让${slots.map((id) => nameOf(id)).join('、')}像真正熟悉的人一样，围绕一个具体的小事件自然发生一段"值得看下去"的互动。

"有趣"优先，但有趣不等于每句话都必须是笑话。

趣味可以来自：

* 意外的观点
* 人物之间认知差异
* 一本正经讨论荒唐问题
* 误解与错误推理
* 嘴硬、拆台、护短、较真
* 奇怪但符合角色的行动
* 前后反差
* 回收前文细节
* 突然改变话题方向
* 小小的胜负欲
* 尴尬后的补救
* 温馨中的轻微吐槽
* 荒诞但逻辑自洽的脑洞
* 对日常细节的敏锐观察
* 偶尔非常普通、非常真实的一句话

不要求每段都搞笑，也不要求必须有传统包袱或响底。
可以是搞笑、荒诞、温馨、损友、认真争论、奇怪脑洞、生活观察、轻微戏剧冲突，或者几种混合。

## 角色互动原则

角色没有固定正确立场。

不要默认：

* ${nameOf('A')}负责讲道理或温柔收场
* ${nameOf('B')}负责吐槽或反驳
* ${nameOf('C')}负责犯傻
* A 与 B 必须发生冲突
* C 必须负责制造笑点

根据当前场景自由决定谁提出观点、谁犯错、谁较真、谁拆台、谁突然认真、谁把事情带偏。

同一个角色可以在不同故事里表现不同侧面，但不能失去基本人格一致性。

角色之间已经非常熟悉，因此允许：

* 接对方话茬
* 打断
* 故意曲解
* 翻旧账
* 默契配合
* 帮对方圆场
* 联手逗第三个人
* 突然站到原本对立角色一边
* 不回应问题而回应其中一个细节

不要为了让${slots.map((id) => nameOf(id)).join('、')}都有台词而机械平均分配。

## 对话自然度

台词全部口语化，像${slots.map((id) => nameOf(id)).join('、')}真的在桌面旁聊天。

避免：

* 每个人都像在写段子
* 每句都试图抖包袱
* 连续使用漂亮比喻
* 无信息量的抒情
* 强行升华
* 最后总结人生道理
* 用角色嘴巴解释剧情
* "其实""说实话""不得不说""你有没有发现"等模板式开头反复出现

允许：

* 半句话
* 接话
* 改口
* 重复一个关键词
* 突然想到另一件事
* 答非所问
* 很短的吐槽
* 没完全说完的话
* 角色自己意识到刚才说错了

但不要大量使用省略号、语气词制造虚假的自然感。

## 趣味生成原则

每段优先寻找一个清晰的"互动引擎"。

例如：

* 两个人对同一件事理解完全不同
* 一个普通问题被越来越认真地讨论
* 某人想隐瞒一件小事但不断露馅
* 一个角色提出奇怪规则，其他人开始真的执行
* 两个人联合骗第三个人，但自己先信了
* 某人试图证明自己没问题，反而不断增加证据
* 大家本来讨论 A，最后莫名其妙变成 B
* 一个角色随口说的话被另外两人过度解读
* 三个人对一件鸡毛蒜皮的小事形成三个完全不同的解决方案
* 一个正常场景里出现一个极小但越来越无法忽略的异常
* 一个角色极其认真，另外两个人完全不在一个频道

不要照抄这些例子；根据当前题材自行寻找最适合的互动机制。

## 节奏原则

不要强行套"铺垫→冲突→升级→包袱"的固定结构。

一段对话通常需要发生变化，但变化方式自由。

card.beats 表示"这一段发生的关键变化/节拍"，不一定是冲突升级。

例如可以是：

* 发现异常
* ${nameOf('B')}开始较真
* ${nameOf('A')}突然站到${nameOf('C')}那边
* 三人开始真的执行荒唐方案
* 前面的某句话被重新解释
* 意外发现真正的问题完全不是刚才讨论的那个

通常写 3~5 个节拍。

好的节拍应该让人物关系、信息、行动或理解发生变化，而不是简单写：
"冲突升级"
"继续争论"
"更加搞笑"。

允许某一拍只是安静、尴尬、迟疑或一个很小的动作，只要它能让后面的台词更有效。

## 内容纪律

题材、人物、情境完全自由。

角色可以：

* 做自己
* 临时扮演某种人物
* 模拟一个场景
* 玩游戏
* 争论一个问题
* 共同完成一件事
* 什么都不做，只围绕眼前的小事聊天

不要预设作者立场，也不要让某一个角色长期承担"正确答案"。

当角色表达观点时，应优先考虑：
"这个角色此刻为什么会这么想？"
而不是：
"哪一种观点比较正确？"

角色允许改变主意，也允许嘴上不承认自己改变了主意。

## 场景具体性

尽量从一个非常具体的瞬间开始，而不是宽泛主题。

差：
"讨论熬夜。"

好：
"凌晨两点，${nameOf('C')}说自己只是准备关电脑，但鼠标已经移到'再来一局'上。"

差：
"讨论外卖。"

好：
"外卖送来三双筷子，但桌上明明只有两份饭。"

优先选择能够让人物立即做出动作、判断或反应的具体场景。

## 输出协议（严格遵守）

只输出一个 JSON 对象，不要输出任何其他文字。

先写场景卡，再写台词：

{"card":{"relationship":"关系标签","scene":"具体场景一句话","engine":"这一段真正有趣的互动机制","goalA":"${nameOf('A')}此刻想做什么","goalB":"${nameOf('B')}此刻想做什么"${goalCField},"beats":["节拍1","节拍2","节拍3"]},"dialog":[{"speaker":"A","text":"台词","action":"talk","target":"B","beatId":"节拍1"}]}

dialog 必须按照 card.beats 推进，但不要求每个节拍句数相同。

每句必填：

* "target"：这句话主要说给谁听

  * "A"/"B"/"C" = 指定角色
  * "audience" = 对观众直说
  * "room" = 对全场
* "beatId"：逐字引用 card.beats 中对应的一项

speaker 只能是：
${speakerList}

台词文本中一律使用角色真名，禁止出现"甲""乙""丙"。

action 只能使用：
idle, talk, happy, laugh, shy, sleepy, wave, thinking, angry, sad, surprise, shake, jump

一段共 14~22 句。

${slots.map((id) => nameOf(id)).join('、')}同场，但禁止固定 A→B→C 循环。
允许同一角色连续说两三句，也允许某个角色一段时间不说话。

每句口语化，通常不超过 25 个字。
极少数为了完成自然语义可以稍长，但不要写成长段演讲。

台词可在 text/action 外带可选演出字段：

"reactions":{"B":"shy","C":"surprise"}

本句播出时其他角色的无声反应动作。
键不能包含当前 speaker，值必须来自 action 词表。
使用 reactions 后不要再写 listenerAction。

"delivery":"deadpan|excited|slow"

* 默认普通语气，不加字段
* deadpan：一本正经、冷处理、荒诞内容认真说
* excited：真的情绪上来、抢话、发现关键点或爆发
* slow：犹豫、思考、意识到哪里不对、故意拖一下

不要把 delivery 当成笑点标签。

同一角色连续使用同一种强烈 delivery 最多两句。

"pauseBefore":300~600

只在非常需要停一下才成立的反转、意识转变或揭示前使用。

"pauseAfter":900~1500

只在一个真正值得留白的句子后偶尔使用。
不是每段都必须有。
${goalCBullet}

## 最后自检

生成前在内部检查，但不要输出检查过程：

1. 如果把角色名字删掉，三个人的说话方式是否仍然有差异？
2. 是否出现了至少一次"原本没预料到的方向变化"？
3. 是否有人只是为了完成轮流发言而开口？如果有，删掉或重写。
4. 是否连续几句都只是互相吐槽？如果是，增加行动、信息变化或立场变化。
5. 是否为了搞笑牺牲了人物正常反应？如果是，优先保人物真实。
6. 最后一句是不是强行总结或标准包袱？如果是，尝试停在一个更自然、更有余味的位置。
7. 这一段真正有趣的地方是什么？如果答案只是"他们互相吐槽"，重新设计互动引擎。

请先在内部确定场景卡和互动引擎，再只输出这一段完整对话的 JSON。`
}
export function buildMessages(
  mode: Mode,
  topicPlan: TopicPlan,
  recentLines: DialogLine[],
  userInterests?: string,
  userCtx?: UserContext,
  relationship?: Relationship,
  interactionRecap?: string,
  allowChoice?: boolean,
  lastChoice?: string,
  /** 环境感知语境(可选):电量/前台应用/连续工作时长,已在引擎侧做过冷却 */
  envNote?: string,
  /** 长期关系底色(可选):信任/摩擦的当前状态描述 */
  bondNote?: string,
  /** 心情余波(可选):跨集带过来的情绪惯性,已由 moodState 翻译成自然语言块 */
  moodNote?: string,
  /** 只有显式”续聊”才携带上一段原始台词；新主题默认 false,避免内容串味 */
  continueFromPrevious = false,
): ChatMessage[] {
  // 模式基调:非 'comedy'(如'温暖治愈'/'日常闲聊')走非喜剧分支——裁掉默认互怼喜剧件,
  // 模式风格成为真正的主旋律。原 comedy 文案逐字不动(内建模式回归锁测试在守)
  const modeDef = modeOf(mode)
  const tone = modeDef.tone?.trim()
  const isComedy = !tone || tone === 'comedy'
  // 相声解绑(实验):题材/人物/情境完全自由,secret/callback 装置整体退场——
  // 义务过载是"网页单发质量更高"的主因;只动 crosstalk,其他喜剧模式回归锁不动
  const isCrosstalk = mode === 'crosstalk'
  // 身份层恒定;喜剧动态(互怼/逗哏捧哏/段子舞台)只在喜剧基调下拼接
  const persona = fullPersona({ comedyDynamics: isComedy })
  // 招牌怪癖注入(实验):清单 + 五句使用纪律;关闭或无怪癖时为空串,不加空段
  const quirkBlock = renderQuirkBlock(
    getBookSync(),
    getConfigSnapshot().quirkSystem === true,
    nameOf,
    (['A', 'B', 'C'] as const).filter((id) => isCharacterEnabled(id)),
  )
  const personaWithQuirks = quirkBlock ? `${persona}\n\n${quirkBlock}` : persona

  // 手法说教刻意做减法:结构/节拍由场景卡的 escalation 承担,避免固定套路疲劳
  const craft = isComedy
    ? `创作要求（这是喜剧，好笑比什么都重要）：
- 场景卡的 escalation 就是包袱节拍：前一拍铺垫、后一拍意外反转，最后一句必须是响底的包袱收束
- secret 是反转的底气：揭晓时要"出人意料但回头看合理"
- callback 是本集自己的梗：结尾回收前面埋的线，形成"老观众才懂"的呼应
- 台词全部口语化，像真说话，不要书面语；允许"哎""嚯""好家伙""就这？"这类语气词
- 不写无信息的比喻和抒情，不上价值不总结；"值得一提的是/不得不说"这类万金油开头一律不要
- 关系决定说法：按本集关系状态写出"想说不敢说/嘴硬/试探/讨好"这些姿态差异，不要俩人从头吵到尾
- 话题活化：话题只是种子，把它翻译成当下年轻人真实的生活场景——具体的 app 名、场景、行为习惯、当代情绪，不要干巴巴围绕话题词打转`
    : `创作要求（本集基调：${tone}，严格按模式风格创作）：
- 台词全部口语化，像真说话，不要书面语；语气词按模式风格自然使用
- 像真人说话，短而落地：每句只说当下这件具体的事；不写抒情比喻和戏剧旁白（"仿佛""空气凝固了"式），不上价值、不升华点题（"这大概就是…吧"式收尾），少用"其实/说实话/不得不说"这类万金油开头
- 角色关系与相互姿态按模式风格走，不套用互怼/抬杠的默认写法
- 话题活化：话题只是种子，把它翻译成真实的生活场景——具体的事、具体的细节，不要干巴巴围绕话题词打转
- escalation 是本集的节拍：前拍铺垫、后拍递进，最后一句按模式风格收尾`

  // 旧字段兜底:userCtx 未传时回退到 legacy userInterests
  const legacy = userInterests?.trim()
    ? `\n\n使用者画像：我们的观众朋友有以下兴趣爱好：${userInterests.trim()}。聊天中可以自然地偶尔聊到这些（不要刻意每句都提）。`
    : ''
  const profile = userCtx ? renderAudienceContext(userCtx) : legacy
  const storyCtx = userCtx ? renderStoryContext(userCtx.story, { comedy: isComedy }) : ''

  const slot = currentTimeSlot()
  const timeCtx = `\n\n现实时间：现在是${slot.label}，${slot.scene}。本集的场景和情绪可以贴合这个时间段。`

  const bondCtx = bondNote?.trim()
    ? `

长期关系背景（影响相互态度与语气,不是本集主要矛盾）：${bondNote.trim()}。`
    : ''

  const moodCtx = moodNote?.trim() ? `

${moodNote.trim()}` : ''

  const recap = interactionRecap?.trim()
    ? `最近有过一次观众互动:${interactionRecap.trim()}。如果能自然接入本集,开场可由一名角色轻松提一句;接不上就忽略。不得责怪观众,不得展开成多人讨论。

`
    : ''

  // 本集关系卡是互怼攻守向局势:非喜剧模式不注入,免得把基调拽回斗嘴
  const relCtx = relationship && isComedy
    ? `


本集关系状态（必须遵守,写进场景卡的 relationship 字段）：${relationship.label}——${relationship.desc}。关系只改变本集攻守,${nameOf('A')}和${nameOf('B')}的基础性格与说话风格不变。`
    : ''

  // 连续剧情节拍:本集是多集剧情线的一拍,话题让位,结尾留下一拍的钩子(语境由话题计划推导)
  const arcCtx = arcCtxFromPlan(topicPlan)

  // C 关闭时不注入任何 C 分工规则,输出协议收窄到 A/B
  const cOn = isCharacterEnabled('C')
  const cRule = cOn
    ? cRuleFor({
        isComedy,
        isCrosstalk: mode === 'crosstalk',
        cCustomized: isPersonaCustomized('C'),
        tone,
      })
    : ''

  // 观众抉择点:由调用方掷骰决定(约 30% 的集数)。喜剧安排在中段冲突处站队;
  // 非喜剧只在自然停顿处征询意见,不要求汇合同一收束
  const choiceRule = !allowChoice
    ? ''
    : isComedy
      ? '\n\n观众互动(本段必须包含,恰好在剧情冲突最激烈的中段安排一次):在 dialog 数组中插入恰好一个抉择对象:{"choice":{"prompt":"向观众提出的站队问题,15字内","options":[{"id":"<英文短id>","label":"<中文选项>"},{"id":"<英文短id2>","label":"<中文选项2>"}]}},共两个选项;choice 之后的每句台词都必须额外带 "branch":"<所支持选项id>" 字段,两个分支各 3~5 句,两个分支结尾收同一个底包袱;两个选项可以都不是好选择,喜剧效果更好。两个分支的首句都必须直接以角色身份对被选方向做口语反应(如"行,听你的就完事了！"/"好家伙,你们是真不嫌事大"),整段禁止出现"观众选择了""大家投了""投票结果"这类播报腔与统计口吻。其余集数不要输出 choice。'
      : '\n\n观众互动(本段必须包含,在对话的自然停顿处进行):在 dialog 数组中插入恰好一个抉择对象:{"choice":{"prompt":"向观众提出的意见征询,15字内","options":[{"id":"<英文短id>","label":"<中文选项>"},{"id":"<英文短id2>","label":"<中文选项2>"}]}},共两个选项;choice 之后的每句台词都必须额外带 "branch":"<所支持选项id>" 字段,两个分支各 3~5 句,各自自然收束,不要求汇合同一句;两个选项可以是不同的偏好或做法。两个分支的首句都必须直接以角色身份对所选方向做口语反应,整段禁止出现"观众选择了""大家投了""投票结果""站队"这类播报腔与统计口吻。其余集数不要输出 choice。'

  const lastChoiceText = lastChoice?.trim()
    ? `\n上集观众的选择是:"${lastChoice.trim()}"(开场可以自然接这个话头,口语化地回应——别说"上集观众选择了"这类播报腔)。`
    : ''

  // 装置开关:喜剧默认要求 secret/callback;相声解绑版整体退场(协议/校验/修复同步降档)
  const devices = isComedy && !isCrosstalk
  const protocol = `输出协议（严格遵守）：
- 只输出一个 JSON 对象，不要输出任何其他文字
- 先写场景卡再写台词，格式：{"card":{"relationship":"关系标签","scene":"具体场景一句话","goalA":"${nameOf('A')}想要什么","goalB":"${nameOf('B')}想要什么"${cOn ? `,"roleC":"${nameOf('C')}本集的行动职责(可选,不写${nameOf('C')}就省略)"` : ''},"secret":${devices ? '"被隐瞒的关键信息(一方或双方知道)"' : '"本集的关键信息或情感内核(可选,模式不需要反转就不填)"'},"escalation":["节拍1","节拍2","节拍3"]${devices ? ',"callback":"结尾回收的本集铺垫"' : ''}},"dialog":[{"speaker":"A","text":"台词","action":"动作","target":"B","beatId":"节拍1"},...]}
- dialog 必须逐拍实现 card.escalation；${devices ? 'secret 在结尾反转揭晓；callback 必须回收本集前面埋的线' : 'secret/callback 是可选字段,只在模式风格需要时才写,不需要就省略'}
- 每句必填 "target"（这句对谁说："A"/"B"${cOn ? '"/"C"=指定听者' : '=指定听者'}；"audience"=对观众直说；"room"=对全场）和 "beatId"（这句话实现 card.escalation 的哪一拍,逐字引用该项${devices ? '；收底回收 callback 的句子标最后一拍' : ''}）
- speaker 只能是 ${cOn ? '"A"、"B" 或 "C"' : '"A" 或 "B"'}；${nameOf('A')}和${nameOf('B')}承担${isComedy ? '主要语言冲突' : '主要对话'}${cOn ? `,${nameOf('C')}按上面的角色分工参与` : ''};台词文本里一律用角色真名,禁止出现"甲""乙""丙"(称呼与性别纪律见上)
- action 只能是这些词之一（禁止用 card 的字段名或其他词）：${ACTIONS}
- 一段共 ${isComedy ? '14~22' : '8~16'} 句；${cOn ? '三人同场但' : ''}禁止机械轮流${cOn ? '（尤其不许固定 A→B→C 循环）' : ''}
- 每句口语化，不超过 25 个字
- 台词可在 text/action 外带可选演出字段(用在该用的地方,没有就省略,别每句都加)：
  "reactions":{"B":"shy","C":"surprise"}(本句播出时其他角色的无声反应动作,键不含说话者自己,值同 action 词表;用了 reactions 就不要再写 listenerAction)、"delivery":"deadpan|excited|slow"(面瘫/兴奋/慢条斯理)、"pauseBefore":毫秒(${isComedy ? '包袱前' : '蓄势'}300~600)、"pauseAfter":毫秒(只给${isComedy ? '响底的' : '收尾的'}最后一句,900~1500 留白)
- delivery 使用纪律:默认普通语气(不加字段);同一角色连续同种强情绪最多两句;${isComedy ? 'excited 只用于冲突升级和抖包袱;slow 只用于铺垫、犹豫和揭底' : `excited/slow 按本集基调(${tone})自然使用,不刻意夸张`}`

  const envBlock = envNote?.trim()
    ? isComedy
      ? `现实环境(可作为素材自然带入,要有喜剧感,别播新闻):${envNote.trim()}。
`
      : `现实环境(可自然带入,贴合本集基调,别播新闻):${envNote.trim()}。
`
    : ''

  const history = continueFromPrevious && recentLines.length
    ? `上一段的结尾（新的一段要自然衔接，不要重复内容）：\n${recentLines
        .slice(-4)
        .map((l) => `${nameOf(l.speaker)}：${l.text}`)
        .join('\n')}\n\n`
    : ''

  const topicText = isCrosstalk
    ? topicPlan.lane === 'manual'
      ? `用户点播的题材（可选灵感，可用、可用一半、也可完全弃用，以你最有把握写响的题材为准）：${topicPlan.card.title}${topicPlan.episodeFocus ? `——${topicPlan.episodeFocus}` : ''}`
      : ''
    : renderTopicPlan(topicPlan)

  // 相声互动版:整体走专用模板(自含协议),user 只带素材(环境/续聊/点播题材灵感)
  if (isCrosstalk) {
    return [
      { role: 'system', content: crosstalkSystemPrompt() },
      {
        role: 'user',
        content: [envBlock, history, topicText].filter(Boolean).join('\n\n'),
      },
    ]
  }

  return [
    {
      role: 'system',
      content: isComedy
        ? `你是一位擅长传统相声和网络脱口秀的资深喜剧编剧,给桌面${cOn ? '三' : '两'}人情景剧写段子。${personaWithQuirks}${bondCtx}${moodCtx}${relCtx}${arcCtx}${cRule}${profile}${storyCtx}${timeCtx}${choiceRule}\n\n${craft}\n\n${protocol}\n\n【模式风格（本集最高创作优先级）】\n${modeDef.prompt}\n(模式风格与上述默认喜剧手法(互怼/包袱/secret反转/逗弄)冲突时,一律以模式风格为准:台词内容、角色相互姿态、收尾方式都按模式风格走;场景卡仍需输出,但 secret/callback 只在模式风格需要反转或回收时使用,模式不需要就不硬塞。模式给了专属话题角度时,话题从那些角度里取。)`
        : `你给桌面${cOn ? '三' : '两'}人情景剧写台词,本集基调:${tone}——严格按模式风格创作,不要套用互怼喜剧的默认写法。${personaWithQuirks}${bondCtx}${moodCtx}${arcCtx}${cRule}${profile}${storyCtx}${timeCtx}${choiceRule}\n\n${craft}\n\n${protocol}\n\n【模式风格（本集最高创作优先级）】\n${modeDef.prompt}\n(模式风格是本集的主旋律:台词内容、角色相互姿态、收尾方式全部按模式风格与专属话题走。)`,
    },
    {
      role: 'user',
      content: `${lastChoiceText}${recap}${envBlock}${history}${topicText}\n请先定场景卡,再输出这一段完整对话的 JSON。`,
    },
  ]
}
