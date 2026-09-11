// 关系事件账本回归:蒸馏发现的关系转折 → 记账(带 eid,最多 20 条)+ 小步聚合 trust/rivalry。
// 痛点:对话里的和解/背叛/较劲原本不影响关系数值,数值变化没有来由(doc §7)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let story
let curator

before(async () => {
  const values = new Map()
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  story = await server.ssrLoadModule('/src/storage/storyStore.ts')
  curator = await server.ssrLoadModule('/src/engine/storyCurator.ts')
})

after(async () => {
  await server?.close()
  delete globalThis.localStorage
})

const distilled = (over = {}) => ({
  newGags: [],
  newThreads: [],
  resolvedThreadIds: [],
  reusedGagIds: [],
  arcAdvance: null,
  newArc: null,
  relationshipEvent: null,
  ...over,
})

const lines = [{ speaker: 'A', text: '行吧行吧,这杯我请,别气了', action: '' }]

test('关系事件:记账进账本(带 eid)并按映射小步聚合', async () => {
  const report = await curator.curateEpisode(lines, {
    eid: 'e-repair-1',
    distill: async () =>
      distilled({
        relationshipEvent: { kind: 'repair', actor: 'A', target: 'B', weight: 1, summary: '甲请冰可乐向乙求和' },
      }),
  })
  assert.ok(report.relationship, '报告带关系事件')
  assert.equal(report.relationship.kind, 'repair')
  const after = await story.getStory()
  assert.equal(after.bond.trust, 1.5) // 默认 1 + repair 0.5
  assert.equal(after.bond.rivalry, 0) // 0 - 0.25 被钳到 0
  assert.equal(after.bond.events?.length, 1)
  assert.equal(after.bond.events[0].eid, 'e-repair-1')
  assert.equal(after.bond.events[0].summary, '甲请冰可乐向乙求和')
})

test('关系事件:weight 缩放数值变化,betrayal 掉信任加摩擦', async () => {
  await curator.curateEpisode(lines, {
    eid: 'e-betray-1',
    distill: async () =>
      distilled({
        relationshipEvent: { kind: 'betrayal', actor: 'B', target: 'A', weight: 0.5, summary: '乙把甲的糗事发进观众群' },
      }),
  })
  const bond = (await story.getStory()).bond
  assert.equal(bond.trust, 1.25) // 1.5 - 0.5*0.5
  assert.equal(bond.rivalry, 0.125) // 0 + 0.25*0.5
  assert.equal(bond.events?.length, 2) // 新事件在前
  assert.equal(bond.events[0].kind, 'betrayal')
})

test('没有关系事件的集:关系数值与账本都不动', async () => {
  const before = await story.getStory()
  const report = await curator.curateEpisode(lines, {
    distill: async () => distilled(),
  })
  assert.equal(report.relationship, undefined)
  const after = await story.getStory()
  assert.equal(after.bond.trust, before.bond.trust)
  assert.equal(after.bond.rivalry, before.bond.rivalry)
  assert.equal(after.bond.events?.length, before.bond.events?.length)
})

test('涉及丙的关系事件:只进账本当叙事记忆,不驱动甲乙数值(团宠不搞帮谁拆谁)', async () => {
  const before = await story.getStory()
  const report = await curator.curateEpisode(lines, {
    eid: 'e-c-1',
    distill: async () =>
      distilled({
        relationshipEvent: { kind: 'betrayal', actor: 'C', target: 'A', weight: 1, summary: '丙把甲的牛皮当真执行,让甲当众下不来台' },
      }),
  })
  assert.ok(report.relationship, '报告带关系事件')
  const after = await story.getStory()
  assert.equal(after.bond.trust, before.bond.trust, 'C 事件不改信任')
  assert.equal(after.bond.rivalry, before.bond.rivalry, 'C 事件不改摩擦')
  assert.equal(after.bond.events?.length, (before.bond.events?.length ?? 0) + 1, '账本保留叙事记忆')
  assert.equal(after.bond.events[0].eid, 'e-c-1')
})
