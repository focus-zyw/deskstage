// 角色人设的唯一事实源:内置默认人设在这里定义,用户可在设置里自定义覆盖(可还原)。
// 各 prompt 场合(主演出/短聊/戳一戳/聊天回复)都从 personaText() 取生效文本,
// 用户保存新人设后,下一次生成即采纳。

export interface PersonaDefaults {
  gender: '女' | '男'
  job: string
  traits: string
  catchphrases: readonly string[]
  world: string
}

const DEFAULTS: Record<'A' | 'B', PersonaDefaults> = {
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
}

// 用户自定义人设(完整描述文本);空串 = 使用内置默认
const overrides: Record<'A' | 'B', string> = { A: '', B: '' }

// 角色名(名牌与台词称呼);默认 甲/乙
const displayNames: Record<'A' | 'B', string> = { A: '甲', B: '乙' }

/** 应用用户设置的角色名(启动与保存设置后调用;空串回落默认) */
export function setCharacterNames(a: string, b: string): void {
  displayNames.A = a.trim().slice(0, 12) || '甲'
  displayNames.B = b.trim().slice(0, 12) || '乙'
}

export function nameOf(id: 'A' | 'B'): string {
  return displayNames[id]
}

/** 应用用户自定义人设(主窗启动与保存设置后调用;空串 = 还原内置人设) */
export function setPersonaOverride(a: string, b: string): void {
  overrides.A = a.trim().slice(0, 600)
  overrides.B = b.trim().slice(0, 600)
}

/** 内置默认人设全文(设置页"还原默认"时回填输入框用) */
export function defaultPersonaText(id: 'A' | 'B'): string {
  const d = DEFAULTS[id]
  return `${d.gender},${d.job}。${d.traits},口头禅"${d.catchphrases.join('" "')}"。日常舞台:${d.world}`
}

/** 生效中的人设全文:自定义优先,否则内置默认 */
export function personaText(id: 'A' | 'B'): string {
  return overrides[id] || defaultPersonaText(id)
}

/** 完整版:主演出(点播/预生成)的 system prompt 用 */
export function fullPersona(): string {
  const renamed = displayNames.A !== '甲' || displayNames.B !== '乙'
  const namesLine = renamed
    ? `观众给两人起了名字:甲叫"${displayNames.A}",乙叫"${displayNames.B}",台词里可以这样称呼。
`
    : ''
  return `角色设定：
- 甲（speaker 用 "A"）：${personaText('A')}
- 乙（speaker 用 "B"）：${personaText('B')}
${namesLine}- 两人是老搭档,互怼但有默契,节奏像传统相声里的逗哏和捧哏;各自的生活片段都可以自然变成段子的舞台`
}

/** 双人简版:短聊两人同框用 */
export function duoShortPersona(): string {
  return `${nameOf('A')}:${personaText('A')};${nameOf('B')}:${personaText('B')}。两人是互怼但有默契的老搭档`
}

/** 单人简版:戳一戳吐槽/聊天回复用 */
export function soloShortPersona(id: 'A' | 'B'): string {
  return `${nameOf(id)}:${personaText(id)}`
}
