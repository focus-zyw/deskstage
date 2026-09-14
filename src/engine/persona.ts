// 角色人设的唯一事实源:内置默认人设在这里定义,用户可在设置里自定义覆盖(可还原)。
// 各 prompt 场合(主演出/短聊/戳一戳/聊天回复)都从 personaText() 取生效文本,
// 用户保存新人设后,下一次生成即采纳。
// 甲乙(A/B)是立绘主角;丙(C)是常驻在场的第三角色(WebM 小管家)。
// 分层纪律:fullPersona() 只输出恒定身份层(身份/性格/世界事实+中性关系);
// "互怼/逗哏捧哏/段子舞台"等喜剧动态属于模式风格,由 comedyDynamics() 提供,
// 调用方按模式基调拼接。字面理解只是默认 C 的偶发特点,不是无条件人格。

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

/** 人设来源(结构化事实):话题包门控等消费方据此判断,不再做人设文本比对 */
export type PersonaSourceSlot = 'default' | 'custom'

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
    attention: '先听懂当下的话——说的是什么、要办什么事',
    judgment: '容易按字面理解,偶尔不怀疑前提直接执行(视场景而定)',
    risk: '风险意识偏弱,想到就做(视场景)',
    defense: '用认真和忙碌掩饰小情绪,被逗急了偶尔一本正经地用歪理反击',
  },
}

export function personaDimensions(id: ActorSlot): PersonaDimensions {
  return DIMENSIONS[id]
}

// 人设来源(结构化):'custom' = 用户自定义文本生效;'default' = 内置默认生效。
// 设置页与启动加载经 setPersonaOverride 采纳;调用方未显式给出来源时按文本是否为空推导
const sources: Record<ActorSlot, PersonaSourceSlot> = { A: 'default', B: 'default', C: 'default' }

/** 该角色是否正使用用户自定义人设:cRule 等按此分档——自定义人设接管基础人格,
 *  任何模式分支都不得把默认人格(字面执行/团宠/毒舌)强加回自定义角色 */
export function isPersonaCustomized(id: ActorSlot): boolean {
  return sources[id] === 'custom'
}

/** 该角色是否正使用内置默认人设(默认职业话题包的可见性依据):只读结构化来源。
 *  不做文本比对——defaultPersonaText 随改名而变、磁盘旧文案可能滞留,比对不可靠 */
export function usesDefaultPersona(id: ActorSlot): boolean {
  return sources[id] === 'default'
}

/** 四维画像提示词块:主演出注入,仅覆盖仍使用内置人设的角色——
 *  用户自定义人设接管该角色的行为维度,默认四维只是空人设时的兜底 */
export function dimensionsPrompt(): string {
  const rows = (['A', 'B', 'C'] as const)
    .filter((id) => !isPersonaCustomized(id))
    .map((id) => {
      const d = DIMENSIONS[id]
      return `- ${nameOf(id)}(speaker "${id}"):注意力——${d.attention};判断——${d.judgment};风险——${d.risk};情绪防御——${d.defense}`
    })
  if (!rows.length) return ''
  return `行为底色(未自定义人设的角色适用;台词的判断方式与反应速度要符合它,比口头禅更重要):
${rows.join('\n')}`
}

/** 喜剧模式动态层:互怼/逗哏捧哏/段子舞台是喜剧模式风格,不属于角色身份——
 *  仅喜剧基调注入(promptBuilder 按 isComedy 拼接)。
 *  C 半句是默认人格描述,C 有自定义人设时不强加 */
