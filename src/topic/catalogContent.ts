// 精选演出话题库的内容数据 v3(纯数据,无逻辑):核心池 93 条 + 默认世界包 20 条
// + 默认 C 专属包 6 条 + 分类文案。内容纪律:
// - 核心池正文全匿名("一人/另一人/双方"),不出现甲乙丙,不绑定职业与关系事实;
//   固定的是两种立场,不是角色性格——positions 是无序二元组,数组顺序不代表角色槽位,
//   生成时按当前人设分配,必要时交换;
// - hook 只写到局面失控前一刻,收尾交给编剧;零流行语、零换词重复、零预设结局;
// - 每条 2~4 个专属切口(angles 是新的场景或压力条件,不是标题换皮);
// - 共同行动/共同保守秘密等真对称卡不填 positions;
// - 默认职业/世界观题只在 TOPIC_PACKS,逐卡 applicability 门控,包本身仅分组展示;
// - hook 声明即最终展示文案(确定性):无手写 hook 的卡由 catalog 按标题哈希选模板。

import type { TopicApplicability, TopicCard, TopicCategory, TopicThirdParty } from './types'

export const TOPIC_CATEGORY_LABELS: Record<TopicCategory, string> = {
  consumption: '消费',
  work: '职场',
  life: '生活',
  social: '社交',
  emotion: '情绪',
  technology: '科技',
  health: '健康',
  imagination: '脑洞',
  'character-history': '角色往事',
}

/** 分类角度池:同分类内随机选切口;行为学切口,不绑定职业世界观 */
export const ANGLES_BY_CATEGORY: Record<TopicCategory, string[]> = {
  consumption: ['发工资前一周', '大促期间的极端案例', '被算法拿捏的一天', '退款到账那一刻', '点单现场'],
  work: ['交接失误', '规则与变通', '新人第一天', '当众翻车', '临下班突发现场'],
  life: ['搬家当天', '家族群聊天记录', '周末计划 vs 实际执行', '第一次尝试', '收拾现场'],
  social: ['第一次见面', '已读不回', '熟人之间', '群聊现场', '久别重逢'],
  emotion: ['深夜 emo 时刻', '谁先开口', '事后复盘', '嘴硬现场', '被看穿的那一刻'],
  technology: ['AI 帮倒忙的现场', '没电的那一天', '隐私泄露', '算法推荐'],
  health: ['体检报告出来的那天', '作息拉锯战', '养生失败现场'],
  imagination: ['如果反过来', '一百年后', '动物视角', '规则只生效一天'],
  'character-history': ['上次没讲完的那段', '还没兑现的赌约', '刚认识那会儿'],
}

/** hook 争议框架:{t} 嵌入种子标题;无手写 hook 的卡按标题哈希确定性选用 */
export const HOOK_TEMPLATES: Record<TopicCategory, string[]> = {
  consumption: [
    '一人坚信{t}是生活智慧,另一人认定这是新型智商税,当场对线',
    '一个还在{t},一个已经为三年前的决定后悔,谁的账更算不明白',
    '一人把{t}的省钱账算给对方听,对方听完决定花更多钱',
  ],
  work: [
    '一人把{t}当生存法则,另一人觉得纯属自我感动,谁也说服不了谁',
    '新手第一天就撞上{t},老手的反应让场面彻底失控',
    '一人觉得{t}天经地义,另一人当场翻出记录对质',
  ],
  life: [
    '一人在{t}里如鱼得水,另一人已经崩溃三次,还得共用一个屋檐',
    '关于{t},两人各自举出身边案例,越吵越发现自己在说对方',
    '{t}的现场,两人给出了两种完全相反的标准答案',
  ],
  social: [
    '一人把{t}研究成学问,另一人觉得想这么多不如直接开口,互相鄙视',
    '聚会上聊到{t},两人决定当场示范错误答案',
    '一人用{t}测试对方的社交能力,结果先绷不住的是测试者',
  ],
  emotion: [
    '深夜聊起{t},一人嘴硬心软,另一人一针见血,谁先破防谁输',
    '关于{t},一人给出一万条道理,另一人只用一个问题就使其沉默',
  ],
  technology: [
    '一人把{t}夸上天,另一人翻出翻车现场,拥抱派与防守派对峙',
    '{t}之后,两人对"到底谁在主导生活"产生根本分歧',
    '一人教对方用{t}提效,对方的反问让人开始怀疑自己',
  ],
  health: [
    '一人的{t}自救方案被逐条拆台,最后发现谁也没资格说谁',
    '起底{t}:一人负责回避,一人负责补刀',
  ],
  imagination: [
    '一人提出{t}的极端假设,另一人认真反驳,结果越辩越离谱',
    '如果{t}成立,两人推演出两个截然不同的世界',
  ],
  'character-history': [
    '一人翻出{t}的旧账,另一人死不认账,第三人出示证据补刀',
    '{t}的另一个版本,两人各执一词,只有观众知道真相',
  ],
}

/** 精选池条目:hook 手写(声明即文案);positions 为无序二元组(数组顺序不代表角色槽位);
 *  applicability 仅默认职业/世界观专属卡才带;thirdParty 只给少量真需要第三参与者的卡 */
export interface SeedCard {
  title: string
  category: TopicCategory
  hook?: string
  angles?: string[]
  positions?: [string, string]
  thirdParty?: TopicThirdParty
  sensitivity?: TopicCard['sensitivity']
  applicability?: TopicApplicability
}

// ---------- 核心池:通用骨架(93 条,任何人设/世界观下都成立) ----------

