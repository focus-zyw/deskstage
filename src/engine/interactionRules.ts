// 互动反应文案库:戳/拖拽的本地即时反应(不经 LLM,保手感)。
// 文案按角色人设区分:甲=夸张甩锅+好家伙口头禅;乙=面瘫短句+反问。
import { nameOf } from './persona'

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
  C: [
    '诶？手停下来了…没关系,我重新数一遍！',
    '（认真看着你）刚刚的事,要从头做吗？',
    '咦,台词被打断了…那我先把手里的活干完',
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
  C: [
    '（后退半步,鞠躬）请问需要什么服务吗？',
    '（歪头）站这么近…是在排队吗？',
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
  C: [
    '（小步跟上）等等我,不要落单呀',
    '（原地挥手）这里这里,我在这边',
  ],
} as const

export const OVERLAP = {
  A: ['好家伙,叠罗汉都不带商量的？！'],
  B: ['（面无表情推开）重。下去。'],
  C: ['（被挤得晃了晃）哇,叠在一起了'],
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

/** 拖拽落地的一句"搬家"式回应:拖拽是布局操作,不是冒犯行为——
 *  由被拖动的角色自己说,语气轻松(偶尔惊讶/傲娇),不抱怨、不翻账、不记仇 */
const DRAG_DROP: Record<'close' | 'far' | 'overlap', readonly string[]> = {
  close: [
    '咦,今天坐这边吗?也行。',
    '好,今日座位升级成同桌。',
    '（打量新位置）嗯,这边的风景还不错。',
  ],
  far: [
    '新工位有点远,记得喊我。',
    '（打量四周）行,换个大平层,就是有点空旷。',
    '工位隔远了,暗号记得喊大声点。',
  ],
  overlap: [
    '座位好像不够了,我挪一点。',
    '哎哎,个人空间!……行吧,挤挤也行。',
    '（往边上挪了挪）同桌就同桌,台词一人一句说好了。',
  ],
}

/** C 被拖动的一句回应:小管家把搬家当工作交接 */
const DRAG_DROP_C = [
  '小管家搬家完成,这里也能开工!',
  '（抱着小键盘落座）新坐标已归档,服务不打烊。',
  '收到,工位已更新~有吩咐随时喊我。',
]

/** 拖拽落地回应:被拖动的角色自己说一句,一人一句 */
export function dragDropLine(kind: 'close' | 'far' | 'overlap'): string {
  return pick(DRAG_DROP[kind])
}

/** C 被拖动:小管家专属回应 */
export function dragDropLineC(): string {
  return pick(DRAG_DROP_C)
}

/** 距离阈值(按角色身高换算) */
export function distanceBands(height: number) {
  return { overlap: height * 0.35, close: height * 0.95 }
}

/** 注入下一集的账本文案(只记戳一戳;拖拽是布局操作,不进账本);丙被戳才提丙 */
export function recapText(pokeA: number, pokeB: number, pokeC = 0): string {
  const cPart = pokeC > 0 ? `,连${nameOf('C')}都被戳了 ${pokeC} 回` : ''
  return `观众戳了${nameOf('A')} ${pokeA} 次、戳了${nameOf('B')} ${pokeB} 次${cPart}。`
}

