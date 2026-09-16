// 表达导演编排层验收矩阵(方案 §二不变量 + §八学习 + §九质量闸):
// plan 回退不阻断 / 耗时预算 / noteSpoken 记账与口头禅冷却 / learn 拒记 direct /
// 偏好乘数公式 / 质量闸逐类检测与恰一次轻修复 / expressionV2 配置清洗。
// 假 IO + 定数 rng,零磁盘零模型。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let mod

before(async () => {
  mod = await import('../src/expression/index.ts')
})



const inputOf = (over = {}) => ({
  actor: 'B',
  channel: 'group-chat',
  stimulus: '今天上线又炸了,笑死',
  recent: [{ author: 'user', text: '今天上线又炸了,笑死' }],
  context: {},
  limits: { maySpeak: true, maxChars: 80, mayAskQuestion: true },
  ...over,
})

// ---------- plan:结构化 Plan + 回退不变量 ----------

test('plan:产出结构化计划与指令,长度约束取档位与通道上限的较小值', () => {
  const d = mod.createExpressionDirector({ rng: () => 0.9, prefs: null })
  const plan = d.plan(inputOf({ limits: { maySpeak: true, maxChars: 20, mayAskQuestion: true } }))
  assert.ok(plan.instruction.includes('本轮表达策略'))
  assert.ok(plan.constraints.maxChars <= 20)
  assert.equal(plan.trace.actor, 'B')
  assert.equal(plan.trace.channel, 'group-chat')
  assert.ok(['none', 'mild'].includes(plan.trace.surprise))
  // 意外动作标注:荒诞联想/字面理解 = mild,其余 none
  const surpriseMove = plan.trace.move === 'absurd-leap' || plan.trace.move === 'literalize'
  assert.equal(plan.trace.surprise === 'mild', surpriseMove)
})

test('plan 异常回退普通直接回答策略,不阻断聊天', () => {
  const d = mod.createExpressionDirector({ rng: () => 0.5, prefs: null })
  // 旧梗候选缺 text 字段 → picker 抛错 → 兜底计划
  const plan = d.plan(inputOf({ context: { gags: [{ id: 'bad' }] } }))
  assert.equal(plan.move, 'direct')
  assert.equal(plan.trace.move, 'direct')
  assert.ok(plan.instruction.includes('直接'))
})

test('规划耗时:同步本地计算,单次均值远低于 2ms 预算', () => {
  const d = mod.createExpressionDirector({ prefs: null })
  const inp = inputOf({ context: { gags: [{ id: 'g', text: '半夜上线炸了那次' }] } })
  const t0 = performance.now()
  for (let i = 0; i < 2000; i++) d.plan(inp)
  const avg = (performance.now() - t0) / 2000
  assert.ok(avg < 2, `plan 平均耗时 ${avg.toFixed(3)}ms 应 < 2ms`)
})

// ---------- noteSpoken:只认提交,冷却推进 ----------

test('noteSpoken 推进口头禅冷却:下一次 plan 点名禁用;8 回合后解禁', () => {
  const d = mod.createExpressionDirector({ rng: () => 0.9, prefs: null })
  const first = d.plan(inputOf())
  assert.ok(!first.instruction.includes('口头禅「'))
  // B 的默认口头禅就这?/然后呢:上屏文本带"就这?" → 冷却开始
  d.noteSpoken({ trace: first.trace, text: '就这?你也配提需求', personaText: undefined })
  const second = d.plan(inputOf())
  assert.ok(second.instruction.includes('不使用最近出现过的口头禅「就这?」'))
  // 冷却 8 回合:连续提交 8 次不含口头禅的回复后解禁
  for (let i = 0; i < 8; i++) {
    d.noteSpoken({ trace: second.trace, text: '正常回复没有口头禅' })
  }
  const third = d.plan(inputOf())
  assert.ok(!third.instruction.includes('口头禅「'))
})

test('口头禅没实际用出就不冷却:plan 不点名', () => {
  const d = mod.createExpressionDirector({ rng: () => 0.9, prefs: null })
  const p = d.plan(inputOf())
  d.noteSpoken({ trace: p.trace, text: '一段完全不含口头禅的普通回复' })
  assert.ok(!d.plan(inputOf()).instruction.includes('口头禅「'))
})

// ---------- learn + preferenceStore(方案 §八) ----------

function memoryIo() {
  let stored = null
  return {
    async read() {
      return stored
    },
    async write(json) {
      stored = json
    },
  }
}

test('偏好乘数:拉普拉斯平滑 + clamp(0.6,1.5);direct 恒 1 且拒学', async () => {
  assert.equal(mod.preferenceMultiplier(undefined), 1)
  assert.equal(mod.preferenceMultiplier({ up: 1, down: 0 }), (1 + 1) / (1 + 0 + 2) * 2)
  const allDown = mod.preferenceMultiplier({ up: 0, down: 100 })
  assert.equal(allDown, 0.6)
  const allUp = mod.preferenceMultiplier({ up: 100, down: 0 })
  assert.equal(allUp, 1.5)

  const store = mod.createPreferenceStore({ io: memoryIo() })
  assert.equal(store.multiplier('B', 'tease'), 1)
  await store.learn('B', 'tease', 'down')
  await store.learn('B', 'tease', 'down')
  assert.equal(store.multiplier('B', 'tease'), 0.6)
  await store.learn('B', 'tease', 'up')
  assert.ok(store.multiplier('B', 'tease') > 0.6 && store.multiplier('B', 'tease') < 1)
  // 按角色分别保存:A 的踩不影响 B
  assert.equal(store.multiplier('A', 'tease'), 1)
  // direct 拒记
  await store.learn('B', 'direct', 'down')
  assert.equal(store.multiplier('B', 'direct'), 1)
  assert.equal(store.snapshot()['B:direct'], undefined)
})

