// AI 后台候选发现回归:调度闸门(开关/Key/池量/冷却/消费计数/日限/单飞)、
// 输出清洗入库(雷区/查重/字段/TTL)、失败退避记账、隐私边界(输入只有类别级语境)。
// LLM 经注入的 fake complete 驱动,不碰网络。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

let discovery
let store
let promptMod

before(async () => {
  const values = new Map()
  globalThis.localStorage = {
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: (k) => values.delete(k),
    clear: () => values.clear(),
  }
  discovery = await import('../src/topic/discovery.ts')
  store = await import('../src/topic/store.ts')
  promptMod = await import('../src/topic/prompt.ts')
})

after(async () => {
  delete globalThis.localStorage
})

let nowMs = 1_000_000_000
const cfg = (over = {}) => ({
  apiKey: 'sk-test',
  envSense: true,
  userProfile: { banTopics: '', likes: '', ...(over.userProfile ?? {}) },
  topicPrefs: { defaults: { distance: 'medium' }, sources: { interests: true, aiGenerated: true } },
  ...over,
})
const deps = (over = {}) => ({
  complete: over.complete ?? (async () => '{"cards":[]}'),
  getConfig: async () => cfg(over.cfg),
  envCategory: () => over.envCategory ?? null,
  now: () => (over.now ?? (() => nowMs))(),
})
const goodCard = (title, i = 0) => ({
  title,
  hook: `${title}——甲觉得理直气壮,乙觉得离谱至极,当场对线`,
  category: 'life',
  tags: ['测试', `标签${i}`],
})

async function resetState(statePatch = {}) {
  await store.mutateTopicState(() => ({
    state: { ...store.defaultTopicState(), ...statePatch },
    result: null,
  }))
}

