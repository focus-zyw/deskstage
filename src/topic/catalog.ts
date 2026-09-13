// 精选话题目录:把旧 TOPIC_SEEDS 的 75 条字符串种子按现有六组注释结构化为话题卡,
// 叠加分类角度池(替代旧"全局 18 角度 × 任意话题"的随机组合)。
// 同时提供三族转换:模式专属池 topics → 卡(硬领域约束的素材)、手动话题文本 → 卡、
// 卡 → 可用角度(卡自身 angles 优先于分类角度)。
// 数据只在这里声明;指纹复用 planner,评分在 planner/director。

import type { TopicCard, TopicCategory } from './types'
import { fingerprintOf, normalizeTitle } from './planner'

/** 分类角度池:同分类内随机选切口,同种子也能切出不同集;不再跨分类乱配 */
export const ANGLES_BY_CATEGORY: Record<TopicCategory, string[]> = {
  consumption: ['发工资前一周', '双十一期间的极端案例', '被算法拿捏的一天', '退款到账那一刻', '奶茶店点单现场'],
  work: ['打工人视角', '新人第一周', '领导视角', '年会现场', '临下班突发现场'],
  life: ['租房看房现场', '家族群聊天记录', '周末计划 vs 实际执行', '大学生视角', '搬家当天'],
  social: ['相亲自我介绍场景', '已读不回', '第一次见面', '熟人之间', '群聊现场'],
  emotion: ['深夜 emo 时刻', '和爸妈的解释现场', '朋友圈人设与真实反差'],
  technology: ['AI 帮倒忙的现场', '没电的那一天', '隐私泄露', '算法推荐'],
  health: ['体检报告出来的那天', '健身房推销话术现场', '养生失败现场'],
  imagination: ['如果反过来', '一百年后', '动物视角'],
  'character-history': ['上次没讲完的那段', '还没兑现的赌约', '刚认识那会儿'],
}

/** hook 争议框架:{t} 嵌入种子标题;同分类轮转使用避免千篇一律 */
const HOOK_TEMPLATES: Record<TopicCategory, string[]> = {
  consumption: [
    '甲坚信{t}是生活智慧,乙认定这是新型智商税,当场对线',
    '一个还在{t},一个已经为三年前的决定后悔,谁的账更算不明白',
    '甲把{t}的省钱账算给乙听,乙听完决定花更多钱',
  ],
  work: [
    '甲把{t}当生存法则,乙觉得纯属自我感动,谁也说服不了谁',
    '新人第一天就撞上{t},老油条的反应让场面彻底失控',
    '甲觉得{t}天经地义,乙当场翻出聊天记录对质',
  ],
  life: [
    '甲在{t}里如鱼得水,乙已经崩溃三次,还得共用一个屋檐',
    '关于{t},甲乙各自举出家人案例,越吵越发现自己在说对方',
    '{t}的现场,甲乙给出了两种完全相反的标准答案',
  ],
  social: [
    '甲把{t}研究成学问,乙觉得想这么多不如直接开口,互相鄙视',
    '聚会上聊到{t},甲乙决定当场示范错误答案',
    '甲用{t}测试乙的社交能力,结果先绷不住的是甲',
  ],
  emotion: [
    '深夜聊起{t},甲嘴硬心软,乙一针见血,谁先破防谁输',
    '关于{t},甲给出一万条道理,乙只用一个问题就让甲沉默',
  ],
  technology: [
    '甲把{t}夸上天,乙翻出翻车现场,拥抱派与防守派对峙',
    '{t}之后,甲乙对"到底谁在主导生活"产生根本分歧',
    '甲教乙用{t}提效,乙的反问让甲开始怀疑自己',
  ],
  health: [
    '甲的{t}自救方案被乙逐条拆台,最后发现谁也没资格说谁',
    '体检式起底{t}:甲负责回避,乙负责补刀',
  ],
  imagination: [
    '甲提出{t}的极端假设,乙认真反驳,结果越辩越离谱',
    '如果{t}成立,甲乙推演出两个截然不同的世界',
  ],
  'character-history': [
    '甲翻出{t}的旧账,乙死不认账,丙出示证据补刀',
    '{t}的另一个版本,甲乙各执一词,只有观众知道真相',
  ],
}

