// 三段式人设编译器回归:核心段尽量不截/超支截断、mes_example 前 3 组且优先于
// first_mes(预算不够先弃开场)、lore 只取 constant 且按 priority、逐条完整装入
// 不切半句、宏替换贯穿、warnings 与留档分类。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { composePersona, CORE_BUDGET, STYLE_BUDGET, LORE_BUDGET, PERSONA_BUDGET } = await import(
  '../src/cardImport/composePersona.ts'
)

const baseCard = (over = {}) => ({
  spec: 'chara_card_v2',
  name: '灰原哀',
  description: '科学家,冷淡但心软。',
  personality: '毒舌,聪明',
  scenario: '阿笠博士家',
  firstMes: '{{user}}来啦……哼。',
  mesExample: '<START>\n{{user}}: 早安\n{{char}}: ……咖啡。\n<START>\n{{user}}: 晚安\n{{char}}: 别吵。',
  alternateGreetings: [],
  creatorNotes: '',
  creator: '',
  characterVersion: '',
  tags: [],
  loreBook: undefined,
  ...over,
})

test('完整卡:三段结构齐全,宏替换贯穿,风格示例标注开场仅供参考', () => {
  const r = composePersona(baseCard(), { user: '柯南' })
  assert.ok(r.personaText.startsWith('【核心人设】'))
  assert.ok(r.personaText.includes('角色描述:科学家'))
  assert.ok(r.personaText.includes('性格:毒舌'))
  assert.ok(r.personaText.includes('场景背景:阿笠博士家'))
  const styleAt = r.personaText.indexOf('【表达风格参考】')
  assert.ok(styleAt > 0)
  assert.ok(r.personaText.includes('不代表当前情境,不要机械复述'))
  assert.ok(r.personaText.includes('灰原哀: ……咖啡。')) // {{char}} 已替换
  assert.ok(r.personaText.includes('柯南来啦')) // {{user}} 已替换
  assert.ok(r.personaText.indexOf('示例1') < r.personaText.indexOf('开场示例'), 'mes 组在前')
  assert.ok(!r.personaText.includes('{{char}}') && !r.personaText.includes('{{user}}'))
  assert.deepEqual(r.warnings, [])
})

test('mes_example 分组取前 3 组,之后的组不进', () => {
  const many = Array.from({ length: 5 }, (_, i) => `<START>\n第${i + 1}组对话`).join('')
  const r = composePersona(baseCard({ mesExample: many }), { user: 'u' })
  assert.ok(r.personaText.includes('第1组对话'))
  assert.ok(r.personaText.includes('第3组对话'))
  assert.ok(!r.personaText.includes('第4组对话'))
})

test('风格预算不足:先保 mes 组,超支先弃开场示例,并出 warning', () => {
  const mesGroup = '<START>\n' + '示例对话内容。'.repeat(200) // 1400 字,装入后所剩无几
  const longGreeting = '很长很长的开场独白。'.repeat(60) // 600 字,mes 装入后剩余预算不够
  const r = composePersona(baseCard({ mesExample: mesGroup, firstMes: longGreeting }), { user: 'u' })
  assert.ok(r.warnings.some((w) => w.includes('1 条超出预算')))
  assert.ok(r.personaText.includes('示例对话内容'), 'mes 组保住(mes 优先)')
  assert.ok(!r.personaText.includes('很长很长的开场独白'), '开场示例先弃')
})

test('单条风格示例整条超支:整组跳过不切半句,更小的开场示例仍可装入', () => {
  const hugeGroup = '<START>\n' + '很长的示例。'.repeat(600) // 3600 字 > 整段预算
  const r = composePersona(baseCard({ mesExample: hugeGroup, firstMes: '哼。' }), { user: 'u' })
  assert.ok(r.warnings.some((w) => w.includes('1 条超出预算')))
  const styleSection = r.personaText.slice(r.personaText.indexOf('【表达风格参考】'))
  assert.ok(!styleSection.includes('很长的示例'), '装不下的组整条跳过')
  assert.ok(styleSection.includes('哼。'), '预算内的小条目照常装入')
})

test('lore:只装 constant 且 enabled,按 priority 降序,超预算即停不切半句', () => {
  const lore = [
    { keys: ['a'], content: '关键词条目不进', constant: false, priority: 999, enabled: true },
    { keys: [], content: '低优先常驻。'.repeat(10), constant: true, priority: 1, enabled: true },
    { keys: [], content: '高优先常驻。'.repeat(190), constant: true, priority: 9, enabled: true },
    { keys: [], content: '被禁用的常驻。', constant: true, priority: 5, enabled: false },
  ]
  const r = composePersona(baseCard({ loreBook: lore }), { user: 'u' })
  const loreSection = r.personaText.slice(r.personaText.indexOf('【长期背景设定】'))
  assert.ok(loreSection.includes('高优先常驻'))
  assert.ok(!loreSection.includes('低优先常驻'), '预算被高优先占满后,低优先整条不装')
  assert.ok(!loreSection.includes('关键词条目'))
  assert.ok(!loreSection.includes('被禁用'))
  assert.ok(r.warnings.some((w) => w.includes('常驻世界设定超出预算')))
  // 完整条目语义:被装入的都是整条
  for (const e of r.bakedLore) assert.ok(loreSection.includes(e.content))
  // 留档:非 constant + 预算外 + 禁用,全部落 keywordLore
  assert.equal(r.keywordLore.length, 3)
  assert.ok(r.keywordLore.some((e) => e.keys.includes('a')))
})

test('核心段超支:单条截断加省略号,不出现在风格/lore 段', () => {
  const huge = '很长的人设。'.repeat(1000) // 远超 CORE_BUDGET
  const r = composePersona(baseCard({ description: huge, personality: '', scenario: '' }), { user: 'u' })
  assert.ok(r.warnings.some((w) => w.includes('角色描述')))
  const idx = r.personaText.indexOf('【表达风格参考】')
  const coreSection = idx >= 0 ? r.personaText.slice(0, idx) : r.personaText
  assert.ok(coreSection.length <= CORE_BUDGET + 10, `核心段 ${coreSection.length} 应贴着预算 ${CORE_BUDGET}`)
  assert.ok(coreSection.trimEnd().endsWith('…'))
})

test('空卡:人设为空并提示;预算常量自洽', () => {
  const r = composePersona(baseCard({ description: '', personality: '', scenario: '', firstMes: '', mesExample: '' }), { user: 'u' })
  assert.equal(r.personaText, '')
  assert.ok(r.warnings.some((w) => w.includes('没有可用的设定内容')))
  assert.equal(CORE_BUDGET + STYLE_BUDGET + LORE_BUDGET, PERSONA_BUDGET)
})

test('名字超 12 字出 warning(截断由调用方执行)', () => {
  const r = composePersona(baseCard({ name: '一二三四五六七八九十一二三' }), { user: 'u' })
  assert.ok(r.warnings.some((w) => w.includes('超过 12 字')))
  assert.equal(r.personaText.includes('一二三四五六七八九十一二三'), true) // 人设内保留全名
})
