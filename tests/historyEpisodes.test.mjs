// 场景卡成为正式剧集数据的回归:
// ①parseGeneratedDialog 解析出的 card 必须随 PerformanceScript 保留(曾被类型丢弃);
// ②card 作为集级元数据盖在历史首行,聚合时还原到集上;旧格式无 card 条目天然兼容。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let history
let schema

before(async () => {
  history = await import('../src/storage/historyStore.ts')
  schema = await import('../src/performer/dialogSchema.ts')
})


const line = (speaker, text) => ({ speaker, text, action: '' })

const card = {
  relationship: '老搭档',
  scene: '雨天便利店门口躲雨',
  goalA: '甲想蹭乙的伞',
  goalB: '乙想让甲认清天气预报不靠谱',
  secret: '乙早上刚看了暴雨预警没说',
  escalation: ['甲嘲笑天气预报', '乙掏出预警截图'],
  callback: '预报截图',
}

test('parseGeneratedDialog:场景卡随剧本解析保留,不再被丢弃', () => {
  const raw = JSON.stringify({
    card,
    dialog: [
      line('A', '这雨下得也太不讲武德了'),
      line('B', '你出门前不看天气预报的吗'),
      line('A', '看了,它说是多云'),
      line('B', '那这雨是它编外的'),
    ],
  })
  const script = schema.parseGeneratedDialog(raw)
  assert.equal(script.card?.relationship, '老搭档')
  assert.equal(script.card?.secret, '乙早上刚看了暴雨预警没说')
  assert.deepEqual(script.card?.escalation, ['甲嘲笑天气预报', '乙掏出预警截图'])
  assert.equal(script.before.length, 4)
})

test('aggregateEpisodes:首行的 card 还原为集级元数据,且不泄漏进台词行', () => {
  const entries = [
    { ts: 100, mode: 'daily', speaker: 'A', text: '第一句', action: '', card },
    { ts: 100, mode: 'daily', speaker: 'B', text: '第二句', action: '' },
    { ts: 200, mode: 'daily', speaker: 'A', text: '另一集', action: '' },
  ]
  const eps = history.aggregateEpisodes(entries)
  assert.equal(eps.length, 2)
  assert.equal(eps[0].lines.length, 2)
  assert.equal(eps[0].card?.scene, '雨天便利店门口躲雨')
  assert.equal(eps[0].lines[0].card, undefined) // card 是集元数据,不留在台词上
  assert.equal(eps[1].card, undefined) // 旧格式条目没有 card,集上也没有(向后兼容)
})

test('aggregateEpisodes:card 缺失校验的坏卡(如 escalation 为空)被清洗掉', () => {
  const entries = [
    {
      ts: 7,
      mode: 'daily',
      speaker: 'A',
      text: '只有一句话的集',
      action: '',
      card: { ...card, escalation: [] }, // sanitizeSceneCard 会拒绝
    },
  ]
  const eps = history.aggregateEpisodes(entries)
  assert.equal(eps.length, 1)
  assert.equal(eps[0].card, undefined)
})

test('aggregateEpisodes:同 eid 跨 ts 聚合为一集,与旧格式按 ts 的集互不干扰', () => {
  const eid = 'e1789062906858unit'
  const entries = [
    { ts: 100, mode: 'daily', speaker: 'A', text: '铺垫', action: '', eid },
    { ts: 180, mode: 'daily', speaker: 'B', text: '分支', action: '', eid },
    { ts: 150, mode: 'daily', speaker: 'A', text: '旧格式整集', action: '' },
  ]
  const eps = history.aggregateEpisodes(entries)
  assert.equal(eps.length, 2)
  const merged = eps.find((e) => e.eid === eid)
  assert.ok(merged, 'eid 相同的两行归并为一集')
  assert.equal(merged.lines.length, 2)
  assert.equal(merged.lines[0].text, '铺垫')
  assert.equal(merged.ts, 100) // 集 ts 取首行
  assert.equal(merged.eid, eid)
  assert.equal(merged.lines[0].eid, undefined) // eid 是集元数据,不留在台词上
  const legacy = eps.find((e) => !e.eid)
  assert.equal(legacy.ts, 150) // 旧格式无 eid,按 ts 独立成集
  assert.equal(legacy.lines.length, 1)
})