/** 分类默认 tags(粗粒度即可:评分用于 modeFit/diversity) */
const CATEGORY_TAGS: Record<TopicCategory, string[]> = {
  consumption: ['消费', '搞钱'],
  work: ['职场', '通勤'],
  life: ['生活', '居住'],
  social: ['社交', '人情'],
  emotion: ['情绪', '心态'],
  technology: ['AI', '数码'],
  health: ['健康', '自我'],
  imagination: ['脑洞', '假设'],
  'character-history': ['角色往事'],
}

function makeCard(
  title: string,
  category: TopicCategory,
  source: TopicCard['source'],
  idPrefix: string,
  extra?: { tags?: string[]; hook?: string; modeAffinity?: string[]; generatedAt?: number; expiresAt?: number },
): TopicCard {
  const templates = HOOK_TEMPLATES[category]
  const tpl = templates[Math.floor(Math.random() * templates.length)]!
  const card: TopicCard = {
    id: `${idPrefix}-${fingerprintOf(title)}`,
    title,
    hook: extra?.hook ?? tpl.replace('{t}', title),
    category,
    tags: extra?.tags ?? CATEGORY_TAGS[category],
    source,
    fingerprint: fingerprintOf(title),
    sensitivity: 'normal',
    generatedAt: extra?.generatedAt ?? 0,
  }
  if (extra?.modeAffinity) card.modeAffinity = extra.modeAffinity
  if (extra?.expiresAt) card.expiresAt = extra.expiresAt
  return card
}

// ---------- 精选池:旧 TOPIC_SEEDS 75 条按原分组结构化 ----------

const SEED_GROUPS: { category: TopicCategory; titles: string[] }[] = [
  {
    category: 'consumption',
    titles: [
      '减肥永远从明天开始',
      '外卖满减红包的极限操作',
      '双十一囤的货还没拆封',
      '点奶茶选择困难症',
      '存钱和消费的世纪拉扯',
      '游戏氪金到底值不值',
      '知识付费买了一堆没听',
      '深夜网购的冲动与后悔',
      '健身房年卡只用过两次',
      '省钱省出来的新型浪费',
      '第一个月理财的血泪史',
      '二手平台捡漏与踩坑',
      '会员自动续费的背刺',
      '9块9包邮的心理战',
      '直播间的"最后三单"',
    ],
  },
  {
    category: 'work',
    titles: [
      '上班摸鱼的最高境界',
      '办公室空调温度争夺战',
      '地铁早高峰的生存法则',
      '下班后的神秘疲惫感',
      '周报到底写给谁看',
      '会议室里的"对齐一下"',
      '工位午睡的十级学者',
      '团建为什么让人害怕',
      '远程办公的睡衣自由',
      '简历上的"精通"二字',
      '带薪如厕的哲学思考',
      '老板画的饼能有多圆',
    ],
  },
  {
    category: 'life',
    titles: [
      '养猫和养狗的人生分歧',
      '租房遇到的奇葩房东',
      '手机内存永远不够用',
      '旧手机里的回忆要不要删',
      '凌晨三点的灵感与早八的闹钟',
      '早睡早起身体好是不是传说',
      '方便面的神仙吃法',
      '朋友圈三天可见的人群分析',
      '为什么周末过得特别快',
      '为什么大人也在集卡',
      '过年被亲戚灵魂拷问',
      '合租生活的高光与崩溃',
      '厨房买过的最没用的小家电',
      '阳台上养死的那盆绿萝',
      '快递柜前的最后倔强',
    ],
  },
  {
    category: 'social',
    titles: [
      '网上吵架的胜负欲',
      '已读不回的心理博弈',
      '微信群表情包的军备竞赛',
      '相亲市场的奇葩语录',
      '朋友圈点赞的社交礼仪',
      '聚会上的"改天约"',
      '社交电量耗尽综合征',
      '当代年轻人的生日恐惧',
      '家人群里的养生谣言',
      '点赞之交的深层研究',
    ],
  },
  {
    category: 'technology',
    titles: [
      'AI 会不会抢走我们的工作',
      'AI 生成的图能骗过多少人',
      '和 AI 聊天比和人聊天舒服',
      '验证码是人机大战最后一关',
      '算法比你更懂你想看什么',
      '手机没电就人设崩塌',
      '密码忘了改一遍的死亡循环',
      '拍照五分钟修图两小时',
    ],
  },
  {
    category: 'health',
    titles: [
      '养生朋克:可乐泡枸杞',
      '拖延症晚期自救指南',
      '宠物看病比人还贵',
      '体检报告不敢点开',
      '褪黑素和咖啡的双向奔赴',
      '办了图书卡就像读过书',
      '旅行是拍照发朋友圈的意义',
      '旅行的意义是拍照发朋友圈',
      '换季必感冒的体质之谜',
      '种草与拔草的无尽循环',
      '互联网冲浪的一键破防',
      '当代年轻人的手抖时刻',
      '睡回笼觉的幸福与代价',
      '记忆力被手机接管之后',
      '嘴上说躺平身体在卷',
    ],
  },
]