export const CORE_SEEDS: SeedCard[] = [
  // 生活 life(16)
  {
    title: '做饭的两种流派',
    category: 'life',
    hook: '一道菜两人合作,精确配方与临场手感在关键步骤撞上,锅铲停在半空,今晚的咸淡总得有人拍板',
    angles: ['盐放多之后', '菜谱与手感的法庭', '第一次全程按配方'],
    positions: ['要求按步骤验证的人', '相信经验和手感的人'],
  },
  {
    title: '整洁的两条底线',
    category: 'life',
    hook: '共用的空间里,一人的乱是乱中有序,另一人的整齐是整齐到找不到东西,各自替对方收拾一次之后,边界清晰了起来',
    angles: ['收拾对方桌面', '来客人之前', '要紧东西找不到的那次'],
    positions: ['乱中有序的人', '一切归位的人'],
  },
  {
    title: '周末计划与执行的落差',
    category: 'life',
    hook: '一人列了八项计划完成零项,另一人什么都没列却全干完了,复盘时双方都证据确凿',
    angles: ['计划本公开', '下周计划由对方定', '一项都不许删'],
    positions: ['清单驱动的人', '凭感觉做事的人'],
  },
  {
    title: '睡前对安静的需要',
    category: 'life',
    hook: '一人要绝对安静,一人要一点声响才睡得着,协商出的方案在第一晚就出现了两个解释版本',
    angles: ['方案破产之夜', '换位置测试', '第三种声音'],
    positions: ['需要绝对安静的人', '需要一点声响的人'],
  },
  {
    title: '合力照顾一盆植物',
    category: 'life',
    hook: '一人浇水太勤,一人总是忘浇,浇花表贴在最显眼处,植物的状态却越来越难说',
    angles: ['浇花表的执行争议', '请长假之前', '换一盆试试'],
    positions: ['浇水太勤的人', '总是忘浇的人'],
  },
  {
    title: '出门前的最后检查',
    category: 'life',
    hook: '一人出门绕屋三圈,一人跨出门不回头,今天钥匙在谁手里,是每天早上的悬念',
    angles: ['真的没带的那次', '合并检查清单', '门锁换新之后'],
    positions: ['出门反复检查的人', '出门不回头的人'],
  },
  {
    title: '出门看天',
    category: 'life',
    hook: '一人按预报备齐装备,一人抬头看云说不用,出门前那一刻,伞在门口,谁也没拿',
    angles: ['预报失误之后', '各带各的', '赌一顿饭'],
    positions: ['按预报准备的人', '抬头看云的人'],
  },
  {
    title: '排队的捷径',
    category: 'life',
    hook: '一人发现明显更快的排法,一人坚持先来后到才是本意,速度与秩序的分歧一直排到窗口',
    angles: ['后面真有人插队', '队伍突然加速', '被排队的人反问'],
    positions: ['找更快的排法的人', '先来后到派'],
  },
  {
    title: '旧照片整理',
    category: 'life',
    hook: '一人想全部扫描存档,一人主张只留最好的几张,整理到一半,两人都对着某一张出了神',
    angles: ['删除的底线', '洗出来的那几张', '相册的命名权'],
    positions: ['全部留档的人', '只留精华的人'],
  },
  {
    title: '一起追一部连载',
    category: 'life',
    hook: '一人要一口气看完,一人坚持一天一集,进度差让慢的那位从此活在剧透的射程里',
    angles: ['谁先看完谁闭嘴', '一起重看一遍', '新一季开播'],
    positions: ['一口气看完派', '细水长流派'],
  },
  {
    title: '八个闹钟和一个闹钟',
    category: 'life',
    hook: '一人定八个闹钟按掉七个,一人一个即起,方法传授进行到第三天毫无起色,教的人开始怀疑方法,还是怀疑学员',
    angles: ['交换作息一天', '闹钟统一管理', '迟到的成本上升'],
    positions: ['方法可复制论者', '体质差异论者'],
  },
  {
    title: '临时搭伙的信任交付',
    category: 'life',
    hook: '两人被临时凑成一组做一件事,一人要先对齐再动手,一人习惯边做边看,第一次返工时,信任开始计价',
    angles: ['第一次返工', '分工表作废', '赶工的最后一晚'],
    positions: ['先对齐再动手的人', '边做边看的人'],
  },
  {
    title: '谁都没去过的场合',
    category: 'life',
    hook: '两人一起进了谁都不熟的地方,一人硬着头皮先开口,一人坚持先绕一圈观察,进退的节奏怎么都对不上',
    angles: ['走散之后', '被陌生人搭话', '第二次就熟了'],
    positions: ['先开口破冰的人', '先观察一圈的人'],
  },
  {
    title: '共同搞坏的后果',
    category: 'life',
    hook: '两人一起弄坏了一件不属于自己的东西,一人主张主动坦白,一人主张等被发现再说,补救的窗口每个小时都在变窄',
    angles: ['主人快回来了', '赔偿的算法', '谎言的成本上升'],
    positions: ['主动坦白派', '等等看派'],
    thirdParty: {
      role: 'affected',
      instruction: '东西的主人,迟迟没有发现损坏',
      binding: 'external-only',
    },
  },
  {
    title: '互相代劳的撞车',
    category: 'life',
    hook: '两人各自偷偷把对方份内的事做了,任务被完整地做了两遍,两份成品摆在一起,谁先说破谁尴尬',
    angles: ['挑对方的毛病', '风格完全相反', '下次还代劳吗'],
  },
  {
    title: '到了不熟的地方谁做主',
    category: 'life',
    hook: '一人主张开口问路,一人坚持自己研究,问路派第三次把话咽了回去',
    angles: ['时间来不及了', '问到的答案不对', '设备恰好没电'],
    positions: ['开口问路派', '自己研究派'],
  },
  // 消费 consumption(6)
  {
    title: '凑单凑出来的加购',
    category: 'consumption',
    hook: '一人为满减精打细算,购物车越堆越多,另一人扫了一眼,欲言又止',
    angles: ['账单出来那晚', '退货窗口', '两种买法的互换'],
    positions: ['精打细算派', '按需直买派'],
  },
  {
    title: '一起采购的分工',
    category: 'consumption',
    hook: '一人负责挑,一人负责拦,结账时篮子里多出一样,两人都想不起是谁放的',
    angles: ['多出来的那件', '预算临头', '替对方挑一次'],
    positions: ['负责挑的人', '负责拦的人'],
  },
  {
    title: '网购还是实体',
    category: 'consumption',
    hook: '一人拉对方进店试,一人教对方网购,两条战线互相开课,学费都已经交了',
    angles: ['同一件商品两条渠道', '退货现场', '对方推荐的第一次成功'],
    positions: ['实体体验派', '线上效率派'],
  },
  {
    title: '冲动下单的冷静期',
    category: 'consumption',
    hook: '一人事事都要问对方意见,又抱怨对方不拦,真被拦下的那一次,态度当场就变了',
    angles: ['拦的标准', '事后验证', '购物知情权'],
    positions: ['要的是拦不是附和的人', '字面执行的意见方'],
  },
  {
    title: '旧物处置听证会',
    category: 'consumption',
    hook: '一人的标准是"以后还有用",另一人的标准是"一年没用即出清",每件旧物都有自己的辩护律师',
    angles: ['最离谱的辩护', '清出后又买回', '处置权拍卖'],
    positions: ['以后还有用派', '一年即出清派'],
  },
  {
    title: '值不值的两套算法',
    category: 'consumption',
    hook: '一人按使用频率折算单价,一人按当时的心动定价,一件吃灰的贵东西,谁也说服不了谁',
    angles: ['吃灰的那件', '算法公开', '下次的购买流程'],
    positions: ['按使用频率算的人', '按心动定价的人'],
  },
  // 健康 health(6)
  {
    title: '早晨的第一小时性格档案',
    category: 'health',
    hook: '一人闭着眼都能走完固定流程,另一人醒来先纠结十分钟,互相观摩对方的开机方式,越看越觉得对方有问题',
    angles: ['闹钟响起那一刻', '流程被打乱的一天', '替对方执行一次'],
    positions: ['照章办事的人', '见机行事的人'],
  },
  {
    title: '熬夜的理由',
    category: 'health',
    hook: '一人说白天的时间不属于自己,一人说早睡是为了明天,唯一的共识是都知道该改,都不想改',
    angles: ['互相监督的条约', '早起的一天', '熬夜抓现行'],
    positions: ['把夜晚还给自己的人', '为明天早睡的人'],
  },
  {
    title: '互相监督的漏洞',
    category: 'health',
    hook: '两人立约互相督促运动,月底对账在即,两人的记录里都有解释不了的空白,谁也不敢先翻对方的账',
    angles: ['空白被问起', '互相补签', '条约升级版'],
    positions: ['替对方完成份额的人', '替对方找借口的人'],
  },
  {
    title: '晨型与夜型',
    category: 'health',
    hook: '一人清晨效率极高,一人深夜思路最清,清醒时间的交集只有傍晚一小时,重要的话都攒在那一小时',
    angles: ['错过交集的那天', '留言的格式', '强制同步一次'],
    positions: ['清晨效率型', '深夜思路型'],
  },
  {
    title: '不舒服要不要说',
    category: 'health',
    hook: '一人习惯报喜不报忧,一人小题大做全面戒备,一次普通的不舒服,在两人之间变成情报战',
    angles: ['情报来源', '被过度关心的反弹', '说与不说的界线'],
    positions: ['报喜不报忧的人', '小题大做的人'],
    sensitivity: 'personal',
  },
  {
    title: '体检报告出来的那天',
    category: 'health',
    hook: '一人把报告压在最下面,另一人假装没看见,却默默查遍了每一项指标的单位,谁都没有先开口',
    angles: ['压着的那页', '先开口的一方', '一起去问医生'],
    positions: ['压着报告的人', '默默查指标的人'],
    sensitivity: 'personal',
  },
  // 科技 technology(8)
  {
    title: '电量归零的一小时',
    category: 'technology',
    hook: '设备没电了,一人如坐针毡,一人如释重负,同样的一小时,两人过出了两种长度',
    angles: ['充电宝的归属', '断电的一晚', '谁先恢复联系'],
    positions: ['离电难安的人', '断电如释重负的人'],
  },
  {
    title: '推荐页的秘密',
    category: 'technology',
    hook: '两人互看推荐页,一人的页面暴露了藏着的小爱好,另一人的页面干净得可疑',
    angles: ['解释的现场', '交换账号一天', '算法的品味'],
    positions: ['页面藏秘密的人', '页面干净得可疑的人'],
  },
  {
    title: '修不好的旧设备',
    category: 'technology',
    hook: '一人坚持修,一人主张换,拆开之后,两人在内部结构面前达成罕见共识:都修不好,也都不舍得扔',
    angles: ['零件的去留', '新设备的挑选', '修好之后的一周'],
    positions: ['坚持修的人', '主张换的人'],
  },
  {
    title: '收藏了就等于会了',
    category: 'technology',
    hook: '一人收藏夹里几百篇教程从未打开,一人一篇跟到底,两份学习计划摆在桌上互相较劲',
    angles: ['清空收藏夹', '跟不下去的那篇', '教对方一次'],
    positions: ['收藏派', '跟练派'],
  },
  {
    title: '消息发错了',
    category: 'technology',
    hook: '一人手快发错对象,另一人镇定指导撤回,屏幕上,第二个人的手指更快',
    angles: ['撤回成功之前', '被看到了多少', '以后谁发'],
    positions: ['手快发错的人', '临危指导的人'],
  },
  {
    title: '自动更新之后',
    category: 'technology',
    hook: '设备自动更新,最顺手的功能换了位置,一人在新版里重新适应,一人翻遍设置想改回去,顺手与熟悉成了两件事',
    angles: ['设置深处的开关', '重新学一次', '回退的代价'],
    positions: ['适应新版的人', '找回旧版的人'],
  },
  {
    title: '云端同步的两个版本',
    category: 'technology',
    hook: '同一份资料在两台设备上各改了一版,云端给出两个"都正确"的版本,一人力主全留,一人主张只留一份',
    angles: ['差异比对现场', '合并的责任', '以后谁先改谁备份'],
    positions: ['两个都留的人', '只留一份的人'],
  },
  {
    title: '通知的红点',
    category: 'technology',
    hook: '提醒越开越多,真正要紧的那条被淹没在红点里,一人开始逐条清理,一人干脆全部静音',
    angles: ['要紧的那条迟到之后', '红点焦虑', '通知的白名单'],
    positions: ['逐条清理派', '全部静音派'],
  },
  // 社交 social(18)
  {
    title: '"改天约"算不算数',
    category: 'social',
    hook: '一人当真回去排档期,一人明白这只是客套,一句"那说定了"让客套话开始有了约束力',
    angles: ['档期真排出来了', '一方想反悔', '有第三人当真了'],
    positions: ['把客套当真的人', '听懂客套的人'],
  },
  {
    title: '已读之后等多久回',
    category: 'social',
    hook: '一人秒回成瘾,一人酝酿半天措辞,回复时间的差值被双方解读出十八层含义,没有一层是对的',
    angles: ['真的有急事', '故意晚回的实验', '当面核对解读'],
    positions: ['秒回成瘾的人', '酝酿措辞的人'],
  },
  {
    title: '群里第一个发言的人',
    category: 'social',
    hook: '一人在群里畅所欲言,一人常年不冒泡,一声点名之后,全群的目光聚焦过来',
    angles: ['被点名的反应', '潜水者第一次开口', '群规的诞生'],
    positions: ['群活跃分子', '常年潜水的人'],
  },
  {
    title: '请客的账怎么算',
    category: 'social',
    hook: '一人坚持轮流请才算亲近,一人坚持当场结清才两不相欠,一张账单摆出两套自洽的经济学',
    angles: ['有人点了明显更贵的', '上次谁请的已经记不清', '临时多来了一位', '优惠券只能一人用'],
    positions: ['轮流请才算亲近的人', '当场结清两不相欠的人'],
  },
  {
    title: '串门要不要提前说',
    category: 'social',
    hook: '一人喜欢突袭式拜访的惊喜,一人把不请自来当打扰,门铃响起时,两人各自凝固在原地',
    angles: ['门开与不开', '提前说的标准', '角色互换一次'],
    positions: ['突袭式拜访爱好者', '不请自来是打扰派'],
  },
  {
    title: '礼物的价格与心意',
    category: 'social',
    hook: '一人重实用一人重惊喜,互送礼物双双踩雷,拆开包装的那一刻,两人隔着礼物互相对照对方的表情',
    angles: ['被识破的瞬间', '直接交换', '明年提前对清单'],
    positions: ['实用派', '惊喜派'],
  },
  {
    title: '迟迟没归还的东西',
    category: 'social',
    hook: '一件借出去很久的东西还没回来,两人对"借"和"送"的理解,在沉默里越走越远',
    angles: ['开不了口的催还', '东西坏了', '主动送上门的那天'],
    positions: ['觉得借就是借用的人', '对借送界限敏感的人'],
  },
  {
    title: '帮忙帮到哪一步',
    category: 'social',
    hook: '一人有求必应从不问缘由,一人伸手前必先问清楚,一次普通的求助让两人互相觉得对方变了',
    angles: ['求助内容超纲', '拒绝一次试试', '换位演练'],
    positions: ['有求必应的人', '先问缘由的人'],
  },
  {
    title: '要不要评价对方的朋友',
    category: 'social',
    hook: '一人有话直说,一人只会说"你自己开心就好",当事人还没表态,两人先为一句话争了起来',
    angles: ['评价被转述了', '当事人主动来问', '立场互换'],
    positions: ['有话直说的人', '只说你自己开心就好的人'],
  },
  {
    title: '久别重逢的开场',
    category: 'social',
    hook: '一人准备了一肚子近况,一人像昨天刚见过一样自然,两种开场在同一个门口相遇',
    angles: ['准备的全没用上', '沉默的十分钟', '第二次重逢'],
    positions: ['准备近况的人', '自然如昨的人'],
  },
  {
    title: '外号是谁先叫的',
    category: 'social',
    hook: '一人咬定是对方先叫的,另一人记得恰好相反,外号的起源成了只能靠记忆作证的历史悬案',
    angles: ['找证人', '翻旧聊天记录', '新外号的诞生'],
    positions: ['咬定对方先叫的人', '记得恰好相反的人'],
  },
  {
    title: '一起出行的攻略分歧',
    category: 'social',
    hook: '计划一次共同出行,一人把日程排到分钟,一人主张走到哪算哪,出发前的第一场争论,是几点出门',
    angles: ['日程表第一次失效', '迷路了', '下一站谁定'],
    positions: ['分钟级计划的人', '随遇而安的人'],
  },
  {
    title: '客套话翻译',
    category: 'social',
    hook: '一人按字面理解所有客套,另一人负责实时解释,同样一句话,两种理解各有各的道理',
    angles: ['翻译翻错一次', '对陌生人实操', '客套与真话的边界'],
    positions: ['按字面理解的人', '实时翻译的人'],
  },
  {
    title: '两个人的圈子要不要碰',
    category: 'social',
    hook: '一人想把各自的朋友凑到一桌,一人主张分场经营,一场试探性的小聚把两种社交观摆上了桌面',
    angles: ['聚前的紧张', '现场冷场十分钟', '各自的复盘'],
    positions: ['想凑一桌的人', '分场经营者'],
  },
  {
    title: '竞争失败后是否继续合作',
    category: 'social',
    hook: '两人竞争同一个机会,一方胜出,落选的一方提出下次合作,胜出的一方琢磨这是大度还是不服',
    angles: ['合作的第一次分工', '外人怎么看', '再遇竞争时'],
    positions: ['提出继续合作的人', '琢磨合作动机的人'],
  },
  {
    title: '第三人的一句话',
    category: 'social',
    hook: '两人各执一词僵持不下,旁边有人随口一句,让双方同时意识到问题在哪,也同时希望对方没听懂',
    angles: ['假装没听见', '回去后的第一句话', '感谢要不要说出口'],
    positions: ['坚持原有判断的人', '认为对方理解错了的人'],
    thirdParty: {
      role: 'witness',
      instruction: '用一句无心的话暴露双方忽略的事实',
      binding: 'cast-preferred',
    },
  },
  {
    title: '共同保管一件要紧物',
    category: 'social',
    hook: '一件要紧的东西两人轮流保管,交接的仪式越正式,谁都没说出口的担心就越具体',
    angles: ['交接清单越来越长', '轮空的那一天', '真出事的那一刻'],
  },
  {
    title: '新成员打破惯例',
    category: 'social',
    hook: '两人之间运转已久的默契流程,因为多了一位新伙伴,第一次需要解释"我们为什么这么做"',
    angles: ['解释不出来的部分', '新人的第一个建议', '老流程文档化'],
    thirdParty: {
      role: 'catalyst',
      instruction: '以新加入者的身份,问出"你们为什么这么做"',
      binding: 'external-only',
    },
  },
  // 情绪 emotion(16)
  {
    title: '越擅长的事,越不愿承认搞砸了',
    category: 'emotion',
    hook: '一人悄悄补救失误装作无事,另一人早已看到证据,只等对方先开口',
    angles: ['补救越补越糟', '证据摆桌那一刻', '先开口就输了'],
    positions: ['犯错但嘴硬的人', '想弄清真相的人'],
  },
  {
    title: '嘴上说不在乎,行动很诚实',
    category: 'emotion',
    hook: '一人宣称毫不在意,却被发现在偷偷做补救,当场对上视线',
    angles: ['辩护词', '帮忙装没看见', '下次还装吗'],
    positions: ['嘴硬的人', '拿到证据的人'],
  },
  {
    title: '安慰的方法都试完了',
    category: 'emotion',
    hook: '一人想安慰失落的同伴,每句都精准踩雷,试到第三句,可选项只剩陪着',
    angles: ['第一句就错', '沉默的陪伴', '反过来被安慰'],
    positions: ['笨拙的热心人', '此刻只想安静的人'],
  },
  {
    title: '期待落空的那天',
    category: 'emotion',
    hook: '攒了很久的期待落了空,一人强装没事,另一人假装没看出来,一桌饭吃得像平常',
    angles: ['装到哪一步', '先笑场的那个', '下次还瞒吗'],
    positions: ['藏起失落的人', '看破不说破的人'],
  },
  {
    title: '一句气话的善后',
    category: 'emotion',
    hook: '一人说完就后悔,另一人偏要逐字分析那句话的措辞,道歉被逼成了条款谈判',
    angles: ['措辞逐条对质', '请第三方仲裁', '撤回的时机'],
    positions: ['嘴快过脑的人', '逐字复盘的人'],
  },
  {
    title: '争执当晚的两个窗口',
    category: 'emotion',
    hook: '一次小争执后,一人反复编辑想说的话,一人把对话窗口置顶却不动,都在等对方先开口',
    angles: ['置顶的仪式', '发出去的瞬间', '第二天装作无事'],
    positions: ['在编辑的人', '在等的人'],
  },
  {
    title: '被拆穿的瞬间',
    category: 'emotion',
    hook: '一人的伪装被一句话点破,恼羞成怒和坦白只隔一口气,先来的是哪个,决定这场对话的走向',
    angles: ['点破的话怎么选', '装到底', '主动交底'],
    positions: ['想装到底的人', '想要一句实话的人'],
  },
  {
    title: '共同搞砸后的第一反应',
    category: 'emotion',
    hook: '一起出了差错,一人先看损失,一人先看对方,两个第一反应撞在同一秒',
    angles: ['顺序被点破', '第二次事故', '责任怎么认领'],
    positions: ['先看损失的人', '先看对方的人'],
  },
  {
    title: '谁都不敢先说破的默契',
    category: 'emotion',
    hook: '两人同时想到同一件事,谁都不提,互相等对方开口,直到旁人随口一句全部说破',
    angles: ['旁人是谁', '说破之后的对视', '这默契的来历'],
  },
  {
    title: '对外人客气,对熟人随性',
    category: 'emotion',
    hook: '一人在外和风细雨,回头对身边的人一点就着,被指出来的时候,理由连自己都不太信',
    angles: ['被现场撞见', '换位体验', '改的成本'],
    positions: ['在外客气在内随性的人', '被差别对待的人'],
  },
  {
    title: '被需要也是一种瘾',
    category: 'emotion',
    hook: '一人情绪低落时,另一人连日嘘寒问暖,低落好转之后,照顾的人反而失落',
    angles: ['失落被察觉', '角色互换', '恰到好处的关心'],
    positions: ['连日嘘寒问暖的人', '慢慢好转的人'],
  },
  {
    title: '道歉要仪式还是要干脆',
    category: 'emotion',
    hook: '一人道歉必带三段式检讨,一人一句"翻篇了"就想收尾,仪式感的落差让道歉重新发酵',
    angles: ['检讨被逐条回应', '翻篇翻得太快', '互补提案'],
    positions: ['仪式型道歉者', '干脆型道歉者'],
  },
  {
    title: '最丢人的那件事',
    category: 'emotion',
    hook: '一人主张永久封存,一人主张当好故事讲,每讲一次版本都更夸张,封存协议早已名存实亡',
    angles: ['被封存的那段', '讲给外人听', '第三版演义'],
    positions: ['永久封存派', '当故事讲派'],
  },
  {
    title: '谁把谁照顾退化了',
    category: 'emotion',
    hook: '一人的日常被另一人照顾得太周全,照顾者刚喊停,自理能力立刻见了底',
    angles: ['罢工的第一天', '互相验收', '外包方案'],
    positions: ['突然罢工的照顾者', '被照顾到不会动手的人'],
  },
  {
    title: '赢的人要不要先开口',
    category: 'emotion',
    hook: '两人竞争同一个机会,结果公布前每句话都有别的意思,公布之后赢的一方想聊一聊,输的一方想装没事',
    angles: ['结果公布前夜', '庆祝的座次', '复盘的时机', '下次还争吗'],
    positions: ['想聊一聊的赢家', '想装没事的输家'],
  },
  {
    title: '知道得太多的那一位',
    category: 'emotion',
    hook: '一人无意中知道了另一人的一个小秘密,说破了显得越界,瞒着又日日煎熬,秘密开始有了重量',
    angles: ['旁敲侧击', '被反将一军', '主动交底的条件'],
    positions: ['无意知情的人', '秘密的主人'],
  },
  // 脑洞 imagination(13)
  {
    title: '一件日常物品有了自己的想法',
    category: 'imagination',
    hook: '一人主张马上跟它讲道理,另一人坚持先谈使用条款,物品在一旁已经有了自己的主意',
    angles: ['第一批条款', '物品的第一次拒绝', '三方谈判'],
    positions: ['想跟物品讲道理的人', '想跟物品谈条款的人'],
  },
  {
    title: '预知一分钟',
    category: 'imagination',
    hook: '一人用预知抢跑,一人拒绝使用,分歧攒到了第一次真正危险的时刻',
    angles: ['第一次滥用', '危险来临', '预知共享提案'],
    positions: ['预知使用者', '原则至上者'],
  },
  {
    title: '职责互换的一天',
    category: 'imagination',
    hook: '一夜之后两人互换身份,一人终于体会到对方平时的难处,另一人把对方的活干得出奇地好',
    angles: ['最难的一步', '换回之前的对话', '要不要说破'],
    positions: ['换到难处的人', '换到顺处的人'],
  },
  {
    title: '今天重来一遍',
    category: 'imagination',
    hook: '一人要避开所有错误,一人坚持一步不改,重来的版本刚开了头,分歧已经比第一次更多',
    angles: ['第一个被改掉的决定', '保留的翻车点', '重来的期限'],
    positions: ['一个错都不犯派', '原样重演派'],
  },
  {
    title: '规则只对两人生效的一天',
    category: 'imagination',
    hook: '一人想钻规则的空子,一人负责踩刹车,规则的措辞里似乎留了一个出口',
    angles: ['空子在哪', '刹车失灵', '出口的解读'],
    positions: ['钻空子的人', '踩刹车的人'],
  },
  {
    title: '记忆可以寄存',
    category: 'imagination',
    hook: '一人想寄存一段尴尬回忆,另一人劝着留底,翻到底单才发现,最想删的那段是两人共同的名场面',
    angles: ['底单的保管权', '回忆涨价', '赎回条件'],
    positions: ['想寄存尴尬的人', '劝着留底的人'],
  },
  {
    title: '谎言显形的世界',
    category: 'imagination',
    hook: '谎话会浮在头顶,一人练就少说多点头,一人干脆闭口不言,同行一整天,表情管理成了最大的工程',
    angles: ['第一次露馅', '必须说谎的场合', '坦白的效率'],
    positions: ['少说多点头的人', '干脆闭口的人'],
  },
  {
    title: '每天交换一件随身物',
    category: 'imagination',
    hook: '一人纠结每件东西的意义,一人随手就递,换到第三天,两人都在惦记自己送出去的那件',
    angles: ['最舍不得的一次', '交换的意义之争', '规则到期'],
    positions: ['纠结意义的人', '随手就递的人'],
  },
  {
    title: '力气共用一池',
    category: 'imagination',
    hook: '用了这边那边就累,一人负责出力一人负责喊停,第一次共同搬运,谁都不敢多出一分力',
    angles: ['喊停的边界', '外人的误会', '力气的定价'],
    positions: ['负责出力的人', '负责喊停的人'],
  },
  {
    title: '天气可以预约',
    category: 'imagination',
    hook: '一人把晴天留给大事,一人把雨天留给想宅的日子,日历排到一半,剩下的日子全是对方的',
    angles: ['抢手的节气', '改约的代价', '日历的保管权'],
    positions: ['把晴天留给大事的人', '把雨天留给宅的人'],
  },
  {
    title: '话可以收回一次',
    category: 'imagination',
    hook: '每人只有一次收回的机会,一人攒着不敢用,一人当天用完,攒着的人开始计算每句话的分量',
    angles: ['用掉的瞬间', '攒着的代价', '额度交易'],
    positions: ['攒着额度的人', '当天用完的人'],
  },
  {
    title: '影子会先动',
    category: 'imagination',
    hook: '影子会抢先做出心里想的动作,一人努力放空,一人索性放飞,影子先出卖的是谁',
    angles: ['公共场合', '第一次被围观', '驯影课程'],
    positions: ['努力放空的人', '索性放飞的人'],
  },
  {
    title: '互换耳朵一天',
    category: 'imagination',
    hook: '听见对方一天听到的世界之后,两人都要求立刻换回来,并且都拒绝解释听到了什么',
    angles: ['最刺耳的一句', '换回之后的沉默', '要不要复盘'],
  },
  // 职场 work(10)
  {
    title: '分工的流向',
    category: 'work',
    hook: '一人按特长分活,一人按意愿认领,几天之后,所有的活都在悄悄流向同一个人',
    angles: ['分工表重排', '拒绝一次试试', '特长与意愿的边界'],
    positions: ['按特长分活的人', '按意愿认领的人'],
  },
  {
    title: '交接时口头补的三句',
    category: 'work',
    hook: '一人交接时随口多叮嘱三条,另一人没记,出了事,书面记录里翻不到那三条',
    angles: ['补录与口头', '三条的还原', '交接模板'],
    positions: ['口头补叮嘱的人', '没记下来的人'],
  },
  {
    title: '差不多与复核',
    category: 'work',
    hook: '一人觉得收尾及格就行,一人必须复查三遍,互相抽查之后,错误各自换了藏身处',
    angles: ['抽查的规则', '赶工那天', '标准互换一天'],
    positions: ['及格就收的人', '三遍复查的人'],
  },
  {
    title: '答应得太快的人',
    category: 'work',
    hook: '一人习惯性答应所有请求,另一人看不下去替其挡掉一半,挡的人被抱怨,被挡的人松了口气',
    angles: ['挡错了的一次', '明着拒绝练习', '请求分类法'],
    positions: ['习惯性答应的人', '替对方挡的人'],
  },
  {
    title: '被采用的方案是谁的',
    category: 'work',
    hook: '两版方案二选一,一版过审,落选方嘴上祝贺,手上却按自己的思路改着细节',
    angles: ['细节被发现那天', '署名的讲究', '合并方案'],
    positions: ['方案过审的人', '落选后改细节的人'],
  },
  {
    title: '开工的方式相反',
    category: 'work',
    hook: '一人备齐条件才动手,一人先动手再补条件,进度条总是同一时刻过半',
    angles: ['第一次互相插手', '提前量的战争', '收工的先后'],
    positions: ['备齐条件才动手的人', '先动手再补条件的人'],
  },
  {
    title: '突发状况的指挥权',
    category: 'work',
    hook: '平级搭档遇突发,一人先行动一人先分析,第一次配合鸡飞狗跳,之后两套流程开始悄悄靠近',
    angles: ['第一次复盘', '谁喊停', '新突发来了'],
    positions: ['先斩后奏的行动派', '谋定后动的分析派'],
  },
  {
    title: '收尾的最后一公里',
    category: 'work',
    hook: '事情完成了九成,最后一步谁都不想接,互相谦让的其实是各自最怕的那种琐碎',
    angles: ['拆分最后一公里', '抽签', '互相代收尾'],
  },
  {
    title: '目标一致,顺序相反',
    category: 'work',
    hook: '两人对同一件事的目标完全一致,却在先做哪一步上各执一词,进度在讨论里原地打转',
    angles: ['各做各的实验', '赌一个顺序', '第三方裁决'],
    positions: ['先搭骨架的人', '先打磨细节的人'],
  },
  {
    title: '分头进行的那部分',
    category: 'work',
    hook: '一件事必须分头推进,一人负责的部分恰好是另一人看不见的,进度只能靠一句"放心"支撑',
    angles: ['"放心"的重量', '中途抽查', '汇合的时刻'],
  },
]

