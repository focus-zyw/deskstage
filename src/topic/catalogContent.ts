// 精选演出话题库的内容数据(纯数据,无逻辑):核心池 + 默认人设专属包 + 分类文案。
// 固定的是戏剧结构(关系/目标/意外 + roles 行为骨架),不固定职业——通用骨架在
// 任何人设/世界观下都成立;便利店×程序员等默认职业题收进 TOPIC_PACKS,由
// catalog 按逐卡 applicability(人设来源)门控,包本身只做内容分组与展示。
// hook 声明即最终展示文案(确定性):没有手写 hook 的卡由 catalog 按标题哈希
// 确定性选模板,杜绝模块加载期随机。

import type { TopicCard, TopicCategory } from './types'

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

/** 精选池条目:hook 手写(声明即文案);roles 只写行为不绑职业;
 *  applicability 仅职业/世界观专属卡才带;sensitivity 缺省 normal */
export interface SeedCard {
  title: string
  category: TopicCategory
  hook?: string
  angles?: string[]
  roles?: { initiator?: string; challenger?: string }
  sensitivity?: TopicCard['sensitivity']
  applicability?: TopicCard['applicability']
}

/** 分类角度池:同分类内随机选切口,同种子也能切出不同集;行为学切口,不绑定职业世界观 */
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

// ---------- 核心池:通用骨架(任何人设下都成立) ----------

