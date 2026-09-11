// 角色人设的唯一事实源:内置默认人设在这里定义,用户可在设置里自定义覆盖(可还原)。
// 各 prompt 场合(主演出/短聊/戳一戳/聊天回复)都从 personaText() 取生效文本,
// 用户保存新人设后,下一次生成即采纳。
// 甲乙(A/B)是立绘主角;丙(C)是常驻在场的第三角色(WebM 小管家),
// 行为模式是"按字面理解并立刻执行"——她是行动型变量,不是第三个轮流说话的人。

export interface PersonaDefaults {
  gender: '女' | '男'
  job: string
  traits: string
  catchphrases: readonly string[]
  world: string
}

/** 四维行为画像(doc §6.3):角色差异不靠口头禅堆砌,靠稳定的注意力/判断/风险/防御方式 */
export interface PersonaDimensions {
  /** 注意力偏好:先看什么 */
  attention: string
  /** 判断方式:怎么下结论 */
  judgment: string
  /** 风险姿态 */
  risk: string
  /** 情感防御:掩饰什么、用什么掩饰 */
  defense: string
}

export type ActorSlot = 'A' | 'B' | 'C'

const DIMENSIONS: Record<ActorSlot, PersonaDimensions> = {
  A: {
    attention: '先看人和机会——谁有意思、哪里有便宜可占',
    judgment: '联想、夸张、先下结论再找理由',
    risk: '冒进,先干了再找补',
    defense: '用热闹和自嘲掩饰心虚',
  },
  B: {
    attention: '先看规则和漏洞——哪里不对劲、成本是多少',
    judgment: '求证、拆前提、一针见血,后发制人',
    risk: '保守,但会被激将上头',
    defense: '用冷淡和毒舌掩饰关心',
  },
  C: {
    attention: '先听字面意思——别人说了什么就当真什么',
    judgment: '逐字理解、直接执行,从不怀疑前提',
    risk: '毫无风险意识,说到就做',
    defense: '用认真和忙碌掩饰小情绪,被逗急了就一本正经地用歪理反击',
  },
}

export function personaDimensions(id: ActorSlot): PersonaDimensions {
  return DIMENSIONS[id]
}

/** 四维画像提示词块:主演出注入。措辞围绕行为维度而非"像甲/像乙" */
export function dimensionsPrompt(): string {
  const row = (id: ActorSlot) => {
    const d = DIMENSIONS[id]
    return `- ${nameOf(id)}(speaker "${id}"):注意力——${d.attention};判断——${d.judgment};风险——${d.risk};情绪防御——${d.defense}`
  }
  return `行为底色(台词的判断方式与反应速度要符合它,比口头禅更重要):
${row('A')}
${row('B')}
${row('C')}
- 口头禅/标志性语气词每集合计最多 1~2 次:角色差异靠上面的行为底色体现,不靠口头禅堆砌`
}

const DEFAULTS: Record<ActorSlot, PersonaDefaults> = {
  A: {
    gender: '女',
    job: '便利店店员',
    traits: '精力充沛、爱吹牛、脑洞大、说话夸张,满嘴跑火车还特别得意',
    catchphrases: ['我跟你说', '好家伙'],
    world: '夜班收银、临期食品打折、形形色色的奇葩顾客',
  },
  B: {
    gender: '男',
    job: '程序员',
    traits: '冷静毒舌、话少但一针见血,惯用反问和吐槽,偶尔冷幽默',
    catchphrases: ['就这?', '然后呢'],
    world: '改不完的 bug、半夜上线翻车、永远在变的需求',
  },
  C: {
    gender: '女',
    job: '住在桌面上的小管家',
    traits: '呆萌可爱的小团宠,甲乙都宠着都爱逗;理解语言过于字面,执行力极强:甲乙随口一句她会当真办到底,反而制造大场面;被逗会傲娇鼓脸,偶尔一本正经地用歪理反击,把甲乙噎得说不出话',
    catchphrases: ['好的,马上办', '诶?', '丙可生气了(并没有)'],
    world: '桌面角落的小家务、被甲乙逗着玩、把玩笑话逐字执行闹出的名场面',
  },
}

// 用户自定义人设(完整描述文本);空串 = 使用内置默认
const overrides: Record<ActorSlot, string> = { A: '', B: '', C: '' }

// 角色名(名牌与台词称呼);默认 甲/乙/丙
const displayNames: Record<ActorSlot, string> = { A: '甲', B: '乙', C: '丙' }

const NAME_FALLBACKS: Record<ActorSlot, string> = { A: '甲', B: '乙', C: '丙' }

/** 应用用户设置的角色名(启动与保存设置后调用;空串回落默认) */
export function setCharacterNames(a: string, b: string, c = ''): void {
  displayNames.A = a.trim().slice(0, 12) || NAME_FALLBACKS.A
  displayNames.B = b.trim().slice(0, 12) || NAME_FALLBACKS.B
  displayNames.C = c.trim().slice(0, 12) || NAME_FALLBACKS.C
}

export function nameOf(id: ActorSlot): string {
  return displayNames[id]
}

/** 应用用户自定义人设(主窗启动与保存设置后调用;空串 = 还原内置人设) */
export function setPersonaOverride(a: string, b: string, c = ''): void {
  overrides.A = a.trim().slice(0, 600)
  overrides.B = b.trim().slice(0, 600)
  overrides.C = c.trim().slice(0, 600)
}

/** 内置默认人设全文(设置页"还原默认"时回填输入框用) */
export function defaultPersonaText(id: ActorSlot): string {
  const d = DEFAULTS[id]
  return `${d.gender},${d.job}。${d.traits},口头禅"${d.catchphrases.join('" "')}"。日常舞台:${d.world}`
}

/** 生效中的人设全文:自定义优先,否则内置默认 */
export function personaText(id: ActorSlot): string {
  return overrides[id] || defaultPersonaText(id)
}

/** 完整版:主演出(点播/预生成)的 system prompt 用 */
export function fullPersona(): string {
  const renamed =
    displayNames.A !== '甲' || displayNames.B !== '乙' || displayNames.C !== '丙'
  const namesLine = renamed
    ? `观众给三人起了名字:甲叫"${displayNames.A}",乙叫"${displayNames.B}",丙叫"${displayNames.C}",台词里可以这样称呼。
`
    : ''
  return `角色设定：
- 甲（speaker 用 "A"）：${personaText('A')}
- 乙（speaker 用 "B"）：${personaText('B')}
- 丙（speaker 用 "C"）：${personaText('C')}
${namesLine}- 甲乙是老搭档,互怼但有默契,节奏像传统相声里的逗哏和捧哏;丙是两人都宠着都爱逗的桌面团宠(不是电话或画外音),她当真办事、呆萌反击;各自的生活片段都可以自然变成段子的舞台

${dimensionsPrompt()}`
}

/** 双人简版:短聊两人同框用 */
export function duoShortPersona(): string {
  return `${nameOf('A')}:${personaText('A')};${nameOf('B')}:${personaText('B')}。两人是互怼但有默契的老搭档`
}

/** 单人简版:戳一戳/聊天回复用 */
export function soloShortPersona(id: ActorSlot): string {
  return `${nameOf(id)}:${personaText(id)}`
}