test('director.learn 把赞踩写进偏好存储并影响乘数', async () => {
  const store = mod.createPreferenceStore({ io: memoryIo() })
  const d = mod.createExpressionDirector({ rng: () => 0.9, prefs: store })
  const trace = d.plan(inputOf()).trace
  await d.learn({ trace, rating: 'up' })
  assert.equal(store.snapshot()[`${trace.actor}:${trace.move}`].up, 1)
})

test('sanitize:非法键与非 direct 白名单外键丢弃;direct 键直接剔', () => {
  const table = mod.sanitizePreferenceTable({
    'B:tease': { up: 2, down: 1 },
    'B:direct': { up: 9, down: 9 },
    'Z:tease': { up: 1, down: 0 },
    'B:badmove': { up: 1, down: 0 },
    garbage: { up: 1 },
  })
  assert.deepEqual(table, { 'B:tease': { up: 2, down: 1 } })
})

// ---------- 质量闸(方案 §九) ----------

const gateCtx = (over = {}) => ({
  plan: { constraints: { mayAskQuestion: true, mustAnswerTask: false, maxChars: 30 } },
  ownRecent: [],
  stimulus: '今天上线又炸了',
  ...over,
})

test('质量闸:六类检测各自命中(issues 反映修复后最终文本)', () => {
  // 与最近回复完全重复(不可修 → 问题保留)
  let r = mod.runQualityGate('今晚又是炸服的一天', gateCtx({ ownRecent: ['今晚又是炸服的一天'] }))
  assert.deepEqual(r.issues, ['repetition'])
  assert.equal(r.ok, false)
  assert.equal(r.repaired, false)
  // 复述用户原句(不可修 → 问题保留)
  r = mod.runQualityGate('今天上线又炸了,这事我也没法说', gateCtx())
  assert.ok(r.issues.includes('echo'))
  // 客服腔整句都是(单句无法剔除 → 问题保留)
  r = mod.runQualityGate('作为AI,我有什么可以帮助你', gateCtx())
  assert.ok(r.issues.includes('service-tone'))
  // 可修复类:修复后 ok=true,不再报问题
  r = mod.runQualityGate('这句话特别特别长已经超过了三十个字的限制真的非常多需要再长一点才行', gateCtx())
  assert.equal(r.repaired, true)
  assert.ok(r.text.length <= 30)
  assert.equal(r.ok, true)
  r = mod.runQualityGate('你说是不是?', gateCtx({ plan: { constraints: { mayAskQuestion: false, mustAnswerTask: false, maxChars: 30 } } }))
  assert.equal(r.text, '你说是不是。')
  assert.equal(r.ok, true)
  r = mod.runQualityGate('就这?也可以', gateCtx({ bannedCatchphrase: '就这?' }))
  assert.ok(r.repaired)
  assert.ok(!r.text.includes('就这?'))
  assert.equal(r.ok, true)
})

test('质量闸:恰一次轻修复——截长到句边界、剔客服腔、疑问改陈述、去口头禅', () => {
  // 截长
  let r = mod.runQualityGate('第一句话很短。第二句话超长了超长了超长了超长了超长了一句根本装不下', gateCtx())
  assert.ok(r.repaired)
  assert.ok(r.text.length <= 30)
  assert.ok(!r.issues.includes('over-length'))
  // 剔客服腔(可修)
  r = mod.runQualityGate('这bug真离谱。作为AI,我有什么可以帮助你', gateCtx())
  assert.ok(r.repaired)
  assert.equal(r.text, '这bug真离谱。')
  assert.ok(!r.issues.includes('service-tone'))
  // 疑问改陈述
  r = mod.runQualityGate('你又没上线吧?', gateCtx({ plan: { constraints: { mayAskQuestion: false, mustAnswerTask: false, maxChars: 30 } } }))
  assert.equal(r.text, '你又没上线吧。')
  // 去口头禅
  r = mod.runQualityGate('就这?也敢上线', gateCtx({ bannedCatchphrase: '就这?' }))
  assert.ok(r.repaired)
  assert.ok(!r.text.includes('就这?'))
})

test('质量闸:健康文本直接放行', () => {
  const r = mod.runQualityGate('炸了吧,我早说过要回滚', gateCtx())
  assert.deepEqual(r.issues, [])
  assert.equal(r.ok, true)
  assert.equal(r.repaired, false)
  assert.equal(r.text, '炸了吧,我早说过要回滚')
})

// ---------- expressionV2 配置(灰度默认关) ----------

test('expressionV2 配置:默认关、真值才开、非法值回退关', async () => {
  const cfgMod = await import('../src/storage/configStore.ts')
  assert.equal(cfgMod.DEFAULT_CONFIG.expressionV2, false)
  assert.equal(cfgMod.sanitizeConfig({}).expressionV2, false)
  assert.equal(cfgMod.sanitizeConfig({ expressionV2: true }).expressionV2, true)
  assert.equal(cfgMod.sanitizeConfig({ expressionV2: 'on' }).expressionV2, false)
  assert.equal(cfgMod.sanitizeConfig({ expressionV2: 1 }).expressionV2, false)
})