export const CORE_SEEDS: SeedCard[] = [
  // 消费(16)
  { title: '减肥永远从明天开始', category: 'consumption', sensitivity: 'personal' },
  { title: '外卖满减红包的极限操作', category: 'consumption' },
  { title: '双十一囤的货还没拆封', category: 'consumption' },
  { title: '点奶茶选择困难症', category: 'consumption' },
  { title: '存钱和消费的世纪拉扯', category: 'consumption' },
  { title: '游戏氪金到底值不值', category: 'consumption' },
  { title: '知识付费买了一堆没听', category: 'consumption' },
  { title: '深夜网购的冲动与后悔', category: 'consumption' },
  { title: '健身房年卡只用过两次', category: 'consumption' },
  { title: '省钱省出来的新型浪费', category: 'consumption' },
  { title: '第一个月理财的血泪史', category: 'consumption', sensitivity: 'personal' },
  { title: '二手平台捡漏与踩坑', category: 'consumption' },
  { title: '会员自动续费的背刺', category: 'consumption' },
  { title: '9块9包邮的心理战', category: 'consumption' },
  { title: '直播间的"最后三单"', category: 'consumption' },
  { title: '种草与拔草的无尽循环', category: 'consumption' },
  // 职场(12;泛职场骨架,不绑定具体行业)
  { title: '上班摸鱼的最高境界', category: 'work' },
  { title: '办公室空调温度争夺战', category: 'work' },
  { title: '地铁早高峰的生存法则', category: 'work' },
  { title: '下班后的神秘疲惫感', category: 'work' },
  { title: '周报到底写给谁看', category: 'work' },
  { title: '会议室里的"对齐一下"', category: 'work' },
  { title: '工位午睡的十级学者', category: 'work' },
  { title: '团建为什么让人害怕', category: 'work' },
  { title: '远程办公的睡衣自由', category: 'work' },
  { title: '简历上的"精通"二字', category: 'work' },
  { title: '带薪如厕的哲学思考', category: 'work' },
  { title: '老板画的饼能有多圆', category: 'work' },
  // 生活(17)
  { title: '养猫和养狗的人生分歧', category: 'life' },
  { title: '租房遇到的奇葩房东', category: 'life' },
  { title: '手机内存永远不够用', category: 'life' },
  { title: '旧手机里的回忆要不要删', category: 'life' },
  { title: '凌晨三点的灵感与早八的闹钟', category: 'life' },
  { title: '早睡早起身体好是不是传说', category: 'life' },
  { title: '方便面的神仙吃法', category: 'life' },
  { title: '朋友圈三天可见的人群分析', category: 'life' },
  { title: '为什么周末过得特别快', category: 'life' },
  { title: '为什么大人也在集卡', category: 'life' },
  { title: '过年被亲戚灵魂拷问', category: 'life', sensitivity: 'personal' },
  { title: '合租生活的高光与崩溃', category: 'life' },
  { title: '厨房买过的最没用的小家电', category: 'life' },
  { title: '阳台上养死的那盆绿萝', category: 'life' },
  { title: '快递柜前的最后倔强', category: 'life' },
  { title: '办了图书卡就像读过书', category: 'life' },
  { title: '宠物看病比人还贵', category: 'life' },
  // 社交(10)
  { title: '网上吵架的胜负欲', category: 'social' },
  { title: '已读不回的心理博弈', category: 'social' },
  { title: '微信群表情包的军备竞赛', category: 'social' },
  { title: '相亲市场的奇葩语录', category: 'social', sensitivity: 'personal' },
  { title: '朋友圈点赞的社交礼仪', category: 'social' },
  { title: '聚会上的"改天约"', category: 'social' },
  { title: '社交电量耗尽综合征', category: 'social' },
  { title: '当代年轻人的生日恐惧', category: 'social' },
  { title: '家人群里的养生谣言', category: 'social' },
  { title: '点赞之交的深层研究', category: 'social' },
  // 科技(8)
  { title: 'AI 会不会抢走我们的工作', category: 'technology' },
  { title: 'AI 生成的图能骗过多少人', category: 'technology' },
  { title: '和 AI 聊天比和人聊天舒服', category: 'technology' },
  { title: '验证码是人机大战最后一关', category: 'technology' },
  { title: '算法比你更懂你想看什么', category: 'technology' },
  { title: '手机没电就人设崩塌', category: 'technology' },
  { title: '密码忘了改一遍的死亡循环', category: 'technology' },
  { title: '拍照五分钟修图两小时', category: 'technology' },
  // 健康(9)
  { title: '养生朋克:可乐泡枸杞', category: 'health' },
  { title: '拖延症晚期自救指南', category: 'health' },
  { title: '褪黑素和咖啡的双向奔赴', category: 'health' },
  { title: '体检报告不敢点开', category: 'health', sensitivity: 'personal' },
  { title: '换季必感冒的体质之谜', category: 'health' },
  { title: '睡回笼觉的幸福与代价', category: 'health' },
  { title: '记忆力被手机接管之后', category: 'health' },
  { title: '嘴上说躺平身体在卷', category: 'health' },
  { title: '当代年轻人的手抖时刻', category: 'health' },
  // 情绪(7;通用骨架,roles 只写行为)
  {
    title: '越擅长的事,越不愿承认搞砸了',
    category: 'emotion',
    hook: '一人悄悄补救失误装作无事,另一人早已看到证据,偏要等对方先开口',
    roles: { initiator: '犯错但嘴硬的人', challenger: '想弄清真相的人' },
    angles: ['补救越补越糟', '证据摆桌那一刻', '先开口就输了'],
  },
  {
    title: '嘴上说不在乎,行动很诚实',
    category: 'emotion',
    hook: '一人宣称对结果毫不在意,却被发现在偷偷做补救准备,当场被抓包',
    roles: { initiator: '用嘴硬掩饰在意的人', challenger: '不动声色收集证据的人' },
  },
  {
    title: '安慰人这件事,越努力越糟糕',
    category: 'emotion',
    hook: '一人想安慰失落的同伴,每句话都精准踩雷,最后承认自己最擅长的只有陪着',
    roles: { initiator: '笨拙的热心人', challenger: '其实只想安静的人' },
  },
  {
    title: '期待越高,失落演得越安静',
    category: 'emotion',
    hook: '攒了很久的期待落了空,一人强装没事,另一人假装没看出来,两人合演一桌若无其事',
    roles: { initiator: '藏起失落的人', challenger: '看破不说破的人' },
  },
  {
    title: '一句气话的售后维修现场',
    category: 'emotion',
    hook: '一人说完气话就后悔,另一人偏要逐字分析这句话的措辞,道歉被迫变成条款谈判',
    roles: { initiator: '嘴快过脑的人', challenger: '拿着话录音反复听的人' },
  },
  {
    title: '两个人都在等对方先低头',
    category: 'emotion',
    hook: '冷战第一晚,一人反复编辑和好短信没敢发,另一人把手机摆在最显眼处装作不看',
    roles: { initiator: '想和好但拉不下脸的人', challenger: '同样想和好但更拉不下脸的人' },
  },
  { title: '互联网冲浪的一键破防', category: 'emotion' },
  // 脑洞(6;假设具体可落地,世界观随当前人设)
  {
    title: '一件日常物品突然有了自己的想法',
    category: 'imagination',
    hook: '一人主张马上跟它讲道理,另一人坚持先谈使用条款,物品在两人争论时自己做了决定',
    roles: { initiator: '想当物品朋友的人', challenger: '想当物品律师的人' },
  },
  {
    title: '如果能预知一分钟后的未来',
    category: 'imagination',
    hook: '一人用预知占小便宜连着翻车,另一人拒绝使用,却在关键时刻靠对方的预知脱了险',
    roles: { initiator: '预知瘾君子', challenger: '原则至上主义者' },
  },
  {
    title: '一觉醒来,两个人的职责互换了',
    category: 'imagination',
    hook: '一人终于体会到对方多年的难处,另一人却把对方的活干得出奇地好,谁先承认这件事谁尴尬',
    roles: { initiator: '换位后破防的人', challenger: '换位后如鱼得水的人' },
  },
  {
    title: '如果今天可以重过一遍',
    category: 'imagination',
    hook: '一人选择一个错误都不犯,另一人坚持照原样再来,结果证明第二次照样翻车,翻的是同一个车',
    roles: { initiator: '完美重演派', challenger: '宿命论乐子人' },
  },
  {
    title: '一条规则只在今天对两人生效',
    category: 'imagination',
    hook: '一人想钻规则空子大干一场,另一人负责踩刹车,最后发现规则留的唯一出口是老实交代',
    roles: { initiator: '规则投机者', challenger: '规则读到底的人' },
  },
  {
    title: '如果记忆可以像行李一样寄存',
    category: 'imagination',
    hook: '一人想寄存掉尴尬回忆,另一人劝着留底,争执中发现最想删的那段恰好是两人共同的名场面',
    roles: { initiator: '想删档的人', challenger: '备份狂魔' },
  },
]