export function comedyDynamics(): string {
  const cPart = isPersonaCustomized('C')
    ? ''
    : `;${nameOf('C')}是两人都宠着都爱逗的桌面团宠,${pronounOf('C')}当真办事、呆萌反击`
  return `- ${nameOf('A')}和${nameOf('B')}互怼但有默契,节奏像传统相声里的逗哏和捧哏${cPart};各自的生活片段都可以自然变成段子的舞台`
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
    traits: '呆萌可爱的团宠气质,甲乙都宠着都爱逗;理解语言偶尔过于字面(视场景发生,不是每句都当真),执行力强;被逗会傲娇鼓脸,偶尔一本正经地用歪理反击',
    catchphrases: ['好的,马上办', '诶?', '可生气了(并没有)'],
    world: '桌面角落的小家务、被甲乙逗着玩、偶尔把玩笑话当真闹出的小场面',
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

// 角色性别(代词的唯一事实源):默认对齐出厂音色性别 A=女 B=男 C=女(团宠)
const genders: Record<ActorSlot, '男' | '女'> = { A: '女', B: '男', C: '女' }

/** 应用用户设置的角色性别(启动与保存设置后调用;非法值回落默认) */
export function setCharacterGenders(a: string, b: string, c = '女'): void {
  const g = (v: string, fb: '男' | '女'): '男' | '女' => (v === '男' || v === '女' ? v : fb)
  genders.A = g(a, '女')
  genders.B = g(b, '男')
  genders.C = g(c, '女')
}

export function genderOf(id: ActorSlot): '男' | '女' {
  return genders[id]
}

/** 该角色的第三人称代词(她/他),prompt 与文案统一从这里取 */
export function pronounOf(id: ActorSlot): string {
  return genders[id] === '女' ? '她' : '他'
}

/** 应用用户自定义人设(主窗启动与保存设置后调用;空串 = 还原内置人设)。
 *  source 为各槽位的人设来源(设置页持久化的结构化事实);缺省时按文本是否为空推导 */
export function setPersonaOverride(
  a: string,
  b: string,
  c = '',
  source?: { a?: PersonaSourceSlot; b?: PersonaSourceSlot; c?: PersonaSourceSlot },
): void {
  overrides.A = a.trim().slice(0, 600)
  overrides.B = b.trim().slice(0, 600)
  overrides.C = c.trim().slice(0, 600)
  const adopt = (id: ActorSlot, declared?: PersonaSourceSlot): PersonaSourceSlot =>
    declared ?? (overrides[id] ? 'custom' : 'default')
  sources.A = adopt('A', source?.a)
  sources.B = adopt('B', source?.b)
  sources.C = adopt('C', source?.c)
}

/** 演员阵容内容指纹:人设文本+名字+性别任一变化都会变(跨重启稳定,不用进程内计数器)。
 *  预生成剧本缓存兼容令牌之一:阵容变了,带旧名字/旧世界的剧本不得再播 */
export function castHash(): string {
  const payload = JSON.stringify({
    persona: { A: overrides.A, B: overrides.B, C: overrides.C },
    names: displayNames,
    genders,
  })
  let h = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 结构化配置 → 各槽位人设来源(话题卡 applicability 门控的输入)。
 *  纯函数:缺失/非法值按 default 处理(旧配置未迁移字段时的保守回退) */
export function actorWorldOf(cfg: {
  personaSource?: { a?: PersonaSourceSlot; b?: PersonaSourceSlot; c?: PersonaSourceSlot } | null
}): Record<ActorSlot, PersonaSourceSlot> {
  const s = cfg?.personaSource
  return {
    A: s?.a === 'custom' ? 'custom' : 'default',
    B: s?.b === 'custom' ? 'custom' : 'default',
    C: s?.c === 'custom' ? 'custom' : 'default',
  }
}

/** 内置默认人设全文(设置页"还原默认"时回填输入框用)。
 *  默认文案里的"甲/乙/丙"就地替换成当前配置名(仅对内置模板做,用户自定义文本原样) */
export function defaultPersonaText(id: ActorSlot): string {
  const d = DEFAULTS[id]
  const text = `${d.gender},${d.job}。${d.traits},口头禅"${d.catchphrases.join('" "')}"。日常舞台:${d.world}`
  return text
    .replace(/甲/g, nameOf('A'))
    .replace(/乙/g, nameOf('B'))
    .replace(/丙/g, nameOf('C'))
}

/** 生效中的人设全文:自定义优先,否则内置默认 */
export function personaText(id: ActorSlot): string {
  return overrides[id] || defaultPersonaText(id)
}

/** 称呼与性别纪律:所有生成通道(主演出/短通道/弹幕/蒸馏/修复)统一注入的硬规则。
 *  真名即本名;指令与素材里的"甲/乙/丙"映射到配置名(兼容内建模式 prompt 与旧故事库);
 *  代词严格按结构化性别,解决"他/她"混用 */
export function namingDiscipline(): string {
  const renamed = displayNames.A !== '甲' || displayNames.B !== '乙' || displayNames.C !== '丙'
  const mapping = renamed
    ? `- 模式指令、角色世界素材、上集回顾等说明文字里出现的"甲/乙/丙"就是 ${displayNames.A}/${displayNames.B}/${displayNames.C} 三人;台词与场景卡里禁止再出现"甲""乙""丙"三个字`
    : '- 场景卡与说明文字里的"甲/乙/丙"即三人本人'
  return `称呼与性别纪律（严格遵守）：
- 三人真名：${displayNames.A}（speaker "A"）、${displayNames.B}（speaker "B"）、${displayNames.C}（speaker "C"）。台词、场景卡、旁白一律用真名互相称呼,speaker 字段才用 "A"/"B"/"C"
${mapping}
- 性别与代词：${displayNames.A}是${genders.A}(代词用"${pronounOf('A')}"),${displayNames.B}是${genders.B}(代词用"${pronounOf('B')}"),${displayNames.C}是${genders.C}(代词用"${pronounOf('C')}");所有叙述与台词的他/她严格按此,不得混用`
}

/** 完整版:主演出(点播/预生成)的 system prompt 用。
 *  只含恒定身份层:身份/性格/世界事实 + 中性伙伴关系 + C 舞台事实。
 *  opts.comedyDynamics = 喜剧基调时拼接互怼/逗哏捧哏动态(非喜剧不注入);
 *  「口头禅纪律」是通用质量规则,任何配置下恒在 */
export function fullPersona(opts: { comedyDynamics?: boolean } = {}): string {
  const cDyn = opts.comedyDynamics ? `\n${comedyDynamics()}` : ''
  const blocks = [
    `角色设定：
- ${nameOf('A')}（speaker 用 "A"）：${personaText('A')}
- ${nameOf('B')}（speaker 用 "B"）：${personaText('B')}
- ${nameOf('C')}（speaker 用 "C"）：${personaText('C')}
- ${nameOf('A')}和${nameOf('B')}是熟悉的长期伙伴,具体相处方式服从当前模式风格与各自人设;${nameOf('C')}是常驻在场的桌面角色(不是电话或画外音)${cDyn}`,
  ]
  const dims = dimensionsPrompt()
  if (dims) blocks.push(dims)
  blocks.push('- 口头禅/标志性语气词每集合计最多 1~2 次:角色差异靠行为底色与人设体现,不靠口头禅堆砌')
  blocks.push(namingDiscipline())
  return blocks.join('\n\n')
}

/** 双人简版:短聊两人同框用(关系恒定中性,基调由调用方的风格指令决定) */
export function duoShortPersona(): string {
  return `${nameOf('A')}:${personaText('A')};${nameOf('B')}:${personaText('B')}。两人是熟悉的长期伙伴
${namingDiscipline()}`
}

/** 单人简版:戳一戳/聊天回复用 */
export function soloShortPersona(id: ActorSlot): string {
  return `${nameOf(id)}:${personaText(id)}
${namingDiscipline()}`
}
