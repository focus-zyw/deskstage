// 剧本结构校验回归:清洗保证每行合法,校验器保证整集可播放——
// 死抉择(分支缺失/过短)必须 fatal 拒播走重生成;节奏瑕疵(连说/超长句/C 收底)只警告不拦截。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let schema

before(async () => {
  schema = await import('../src/performer/dialogSchema.ts')
})


const line = (speaker, text) => ({ speaker, text, action: '' })
const LINE_A = () => line('A', '甲的一句台词')
const LINE_B = () => line('B', '乙的一句台词')

const goodScript = {
  before: [LINE_A(), LINE_B(), LINE_A(), LINE_B()],
  choice: { prompt: '帮谁', options: [{ id: 'a', label: '帮甲' }, { id: 'b', label: '帮乙' }] },
  after: {
    a: [line('A', '谢了兄弟'), line('B', '下不为例')],
    b: [line('B', '有眼光'), line('A', '我后悔了')],
  },
}

test('合格剧本(双分支完整、交替发言)零 fatal 零 warning', () => {
  const v = schema.validatePerformanceScript(goodScript)
  assert.deepEqual(v.fatal, [])
  assert.deepEqual(v.warnings, [])
})

test('分支首句播报腔(观众选择了/投票)记 warning,口语接话不记', () => {
  const broadcast = {
    ...goodScript,
    after: {
      a: [line('A', '观众选择了帮甲,那咱们继续'), line('B', '下不为例')],
      b: [line('B', '行,听你的就完事了'), line('A', '我后悔了')],
    },
  }
  const v = schema.validatePerformanceScript(broadcast)
  assert.ok(
    v.warnings.some((w) => w.includes('播报腔') && w.includes('帮甲')),
    '统计口吻首句应记 warning',
  )
  assert.ok(
    !v.warnings.some((w) => w.includes('帮乙') && w.includes('播报腔')),
    '口语接话的分支不应误报',
  )
  // "投了"的误报防护:正常语义(投了简历)不算播报腔
  const legit = {
    ...goodScript,
    after: {
      a: [line('A', '我刚把简历投了,录用再说'), line('B', '下不为例')],
      b: goodScript.after.b,
    },
  }
  assert.ok(!schema.validatePerformanceScript(legit).warnings.some((w) => w.includes('播报腔')))
})

test('分支缺失或只有一句 = fatal(死抉择,选了没戏演)', () => {
  const missing = { ...goodScript, after: { a: goodScript.after.a } }
  assert.ok(schema.validatePerformanceScript(missing).fatal.length > 0)
  const stub = { ...goodScript, after: { a: [LINE_A()], b: [LINE_B()] } }
  const v = schema.validatePerformanceScript(stub)
  assert.equal(v.fatal.length, 2)
  assert.ok(v.fatal[0].includes('不足'))
})

test('无抉择的普通短剧:台词不足 4 句 = fatal', () => {
  const v = schema.validatePerformanceScript({ before: [LINE_A(), LINE_B(), LINE_A()], after: {} })
  assert.equal(v.fatal.length, 1)
  assert.ok(v.fatal[0].includes('不足'))
})

test('同角色连说超过 2 句 = warning 不拦截', () => {
  const v = schema.validatePerformanceScript({
    before: [LINE_A(), line('A', '甲补充'), line('A', '甲还要说'), LINE_B()],
    after: {},
  })
  assert.deepEqual(v.fatal, [])
  assert.equal(v.warnings.length, 1)
  assert.ok(v.warnings[0].includes('连说'))
})

test('分支以场外角色 C 收底 = warning(剧情可能没收束)', () => {
  const v = schema.validatePerformanceScript({
    ...goodScript,
    after: { a: [line('A', '谢了'), line('C', '门外传来一声猫叫')], b: goodScript.after.b },
  })
  assert.deepEqual(v.fatal, [])
  assert.ok(v.warnings.some((w) => w.includes('收底')))
})

test('超长句 = warning 不拦截', () => {
  const v = schema.validatePerformanceScript({
    before: [line('A', '长'.repeat(120)), LINE_B(), LINE_A(), LINE_B()],
    after: {},
  })
  assert.deepEqual(v.fatal, [])
  assert.ok(v.warnings.some((w) => w.includes('偏长')))
})

test('端到端:模型漏写一个分支的原始输出,解析通过但校验 fatal(拒播路径存在)', () => {
  const raw = JSON.stringify({
    dialog: [
      { speaker: 'A', text: '这事你得给我个说法', action: '' },
      { speaker: 'B', text: '说法就是没有说法', action: '' },
      { speaker: 'A', text: '那我自己找说法', action: '' },
      { speaker: 'B', text: '随便你', action: '', choice: { prompt: '帮谁', options: [{ id: 'a', label: '帮甲' }, { id: 'b', label: '帮乙' }] } },
      { speaker: 'A', text: '谢谢,虽然听起来不太可靠', action: '', branch: 'a' },
      { speaker: 'B', text: '客气,我也就随口一说', action: '', branch: 'a' },
    ],
  })
  const script = schema.parseGeneratedDialog(raw)
  const v = schema.validatePerformanceScript(script)
  assert.ok(v.fatal.some((f) => f.includes('帮乙')))
})

test('节拍覆盖:有场景卡时,漏拍/未知 beatId/乱序都给 warning', () => {
  const good = {
    card: { relationship: 'r', scene: 's', goalA: 'a', goalB: 'b', secret: 'x', escalation: ['铺垫', '升级', '反转'], callback: 'c' },
    before: [
      line('A', '一'), line('B', '二'),
      { ...line('A', '三'), beatId: '铺垫' },
      { ...line('B', '四'), beatId: '升级' },
      { ...line('A', '五'), beatId: '反转' },
      line('B', '六'),
    ],
    after: {},
  }
  const v = schema.validatePerformanceScript(good)
  assert.deepEqual(v.fatal, [])
  assert.equal(v.warnings.filter((w) => w.includes('节拍')).length, 0)
  assert.equal(v.warnings.filter((w) => w.includes('beatId')).length, 0)

  // 漏掉「升级」这一拍
  const missingBeat = {
    ...good,
    before: [
      line('A', '一'), line('B', '二'),
      { ...line('A', '三'), beatId: '铺垫' },
      { ...line('B', '四'), beatId: '反转' },
      { ...line('A', '五'), beatId: '反转' },
      line('B', '六'),
    ],
  }
  assert.ok(schema.validatePerformanceScript(missingBeat).warnings.some((w) => w.includes('没有台词承载')))

  // beatId 不在场景卡里
  const unknownBeat = { ...good, before: [...good.before.slice(0, 5), { ...line('B', '六'), beatId: '不存在的拍' }] }
  assert.ok(schema.validatePerformanceScript(unknownBeat).warnings.some((w) => w.includes('不在场景卡节拍里')))

  // 乱序:反转出现在升级之前
  const outOfOrder = {
    ...good,
    before: [
      line('A', '一'), line('B', '二'),
      { ...line('A', '三'), beatId: '反转' },
      { ...line('B', '四'), beatId: '升级' },
      { ...line('A', '五'), beatId: '铺垫' },
      line('B', '六'),
    ],
  }
  assert.ok(schema.validatePerformanceScript(outOfOrder).warnings.some((w) => w.includes('不一致')))
})

test('无场景卡的剧本不做节拍覆盖检查(向后兼容)', () => {
  const v = schema.validatePerformanceScript({ before: [LINE_A(), LINE_B(), LINE_A(), LINE_B()], after: {} })
  assert.deepEqual(v.warnings, [])
})
