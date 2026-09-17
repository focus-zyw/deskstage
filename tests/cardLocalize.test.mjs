// 语义本地化回归(fake complete 零网络):语言判定(中/英/日/韩/混排)、
// 中文卡零调用、三路本地化(core/style/lore)、<START> 保留、keys=原文+中文别名、
// 失败 fail-open 按原文导入、超长字段切块顺序翻译。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { needsLocalization, cardNeedsLocalization, localizeRawCard } = await import('../src/cardImport/localize.ts')

const baseCard = (over = {}) => ({
  spec: 'chara_card_v2',
  name: 'Kurisu',
  description: 'A genius neuroscientist.',
  personality: 'Tsundere, sharp-tongued.',
  scenario: 'A lab in Akihabara.',
  firstMes: 'Huh? Who are you?',
  mesExample: '<START>\n{{user}}: hi\n{{char}}: …hello.',
  alternateGreetings: [],
  creatorNotes: '',
  creator: '',
  characterVersion: '',
  tags: [],
  loreBook: undefined,
  ...over,
})

test('语言判定:中/英/日/韩/中英混排', () => {
  assert.equal(needsLocalization('她是一个天才科学家,性格傲娇。'), false)
  assert.equal(needsLocalization('A genius neuroscientist with tsundere personality.'), true)
  assert.equal(needsLocalization('彼女は天才科学者です。'), true) // 假名
  assert.equal(needsLocalization('그녀는 천재 과학자입니다.'), true) // 谚文
  assert.equal(needsLocalization('她是研究员,常出没于 Radio 会馆。'), false) // 少量拉丁不算
  assert.equal(needsLocalization(''), false)
})

test('全中卡:cardNeedsLocalization=false,零 LLM 调用', async () => {
  const calls = []
  const r = await localizeRawCard(
    baseCard({
      name: '灰原哀',
      description: '天才科学家。',
      personality: '毒舌傲娇。',
      scenario: '秋叶原的实验室。',
      firstMes: '哼,你是谁?',
      mesExample: '<START>\n观众: 早\n灰原哀: ……嗯。',
    }),
    { complete: async (input) => { calls.push(input); return '{}' } },
  )
  assert.equal(calls.length, 0)
  assert.equal(r.localized, false)
  assert.equal(r.card.description, '天才科学家。')
})

test('英文卡:三路并行本地化,core/style/lore 全译,keys=原文+中文别名', async () => {
  const lore = [
    { keys: ['Organization'], content: 'The secret organization.', constant: false, priority: 5, enabled: true },
    { keys: [], content: 'The lab is in Akihabara.', constant: true, priority: 9, enabled: true },
  ]
  const calls = []
  const complete = async (input) => {
    calls.push(input)
    const system = input.messages[0].content
    if (system.includes('世界书')) {
      const user = input.messages[1].content
      const payload = JSON.parse(user.slice(user.indexOf('['), user.lastIndexOf(']') + 1))
      return JSON.stringify({
        entries: payload.map((p) => ({ i: p.i, content: `【中】${p.content}`, aliases: p.keys.map((k) => `中·${k}`) })),
      })
    }
    if (system.includes('<START>')) {
      return JSON.stringify({ first_mes: '哈?你是谁?', mes_example: '<START>\n观众: 早\n库莉丝: ……嗯。' })
    }
    return JSON.stringify({ text: '【中文】' + input.messages[1].content.slice(0, 5) })
  }
  const r = await localizeRawCard(baseCard({ loreBook: lore }), { complete })
  assert.equal(r.localized, true)
  assert.ok(r.card.description.startsWith('【中文】'))
  assert.ok(r.card.personality.startsWith('【中文】'))
  assert.ok(r.card.scenario.startsWith('【中文】'))
  assert.equal(r.card.firstMes, '哈?你是谁?')
  assert.ok(r.card.mesExample.startsWith('<START>'), '分隔符保留')
  const keyword = r.card.loreBook.find((e) => e.keys.includes('Organization'))
  assert.ok(keyword.content.startsWith('【中】'))
  assert.ok(keyword.keys.includes('中·Organization'), '中文别名并入 keys')
  assert.deepEqual(keyword.aliases, ['中·Organization'])
  const baked = r.card.loreBook.find((e) => e.constant)
  assert.ok(baked.content.startsWith('【中】'))
  // 三路调用齐:core(≥1)/style/lore
  const systems = calls.map((c) => c.messages[0].content)
  assert.ok(systems.some((s) => s.includes('角色设定')))
  assert.ok(systems.some((s) => s.includes('<START>')))
  assert.ok(systems.some((s) => s.includes('世界书')))
})

test('本地化失败 fail-open:按原文导入 + warning', async () => {
  const r = await localizeRawCard(baseCard(), {
    complete: async () => {
      throw new Error('端点挂了')
    },
  })
  assert.equal(r.localized, false)
  assert.equal(r.card.description, 'A genius neuroscientist.')
  assert.ok(r.warnings.length >= 1)
  assert.ok(r.warnings.every((w) => w.includes('按原文')))
})

test('超长字段按段落切块顺序翻译,块间换行拼接', async () => {
  const para = 'A'.repeat(1500)
  const description = Array.from({ length: 4 }, () => para).join('\n') // ~6000 字 → 2~3 块
  const calls = []
  const complete = async (input) => {
    calls.push(input)
    return JSON.stringify({ text: `中(${calls.length})` })
  }
  const r = await localizeRawCard(baseCard({ description }), { complete })
  const coreCalls = calls.length
  assert.ok(coreCalls >= 2, `长字段应切块,实际 ${coreCalls} 次调用`)
  assert.ok(r.card.description.startsWith('中(1)'))
  assert.ok(r.card.description.includes('\n'), '块间保留换行')
  assert.ok(!r.card.description.includes('AAAA'))
})

test('cardNeedsLocalization:世界书正文也会触发', () => {
  const zh = { description: '中文描述', personality: '中文性格', scenario: '中文场景', firstMes: '中文开场', mesExample: '<START>\n中文示例' }
  assert.equal(
    cardNeedsLocalization(baseCard({ ...zh, loreBook: [{ keys: [], content: 'English lore content.', constant: true, priority: 1, enabled: true }] })),
    true,
  )
  assert.equal(
    cardNeedsLocalization(baseCard({ ...zh, loreBook: [{ keys: [], content: '被禁用不触发', constant: true, priority: 1, enabled: false }] })),
    false,
  )
})
