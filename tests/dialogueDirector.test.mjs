// DialogueDirector 编排回归:准备→采纳→提交的生命周期收拢。
// 依赖全注入,不碰网络与磁盘:参数透传、eid 分配、自然/中止提交分路、采纳空跳过。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let mod

before(async () => {
  mod = await import('../src/dialogue/director.ts')
})


const line = (speaker, text) => ({ speaker, text, action: '' })
const script = () => ({ before: [line('A', '1'), line('B', '2')], after: {} })
// 最小合法 TopicPlan(新契约:prepareEpisode 只收话题计划)
const fakePlan = (title) => ({
  planId: `tp-${title}`,
  createdAt: 0,
  expiresAt: 9e15,
  baseRevision: 0,
  lane: 'manual',
  mode: 'daily',
  intent: 'new',
  card: {
    id: `tc-${title}`,
    title,
    hook: title,
    category: 'life',
    tags: [],
    source: 'manual',
    fingerprint: `fp-${title}`,
    sensitivity: 'normal',
    generatedAt: 0,
  },
  policy: 'strict',
  stage: 'open',
  episodeFocus: title,
  allowedBranches: [],
  avoid: [],
  duration: 'once',
  compatibility: { sessionRevision: 0, banHash: '', modeHash: '', plannerVersion: 1 },
})

test('prepareEpisode:请求参数透传给生成器,并分配稳定 eid', async () => {
  const calls = []
  const d = mod.createDialogueDirector({
    generate: async (...args) => {
      calls.push(args)
      return script()
    },
    newId: () => 'e-1',
  })
  const plan = fakePlan('泡面')
  const { script: s, eid } = await d.prepareEpisode({
    mode: 'daily',
    topicPlan: plan,
    recentLines: [],
    deferContextAdoption: true,
  })
  assert.equal(eid, 'e-1')
  assert.equal(s.before.length, 2)
  const req = calls[0][0]
  assert.equal(req.mode, 'daily')
  assert.equal(req.topicPlan, plan, '话题计划原样透传')
  assert.equal(req.continueFromPrevious, false)
  assert.equal(req.deferContextAdoption, true) // 预生成零副作用
})

test('commitEpisode 自然完播:历史全路径 + 蒸馏带 eid,报告透传', async () => {
  const calls = []
  const report = { addedGags: ['x'] }
  const d = mod.createDialogueDirector({
    append: async (lines, mode, meta) => calls.push(['append', mode, meta, lines.length]),
    curate: async (lines, opts) => {
      calls.push(['curate', opts])
      return report
    },
  })
  const out = await d.commitEpisode({
    eid: 'e-9',
    mode: 'daily',
    topic: '话题',
    played: [line('A', '1'), line('B', '2')],
    natural: true,
  })
  assert.equal(out, report)
  const append = calls.find((c) => c[0] === 'append')
  assert.equal(append[1], 'daily')
  assert.equal(append[2].eid, 'e-9')
  assert.equal(append[2].topic, '话题')
  assert.equal(append[3], 2)
  assert.deepEqual(calls.find((c) => c[0] === 'curate')[1], { eid: 'e-9' })
})

test('commitEpisode 中止:只落历史前缀,不蒸馏', async () => {
  const calls = []
  const d = mod.createDialogueDirector({
    append: async () => calls.push('append'),
    curate: async () => calls.push('curate'),
  })
  const out = await d.commitEpisode({
    eid: 'e',
    mode: 'daily',
    played: [line('A', '1')],
    natural: false,
  })
  assert.equal(out, null)
  assert.deepEqual(calls, ['append'])
})

test('adoptDeferred:无 adoption 空操作,有则透传', async () => {
  const calls = []
  const d = mod.createDialogueDirector({
    adopt: async (a) => calls.push(a),
  })
  d.adoptDeferred({ before: [], after: {} })
  assert.equal(calls.length, 0)
  const adoption = { threadIds: ['t1'], hasRecap: true }
  d.adoptDeferred({ before: [], after: {}, adoption })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].threadIds[0], 't1')
})