test('调度闸门:开关关/无Key/池充足/冷却内/日限到,一律不发请求', async () => {
  await resetState()
  let calls = 0
  const complete = async () => (calls++, '{"cards":[]}')
  // 开关关(默认)
  assert.equal(await discovery.maybeRestockTopicCandidates(deps({ complete, cfg: { topicPrefs: { defaults: { distance: 'medium' }, sources: { interests: true, aiGenerated: false } } } })), false)
  // 无 Key
  assert.equal(await discovery.maybeRestockTopicCandidates(deps({ complete, cfg: { apiKey: '' } })), false)
  // 池充足(8 张未过期)
  const reservoir = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`, title: `充足候选${i}`, hook: `充足候选${i}的矛盾`, category: 'life', tags: ['x'],
    source: 'generated', fingerprint: `fp-full${i}`, sensitivity: 'normal', generatedAt: 0,
  }))
  await resetState({ reservoir })
  assert.equal(await discovery.maybeRestockTopicCandidates(deps({ complete })), false)
  // 冷却内(上次尝试 1 小时前)
  await resetState({ discovery: { lastAttemptAt: nowMs - 3_600_000, consumedSinceRestock: 0, attemptDay: '', attemptCount: 0 } })
  assert.equal(await discovery.maybeRestockTopicCandidates(deps({ complete })), false, '6h 冷却内不补')
  // 日限到(今天已 4 次)
  await resetState({ discovery: { lastAttemptAt: 0, consumedSinceRestock: 0, attemptDay: discovery.localDay(nowMs), attemptCount: 4 } })
  assert.equal(await discovery.maybeRestockTopicCandidates(deps({ complete })), false, '当日 4 次封顶')
  assert.equal(calls, 0, '以上全部闸门:零网络请求')
})

test('触发与单飞:池不足且冷却过才补;在飞时重入直接返回 false', async () => {
  await resetState()
  let resolveHold
  const held = new Promise((r) => (resolveHold = r))
  let calls = 0
  const complete = async () => (calls++, await held)
  const first = discovery.maybeRestockTopicCandidates(deps({ complete }))
  // 等微任务进入在飞态
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(await discovery.maybeRestockTopicCandidates(deps({ complete })), false, '单飞:重入拒绝')
  resolveHold('{"cards":[]}')
  assert.equal(await first, false, '空结果不入库但已尝试')
  assert.equal(calls, 1)
})

test('清洗入库:合法卡带 14 天 TTL 入池;非法/雷区/重复全拒;上限 6 张', async () => {
  await resetState()
  const dup = goodCard('重复话题卡测试用例')
  const banned = { ...goodCard('高考志愿填报的博弈现场'), category: 'life', tags: ['考试'] }
  const raw = {
    cards: [
      goodCard('健身房推销话术防御指南'),
      dup,
      dup, // 同批重复
      { title: '短', hook: '太短不过审的内容肯定不够十个字', category: 'life', tags: ['x'] },
      { title: '分类非法的话题卡测试用例', hook: '分类不在白名单里的候选应当被拒绝', category: 'sports', tags: ['x'] },
      { title: '没有标签的话题卡测试用例', hook: '没有标签的候选同样应该被清洗掉', category: 'life' },
      { title: '深夜修仙与早八闹钟的拉扯', hook: '甲觉得熬夜自由,乙觉得作息是底线,互不服气', category: 'health', tags: ['作息'] },
      banned, // 雷区词
      goodCard('外卖凑满减的极限操作比价'), goodCard('合租公共冰箱的产权博弈'), goodCard('年假清零前的抢休大战'),
      goodCard('微信工作群已读不回的代价'), goodCard('双十一预售定金的心理账户'), goodCard('宠物医院账单惊魂记'),
      goodCard('婚礼随份子的行情调研'), goodCard('健身房年卡第二次进店的距离'), goodCard('旧手机数据清空前的犹豫'),
    ],
  }
  const complete = async () => JSON.stringify(raw)
  const ok = await discovery.maybeRestockTopicCandidates(deps({ complete }))
  assert.equal(ok, true)
  const state = await store.getTopicState()
  assert.ok(state.reservoir.length > 0 && state.reservoir.length <= discovery.DISCOVERY_POLICY.BATCH, `入库 ${state.reservoir.length} 张,上限 6`)
  assert.ok(state.reservoir.every((c) => !c.title.includes('考试')), '雷区卡零入库')
  const fps = state.reservoir.map((c) => c.fingerprint)
  assert.equal(new Set(fps).size, fps.length, '批内查重')
  for (const c of state.reservoir) {
    assert.equal(c.source, 'generated')
    assert.ok(c.expiresAt > nowMs + 13 * 24 * 3600_000, 'TTL 14 天')
  }
  assert.equal(state.discovery.consumedSinceRestock, 0, '补货后消费计数清零')
  assert.equal(state.discovery.attemptCount, 1)
})

test('失败退避:模型抛错也记尝试(冷却生效),池不变', async () => {
  await resetState()
  const complete = async () => {
    throw new Error('boom')
  }
  assert.equal(await discovery.maybeRestockTopicCandidates(deps({ complete })), false)
  const state = await store.getTopicState()
  assert.equal(state.reservoir.length, 0)
  assert.equal(state.discovery.lastAttemptAt, nowMs, '尝试时间已记(退避)')
  assert.equal(state.discovery.attemptCount, 1)
})

test('消费计数触发:6h 内但已消费 5 张,允许补货', async () => {
  await resetState({ discovery: { lastAttemptAt: nowMs - 600_000, consumedSinceRestock: 5, attemptDay: '', attemptCount: 0 } })
  const ok = await discovery.maybeRestockTopicCandidates(deps({ complete: async () => '{"cards":[]}' }))
  assert.equal(ok, false, '空输出不入库')
  // 上面已验证通过闸门(若被冷却拦下同样是 false;用 attemptCount 区分)
  assert.equal((await store.getTopicState()).discovery.attemptCount, 1, '消费计数触发越过冷却')
})

test('隐私边界:发现提示词只含类别级语境,不含屏幕/窗口/剪贴板内容', () => {
  const messages = promptMod.buildDiscoveryMessages({
    interests: ['摄影', '通勤播客'],
    recentTopics: [{ title: '旧手机里的回忆要不要删' }],
    timeBucket: 'evening',
    envCategory: 'editor',
    banText: '考试',
    distance: 'medium',
  })
  const text = messages.map((m) => m.content).join('\n')
  assert.match(text, /摄影/)
  assert.match(text, /旧手机里的回忆要不要删/)
  assert.match(text, /代码编辑器/)
  assert.match(text, /考试/)
  // 类别级语境之外:任何具体路径/窗口标题/按键/剪贴板字样都不允许出现
  assert.doesNotMatch(text, /剪贴板|窗口标题|C:\\\\|exe|截图/)
})

test('parseDiscoveryCards:容忍围栏与混杂文本;坏输出返回空数组', () => {
  const card = { title: '周报文学的读者到底是谁', hook: '甲坚持周报是写给领导的小说,乙认为是写给未来的自己', category: 'work', tags: ['职场'] }
  const fenced = '好的,以下是结果:\n```json\n' + JSON.stringify({ cards: [card] }) + '\n```'
  assert.equal(promptMod.parseDiscoveryCards(fenced).length, 1)
  assert.deepEqual(promptMod.parseDiscoveryCards(' completely not json '), [])
  assert.deepEqual(promptMod.parseDiscoveryCards('{"cards": "not-array"}'), [])
})
