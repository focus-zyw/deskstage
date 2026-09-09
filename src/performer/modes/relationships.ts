// 临时关系模板池:基础人格稳定(甲吹乙拆),但每集的"局势"随机变化——
// 谁有求于谁、谁握着谁的把柄、谁在心虚,决定台词的攻守姿态,避免永远固定攻守导致模式化。
// 每次生成随机取一注入 prompt,并要求写进场景卡的 relationship 字段。

export interface Relationship {
  /** 短标签,场景卡 relationship 字段照抄它 */
  label: string
  /** 局势描述:注入 system 的一行"本集关系状态" */
  desc: string
  /** 相声模式是否可用(相声有明确捧逗分工,只放行兼容局势);缺省 false = 仅日常 */
  crosstalk?: boolean
  /** 抽取权重(缺省 1);"角色反转"靠低权重实现"20% 概率"级别的稀有度 */
  weight?: number
}

const POOL: Relationship[] = [
  {
    label: '平级斗嘴',
    desc: '两人互不相让,谁也不服谁,拆与被拆随时互换',
    crosstalk: true,
  },
  {
    label: '乙握甲把柄',
    desc: '乙手里有甲的糗事/证据,甲疯狂找补转移话题,乙冷笑旁观随时摊牌',
    crosstalk: true,
  },
  {
    label: '甲有求于乙',
    desc: '甲有事要求乙,吹牛时明显心虚,不敢把乙惹毛,吹到一半开始讨好',
  },
  {
    label: '乙欠甲人情',
    desc: '乙理亏在先(欠钱/欠奶茶/放了鸽子),拆台时留三分余地,嘴硬但不敢真翻脸',
  },
  {
    label: '共同瞒观众',
    desc: '两人合伙在圆同一个谎,越描越黑,互相甩锅又不得不补台',
  },
  {
    label: '互藏秘密',
    desc: '两人各自藏着与话题有关的小秘密,都怕露馅,不停试探对方知道多少',
  },
  {
    label: '旧怨未了',
    desc: '上次的梁子还没解,明面上和和气气,每句话都夹枪带棒翻旧账',
  },
  {
    label: '反转·乙吹甲拆',
    desc: '角色互换:这集乙负责吹牛铺包袱,甲负责拆台翻包袱,乙难得得意一回',
    weight: 2,
  },
]

/** 按模式抽一个临时关系:日常全池加权随机;相声只用兼容捧逗分工的局势 */
export function pickRelationship(modeId: string): Relationship {
  const pool = POOL.filter((r) => (modeId === 'crosstalk' ? r.crosstalk === true : true))
  const bag: Relationship[] = []
  for (const r of pool) {
    for (let i = 0; i < (r.weight ?? 1); i++) bag.push(r)
  }
  return bag[Math.floor(Math.random() * bag.length)] ?? POOL[0]!
}