/** 精选卡构建(池子在模块加载时定形;hook 随机选框架,指纹去重与角度不受影响) */
export const CURATED_CARDS: TopicCard[] = SEED_GROUPS.flatMap((g) =>
  g.titles.map((t) => makeCard(t, g.category, 'curated', 'cur')),
)

// ---------- 转换:模式专属池 / 手动话题文本 ----------

/** 关键词分类猜测(自定义模式 topics / 手动话题没有声明分类时用) */
export function categoryGuess(text: string): TopicCategory {
  const t = normalizeTitle(text)
  const has = (...ws: string[]) => ws.some((w) => t.includes(w))
  if (has('加班', '老板', '上班', '周报', '会议', '工资', '简历', '面试', '同事', '摸鱼', '通勤')) return 'work'
  if (has('ai', '手机', '算法', '密码', '验证码', 'app', '直播', '网')) return 'technology'
  if (has('恋', '相亲', '朋友', '家长', '亲戚', '群', '社交', '已读')) return 'social'
  if (has('emo', '焦虑', '恐惧', '压力', '内耗', '崩溃')) return 'emotion'
  if (has('减肥', '健身', '熬夜', '养生', '体检', '失眠', '医院')) return 'health'
  if (has('买', '外卖', '红包', '省钱', '氪', '购物', '双十一', '包邮')) return 'consumption'
  return 'life'
}

/** 模式专属话题池 → 卡(source=curated,modeAffinity 锁定该模式;硬领域约束的素材) */
export function cardsFromSeeds(seeds: readonly string[], modeId: string): TopicCard[] {
  return seeds
    .map((s) => s.trim())
    .filter(Boolean)
    .map((t) =>
      makeCard(t.slice(0, 40), categoryGuess(t), 'curated', 'mode', {
        modeAffinity: [modeId],
        tags: [`模式:${modeId}`],
      }),
    )
}

/** 手动话题文本 → 卡(source=manual;一次性点播与自定义输入共用) */
export function manualCardFromText(text: string): TopicCard {
  const title = text.trim().slice(0, 60)
  return makeCard(title, categoryGuess(title), 'manual', 'manual', { generatedAt: Date.now() })
}

// ---------- 角度 ----------

/** 卡的可用角度:卡自身声明优先(结构上保留扩展位),否则用分类角度池 */
export function anglesFor(card: TopicCard): string[] {
  return ANGLES_BY_CATEGORY[card.category]
}

/** 排除已用角度后随机选一个切口;全用过则退回全池(循环可用) */
export function pickAngle(card: TopicCard, usedAngles: readonly string[], rng: () => number): string {
  const all = anglesFor(card)
  if (all.length === 0) return ''
  const fresh = all.filter((a) => !usedAngles.includes(a))
  const pool = fresh.length > 0 ? fresh : all
  return pool[Math.floor(rng() * pool.length)]!
}

/** 一集的切口文本:70% 概率叠角度(与旧 20/80 反转:切口是本集抓手,多数给),30% 裸 hook */
export function focusForCard(
  card: TopicCard,
  usedAngles: readonly string[],
  rng: () => number,
): { focus: string; angle: string } {
  if (rng() < 0.3) return { focus: card.hook, angle: '' }
  const angle = pickAngle(card, usedAngles, rng)
  return { focus: angle ? `${card.hook}(${angle})` : card.hook, angle }
}