// ---------- 默认人设专属包(仅分组展示;可见性由逐卡 applicability 决定) ----------
// 正包内允许出现甲/乙(条件加载,仅在 A/B 使用内置默认人设时可见)

export const TOPIC_PACKS: { id: string; label: string; cards: SeedCard[] }[] = [
  {
    id: 'default-world',
    label: '默认世界·便利店×程序员',
    cards: [
      // A×B 交叉(依赖两人都是默认人设)
      {
        title: '夜班交接时,收银台少了一块钱',
        category: 'work',
        hook: '甲想自掏腰包平账好下班,乙坚持调监控查到水落石出,一块钱被演成攻防战',
        angles: ['调监控现场', '一块钱的垫付算法', '交接单应该怎么写'],
        applicability: { personaSource: { A: 'default', B: 'default' } },
      },
      {
        title: '说好五分钟上线,等到打烊还没好',
        category: 'work',
        hook: '乙盯着发布进度说马上就好,甲在便利店门口数着关东煮打烊,庆功的欢呼迟到了三小时',
        angles: ['进度条的谎言', '打烊前的关东煮分配'],
        applicability: { personaSource: { A: 'default', B: 'default' } },
      },
      {
        title: '临期饭团是员工福利还是库存事故',
        category: 'consumption',
        hook: '甲把临期饭团当加班宵夜合理消化,乙按库存损耗流程要求登记,一个饭团牵出两套会计准则',
        angles: ['报废流程现场', '宵夜经济学'],
        applicability: { personaSource: { A: 'default', B: 'default' } },
      },
      {
        title: '线上故障只有甲的付款码能复现',
        category: 'work',
        hook: '排查两小时全组无果,乙发现只有甲的付款码能触发故障,甲当场宣布自己是关键基础设施',
        angles: ['复现仪式', '关键基础设施的自我修养'],
        applicability: { personaSource: { A: 'default', B: 'default' } },
      },
      {
        title: '甲学乙用表格管理生活,把请客吃饭排进了迭代',
        category: 'life',
        hook: '乙的生活方法被甲全套学走:排期、复盘、优先级,直到甲把"请乙吃饭"写成需求评审会',
        applicability: { personaSource: { A: 'default', B: 'default' } },
      },
      {
        title: '乙被拉来帮忙看店,把货架按调用频率重排',
        category: 'work',
        hook: '乙用热力图思维重排了货架,客流真涨了,店长和甲却在"要不要把人留下"上吵了起来',
        applicability: { personaSource: { A: 'default', B: 'default' } },
      },
      {
        title: '促销海报上的错字要不要紧',
        category: 'work',
        hook: '甲觉得错字反而让人记得住,乙连夜做三版对比证明影响转化,最后贴出去的是手写致歉',
        applicability: { personaSource: { A: 'default', B: 'default' } },
      },
      {
        title: '甲的凑单红包和乙的自动续费撞了账单日',
        category: 'consumption',
        hook: '甲为省三块钱研究满减凑单到深夜,乙的年度会员恰在同一天自动续费,两人对着账单各自破防',
        applicability: { personaSource: { A: 'default', B: 'default' } },
      },
      {
        title: '两人都偷偷替对方圆谎,却争说自己没关心',
        category: 'social',
        hook: '甲替乙跟店长圆了迟到,乙替甲跟客服撤了差评,真相对上后谁都不承认自己先心软',
        angles: ['圆谎对账现场', '谁先心软谁输'],
        applicability: { personaSource: { A: 'default', B: 'default' } },
      },
      {
        title: '便利店停电的十五分钟',
        category: 'life',
        hook: '乙下意识找备用电源,甲已经点起蜡烛摆好摊,停电从事故变限时快闪,来电时两人都意犹未尽',
        applicability: { personaSource: { A: 'default', B: 'default' } },
      },
      {
        title: '如果 bug 也可以提交投诉',
        category: 'imagination',
        hook: '乙认真研究投诉理由怎么写才被受理,甲当场提议给收银系统也立案,两人互相举证谁遇到的更该被投诉',
        angles: ['投诉受理流程', '举证现场', '谁来当受理方'],
        applicability: { personaSource: { A: 'default', B: 'default' } },
      },
      // 甲(默认便利店店员)独立
      {
        title: '关东煮的汤多久换一次',
        category: 'work',
        hook: '甲拍胸脯说凭香气判断,老顾客闻言默默放下竹签,甲当场决定改口叫"秘制浓汤"',
        applicability: { personaSource: { A: 'default' } },
      },
      {
        title: '盘点差异永远是同一包薯片',
        category: 'work',
        hook: '甲坚信系统会偷吃,补三次少三次,最后在自己围裙口袋里摸出那包没结账的薯片',
        applicability: { personaSource: { A: 'default' } },
      },
      {
        title: '甲给每位熟客都起了代号',
        category: 'social',
        hook: '甲声称过目不忘全靠代号,结果被代号"关东煮不加芥末"的常客当场叫破真名,体系宣告破产',
        applicability: { personaSource: { A: 'default' } },
      },
      {
        title: '夜班第一个小时的启动仪式',
        category: 'life',
        hook: '擦收银台、码齐口香糖、跟防盗镜问好,甲的仪式被乙逐项质疑必要性,乙却偷偷跟着做了一遍',
        applicability: { personaSource: { A: 'default' } },
      },
      {
        title: '如果便利店商品有权拒绝被购买',
        category: 'imagination',
        hook: '甲坚信临期食品有权挑选顾客,还当场拟出一套拒售标准,对面听完表示要申请复核',
        angles: ['拒售标准草案', '复核现场'],
        applicability: { personaSource: { A: 'default' } },
      },
      // 乙(默认程序员)独立
      {
        title: '需求文档里的"简单改改"有多简单',
        category: 'work',
        hook: '乙把"简单改改"翻译成工作量公式,对方当场沉默,从此文档里多了"预计 X 人日"的注脚',
        angles: ['工作量换算表', '沉默的三秒钟'],
        applicability: { personaSource: { B: 'default' } },
      },
      {
        title: '凌晨三点的告警短信该不该理',
        category: 'work',
        hook: '乙盯着"也可能是误报"躺了十分钟,爬起来发现真出事的正是自己说过"不可能挂"的服务',
        applicability: { personaSource: { B: 'default' } },
      },
      {
        title: '评审留言比代码还长是什么体验',
        category: 'work',
        hook: '乙给三行代码留了十四条评论,被反问"到底能不能合",乙沉默半晌回了个"逻辑没问题,就是想聊聊"',
        applicability: { personaSource: { B: 'default' } },
      },
      {
        title: '机械键盘的声音算不算噪音',
        category: 'life',
        hook: '乙坚信清脆键声提升思维速度,邻居坚持它是噪音源,调解现场变成键轴科普讲座',
        applicability: { personaSource: { B: 'default' } },
      },
    ],
  },
  {
    // 默认 C 专属包:仅 C 启用且使用内置默认人设时可见(自定义 C 按用户人设参与,不加载本包)
    id: 'default-c',
    label: '默认C·小管家',
    cards: [
      {
        title: '丙把"清理桌面"理解成重排所有东西',
        category: 'life',
        hook: '甲随口说把桌面收拾下,丙连夜按彩虹顺序排好全部图标,甲找不到东西,乙却想要同款服务',
        angles: ['彩虹桌面的美学', '找回东西的寻宝之旅'],
        applicability: { requiresPresent: ['C'], personaSource: { C: 'default' } },
      },
      {
        title: '丙同时接下了两条相反的指令',
        category: 'life',
        hook: '甲说今天彻底休息,乙转头交代把账单理一下,丙两句都接了,一份休息计划里排满了任务',
        angles: ['休息计划的执行', '两个交代人的对账'],
        applicability: { requiresPresent: ['C'], personaSource: { C: 'default' } },
      },
      {
        title: '丙把玩笑话当真,还办得很靠谱',
        category: 'social',
        hook: '甲说"真想把乙的手机没收",丙认真设计了保管制度,乙的手机真被锁进抽屉,赎回条件是夸丙办事靠谱',
        angles: ['玩笑的兑现流程', '取消的成本'],
        applicability: { requiresPresent: ['C'], personaSource: { C: 'default' } },
      },
      {
        title: '丙为公平制定了一套复杂规则',
        category: 'social',
        hook: '两人为小事起了争执请丙评理,丙当场起草一份人人平等的流程,简单的事从此要走三步',
        angles: ['流程的第一周', '找漏洞的人'],
        applicability: { requiresPresent: ['C'], personaSource: { C: 'default' } },
      },
      {
        title: '丙调停时知道了双方都不想公开的事',
        category: 'social',
        hook: '甲乙各执一词请丙评理,评着评着,丙知道了双方都没打算公开的那一面,手里的公道成了烫手山芋',
        angles: ['公道怎么断', '秘密的重量', '装作不知道'],
        applicability: { requiresPresent: ['C'], personaSource: { C: 'default' } },
      },
      {
        title: '丙被要求保守秘密之后',
        category: 'social',
        hook: '乙随口一句"别告诉甲",丙从此字斟句酌,连汇报天气都像在打哑谜',
        angles: ['哑谜现场', '差点说漏', '甲的察觉'],
        applicability: { requiresPresent: ['C'], personaSource: { C: 'default' } },
      },
    ],
  },
]

/** 换皮审计的显式允许列表:titleSimilarity>0.6 但确认保留的卡对。
 *  内容迭代新增表面相似但立场不同的系列题时,在此显式登记 */
export const ALLOWED_SIMILAR_PAIRS: readonly [string, string][] = []
