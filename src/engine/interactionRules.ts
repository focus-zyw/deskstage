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

/** 距离阈值(按角色身高换算) */
export function distanceBands(height: number) {
  return { overlap: height * 0.35, close: height * 0.95 }
}

/** 注入下一集的账本文案(次数由调用方填) */
export function recapText(pokeA: number, pokeB: number, drags: number): string {
  return `上集演出时,观众没少捣乱——戳了甲 ${pokeA} 次、戳了乙 ${pokeB} 次,还把你们拖近又拽远 ${drags} 次。开场先让两人抱怨一下"观众今天特别欠",再自然进入正题。`
}
