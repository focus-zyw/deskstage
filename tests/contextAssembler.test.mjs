// Assembler 回归:滚动摘要恒注入、历史集摘要相关性+新近排序 top2、restricted
// 防御性过滤、空态返回 undefined、经历行渲染与 fail-open 空态。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { createWarmAssembler } = await import('../src/context/assembler.ts')

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

const session = (over = {}) => ({ id: 's1', startedTs: NOW - DAY, lastActiveTs: NOW, rollingSummary: '', foldedTurnIds: [], ...over })
const episode = (over = {}) => ({ id: 'e', fromTs: NOW - 2 * DAY, toTs: NOW - DAY, summary: '', sourceIds: [], sensitivity: 'normal', ...over })

test('滚动摘要恒注入;无摘要无集时返回 undefined', async () => {
  const a = createWarmAssembler({ currentSession: async () => null, listEpisodes: async () => [] })
  assert.equal(await a.warmLine('任何话'), undefined)

  const b = createWarmAssembler({
    currentSession: async () => session({ rollingSummary: '用户在准备修电脑' }),
    listEpisodes: async () => [],
  })
  const line = await b.warmLine('修电脑')
  assert.ok(line.includes('刚才之前聊过'))
  assert.ok(line.includes('用户在准备修电脑'))
})

test('历史集摘要:相关性优先,新近兜底,最多 2 条', async () => {
  const eps = [
    episode({ id: 'e-rel', summary: '用户聊了修电脑的计划', toTs: NOW - 10 * DAY }),
    episode({ id: 'e-fresh', summary: '完全无关的话题聊天', toTs: NOW - 3600_000 }),
    episode({ id: 'e-old-noise', summary: '另一段无关旧事', toTs: NOW - 13 * DAY }),
  ]
  const a = createWarmAssembler({ currentSession: async () => null, listEpisodes: async () => eps })
  const line = (await a.warmLine('电脑'))
  assert.ok(line.includes('修电脑的计划')) // 相关性胜出
  assert.ok(line.includes('无关的话题聊天')) // 新近兜底
  assert.ok(!line.includes('另一段无关旧事')) // 第三条被截
  assert.ok(line.startsWith('此前聊过'))
})

test('restricted 集摘要防御性过滤(入库已拦,注入再拦一道)', async () => {
  const eps = [
    episode({ summary: '用户提到过敏药的事', sensitivity: 'restricted' }),
    episode({ summary: '正常的一次闲聊', toTs: NOW - 3600_000 }),
  ]
  const a = createWarmAssembler({ currentSession: async () => null, listEpisodes: async () => eps })
  const line = (await a.warmLine('闲聊'))
  assert.ok(!line.includes('过敏'))
  assert.ok(line.includes('正常的一次闲聊'))
})

test('经历行:渲染与 fail-open 空态', async () => {
  const a = createWarmAssembler({ searchExperiences: async () => ['用户修好了电脑', '一起去吃过火锅'] })
  const line = (await a.experienceLine('电脑后来怎样了'))
  assert.ok(line.startsWith('你记得的过往经历'))
  assert.ok(line.includes('修好了电脑'))
  assert.ok(line.includes('火锅'))

  const b = createWarmAssembler({ searchExperiences: async () => [] })
  assert.equal(await b.experienceLine('x'), undefined)
})
