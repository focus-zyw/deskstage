// 互动反应文案库:戳/拖拽的本地即时反应(不经 LLM,保手感)。
// 文案按角色人设区分:甲=夸张甩锅+好家伙口头禅;乙=面瘫短句+反问。

export const POKE_INTERRUPT = {
  A: [
    '我、我说到哪了？！好家伙,把我包袱都戳散了！',
    '（拍案）哎——打断抛梗是要遭天谴的啊朋友！',
    '我的词儿呢？！谁把我 CPU 戳停机了！',
  ],
  B: [
    '……行,忘词了。你满意了吗？（扶眼镜）',
    '（深吸一口气）本来有句特别狠的,现在没了',
    '打断别人的人,今晚睡觉会落枕',
  ],
} as const

export const TOO_CLOSE = {
  A: [
    '哎哎哎！零距离接触是要收费的啊！',
    '好家伙,贴这么近,是想听我的心跳吗！',
  ],
  B: [
    '（往旁边挪了半步）请保持社交距离,谢谢',
    '太近了。说正事,或者退后',
  ],
} as const

export const TOO_FAR = {
  A: [
    '喂——！站那么远你听得见吗——！',
    '（拢着嘴喊）喂——有话当面说——！',
  ],
  B: [
    '（拢着嘴）又不是我要站远的——！',
    '喂——有话当面说,喊什么——！',
  ],
} as const

export const OVERLAP = {
  A: ['好家伙,叠罗汉都不带商量的？！'],
  B: ['（面无表情推开）重。下去。'],
} as const

type Voice = keyof typeof POKE_INTERRUPT

export function pick(lines: readonly string[]): string {
  return lines[Math.floor(Math.random() * lines.length)]
}

export function react(who: Voice, kind: 'interrupt' | 'close' | 'far' | 'overlap'): string {
  const table = { interrupt: POKE_INTERRUPT, close: TOO_CLOSE, far: TOO_FAR, overlap: OVERLAP } as const
  return pick(table[kind][who])
}

/** 长期关系档位:trust/rivalry 数值 → 文案表选择 */
export type BondTier = 'warm' | 'neutral' | 'strained'

export function bondTierOf(trust: number, rivalry: number): BondTier {
  if (trust <= -2 || rivalry >= 3.5) return 'strained'
  if (trust >= 2) return 'warm'
  return 'neutral'
}

// 按关系档位区分的拖拽文案:warm 甜/纵容,strained 记仇/较劲,neutral 走基础表
const BOND_CLOSE: Record<BondTier, Record<'A' | 'B', readonly string[]>> = {
  warm: {
    A: [
      '（没躲）……行吧,老搭档,给你个面子',
      '又挤过来——好家伙,是不是想我了？（得意）',
    ],
    B: [
      '（没挪开）……这次免费,下次收费',
      '（叹气）拿你没办法,就挤一小会儿',
    ],
  },
  neutral: {
    A: TOO_CLOSE.A,
    B: TOO_CLOSE.B,
  },
  strained: {
    A: [
      '哎哎,上次的账还没清,别贴过来套近乎！',
      '（侧身挡住）无事献殷勤——你到底想干嘛！',
    ],
    B: [
      '（拿东西隔开）先把之前的账算了,再谈距离',
      '别碰我。查完账再说',
    ],
  },
}

const BOND_FAR: Record<BondTier, Record<'A' | 'B', readonly string[]>> = {
  warm: {
    A: ['喂——跑那么远,我的包袱抖给谁听啊！', '（拢嘴喊）回来回来,刚那梗再演一遍！'],
    B: ['（往前两步）……只是懒得听你喊,不是想你'],
  },
  neutral: {
    A: TOO_FAR.A,
    B: TOO_FAR.B,
  },
  strained: {
    A: ['行,走就走——账本我留着呢！', '（背身）正好,懒得看见你！'],
    B: ['（头也不回）巴不得。清账之前别喊我'],
  },
}

const BOND_OVERLAP: Record<BondTier, Record<'A' | 'B', readonly string[]>> = {
  warm: {
    A: ['好家伙,挤一块了——这才叫亲密无间！（得意）'],
    B: ['（没推开）……下不为例'],
  },
  neutral: {
    A: OVERLAP.A,
    B: OVERLAP.B,
  },
  strained: {
    A: ['挤什么挤！账没清的人没有站位权！'],
    B: ['（使劲推开）重。下去。别以为挤过来就能赖账'],
  },
}

const BOND_TABLE = {
  close: BOND_CLOSE,
  far: BOND_FAR,
  overlap: BOND_OVERLAP,
} as const

/** 按关系档位取拖拽反应文案;neutral 直接走基础表 */
export function reactBonded(
  who: 'A' | 'B',
  kind: 'close' | 'far' | 'overlap',
  tier: BondTier,
): string {
  return pick(BOND_TABLE[kind][tier][who])
}

/** 距离阈值(按角色身高换算) */
export function distanceBands(height: number) {
  return { overlap: height * 0.35, close: height * 0.95 }
}

/** 注入下一集的账本文案(次数由调用方填) */
export function recapText(pokeA: number, pokeB: number, drags: number): string {
  return `上集演出时,观众没少捣乱——戳了甲 ${pokeA} 次、戳了乙 ${pokeB} 次,还把你们拖近又拽远 ${drags} 次。开场先让两人抱怨一下"观众今天特别欠",再自然进入正题。`
}