// ---------- 默认人设专属包(仅分组;可见性由逐卡 applicability 决定) ----------

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
        applicability: { actors: { A: 'default', B: 'default' } },
      },
      {
        title: '说好五分钟上线,等到打烊还没好',
        category: 'work',
        hook: '乙盯着发布进度说马上就好,甲在便利店门口数着关东煮打烊,庆功的欢呼迟到了三小时',
        angles: ['进度条的谎言', '打烊前的关东煮分配'],
        applicability: { actors: { A: 'default', B: 'default' } },
      },
      {
        title: '临期饭团是员工福利还是库存事故',
        category: 'consumption',
        hook: '甲把临期饭团当加班宵夜合理消化,乙按库存损耗流程要求登记,一个饭团牵出两套会计准则',
        angles: ['报废流程现场', '宵夜经济学'],
        applicability: { actors: { A: 'default', B: 'default' } },
      },
      {
        title: '线上故障只有甲的付款码能复现',
        category: 'work',
        hook: '排查两小时全组无果,乙发现只有甲的付款码能触发故障,甲当场宣布自己是关键基础设施',
        angles: ['复现仪式', '关键基础设施的自我修养'],
        applicability: { actors: { A: 'default', B: 'default' } },
      },
      {
        title: '甲学乙用表格管理生活,把请客吃饭排进了迭代',
        category: 'life',
        hook: '乙的生活方法被甲全套学走:排期、复盘、优先级,直到甲把"请乙吃饭"写成需求评审会',
        applicability: { actors: { A: 'default', B: 'default' } },
      },
      {
        title: '乙被拉来帮忙看店,把货架按调用频率重排',
        category: 'work',
        hook: '乙用热力图思维重排了货架,客流真涨了,店长和甲却在"要不要把人留下"上吵了起来',
        applicability: { actors: { A: 'default', B: 'default' } },
      },
      {
        title: '促销海报上的错字要不要紧',
        category: 'work',
        hook: '甲觉得错字反而让人记得住,乙连夜做三版对比证明影响转化,最后贴出去的是手写致歉',
        applicability: { actors: { A: 'default', B: 'default' } },
      },
      {
        title: '甲的凑单红包和乙的自动续费撞了账单日',
        category: 'consumption',
        hook: '甲为省三块钱研究满减凑单到深夜,乙的年度会员恰在同一天自动续费,两人对着账单各自破防',
        applicability: { actors: { A: 'default', B: 'default' } },
      },
      {
        title: '两人都偷偷替对方圆谎,却争说自己没关心',
        category: 'social',
        hook: '甲替乙跟店长圆了迟到,乙替甲跟客服撤了差评,真相对上后谁都不承认自己先心软',
        angles: ['圆谎对账现场', '谁先心软谁输'],
        applicability: { actors: { A: 'default', B: 'default' } },
      },
      {
        title: '便利店停电的十五分钟',
        category: 'life',
        hook: '乙下意识找备用电源,甲已经点起蜡烛摆好摊,停电从事故变限时快闪,来电时两人都意犹未尽',
        applicability: { actors: { A: 'default', B: 'default' } },
      },
      {
        title: '如果 bug 也可以提交投诉',
        category: 'imagination',
        hook: '乙认真研究投诉理由怎么写才被受理,甲当场提议给收银系统也立案,两人互相举证谁遇到的更该被投诉',
        angles: ['投诉受理流程', '举证现场', '谁来当受理方'],
        applicability: { actors: { A: 'default', B: 'default' } },
      },
      // 甲(默认便利店店员)独立
      {
        title: '关东煮的汤多久换一次',
        category: 'work',
        hook: '甲拍胸脯说凭香气判断,老顾客闻言默默放下竹签,甲当场决定改口叫"秘制浓汤"',
        applicability: { actors: { A: 'default' } },
      },
      {
        title: '盘点差异永远是同一包薯片',
        category: 'work',
        hook: '甲坚信系统会偷吃,补三次少三次,最后在自己围裙口袋里摸出那包没结账的薯片',
        applicability: { actors: { A: 'default' } },
      },
      {
        title: '甲给每位熟客都起了代号',
        category: 'social',
        hook: '甲声称过目不忘全靠代号,结果被代号"关东煮不加芥末"的常客当场叫破真名,体系宣告破产',
        applicability: { actors: { A: 'default' } },
      },
      {
        title: '夜班第一个小时的启动仪式',
        category: 'life',
        hook: '擦收银台、码齐口香糖、跟防盗镜问好,甲的仪式被乙逐项质疑必要性,乙却偷偷跟着做了一遍',
        applicability: { actors: { A: 'default' } },
      },
      {
        title: '如果便利店商品有权拒绝被购买',
        category: 'imagination',
        hook: '甲坚信临期食品有权挑选顾客,还当场拟出一套拒售标准,对面听完表示要申请复核',
        angles: ['拒售标准草案', '复核现场'],
        applicability: { actors: { A: 'default' } },
      },
      // 乙(默认程序员)独立
      {
        title: '需求文档里的"简单改改"有多简单',
        category: 'work',
        hook: '乙把"简单改改"翻译成工作量公式,对方当场沉默,从此文档里多了"预计 X 人日"的注脚',
        angles: ['工作量换算表', '沉默的三秒钟'],
        applicability: { actors: { B: 'default' } },
      },
      {
        title: '凌晨三点的告警短信该不该理',
        category: 'work',
        hook: '乙盯着"也可能是误报"躺了十分钟,爬起来发现真出事的正是自己说过"不可能挂"的服务',
        applicability: { actors: { B: 'default' } },
      },
      {
        title: '评审留言比代码还长是什么体验',
        category: 'work',
        hook: '乙给三行代码留了十四条评论,被反问"到底能不能合",乙沉默半晌回了个"逻辑没问题,就是想聊聊"',
        applicability: { actors: { B: 'default' } },
      },
      {
        title: '机械键盘的声音算不算噪音',
        category: 'life',
        hook: '乙坚信清脆键声提升思维速度,邻居坚持它是噪音源,调解现场变成键轴科普讲座',
        applicability: { actors: { B: 'default' } },
      },
      // 丙(默认小管家)相关
      {
        title: '丙把"清理桌面"理解成按颜色重排图标',
        category: 'life',
        hook: '甲随口说把桌面收拾下,丙连夜按彩虹顺序排好全部图标,甲找不到东西,乙却想要同款服务',
        angles: ['彩虹桌面的美学', '找回图标的寻宝之旅'],
        applicability: { actors: { C: 'default' } },
      },
      {
        title: '丙把玩笑话当真,还办得很靠谱',
        category: 'social',
        hook: '甲说"真想把乙的手机没收",丙认真设计了保管制度,乙的手机真被锁进抽屉,赎回条件是夸丙办事靠谱',
        applicability: { actors: { C: 'default' } },
      },
    ],
  },
]

/** 换皮审计的显式允许列表:titleSimilarity>0.6 但确认保留的卡对(删除旅行换皮对后为空)。
 *  内容迭代新增表面相似但立场不同的系列题时,在此显式登记 */
export const ALLOWED_SIMILAR_PAIRS: readonly [string, string][] = []
