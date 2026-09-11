// 情绪状态机回归:值域/衰减数学/增量钳位、量化边界、提示词渲染、集内瞬时情绪、姿势染色。
// 衰减是惰性的(读时算,不跑定时器),这里把"隔天归中性"钉死。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let ms

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ms = await server.ssrLoadModule('/src/engine/moodState.ts')
})

after(async () => {
  await server?.close()
})

/** 周三 14:00(白天,energy 基线 2.5) */
const T0 = new Date(2026, 5, 3, 14, 0, 0).getTime()
const HOUR = 3_600_000

const mood = (valence, energy, updatedAt = T0) => ({ valence, energy, updatedAt })
const CALM = () => mood(0, 2.5)
/** 未传的角色一律平静,避免 undefined 干扰 */
const table = (a, b = CALM(), c = CALM()) => ({ A: a, B: b, C: c })

test('默认值:白天精力基线 2.5,深夜 1.5', () => {
  const day = ms.defaultMood(T0)
  assert.equal(day.valence, 0)
  assert.equal(day.energy, 2.5)
  const late = ms.defaultMood(new Date(2026, 5, 3, 23, 30).getTime())
  assert.equal(late.energy, 1.5)
})

test('值域钳位:valence ±3、energy 0..5', () => {
  assert.deepEqual(ms.clampMood(mood(9, -1)), { valence: 3, energy: 0, updatedAt: T0 })
  assert.equal(ms.clampMood(mood(-9, 99)).valence, -3)
  assert.equal(ms.clampMood(mood(-9, 99)).energy, 5)
})

test('衰减数学:2 小时后 valence×0.49、energy 向基线回 44% 差距', () => {
  const d = ms.decayMood(mood(2, 5), T0 + 2 * HOUR)
  assert.ok(Math.abs(d.valence - 0.98) < 1e-9, `valence=${d.valence}`)
  assert.ok(Math.abs(d.energy - (2.5 + 2.5 * 0.75 ** 2)) < 1e-9, `energy=${d.energy}`)
  assert.equal(d.updatedAt, T0 + 2 * HOUR)
})

test('深夜衰减向 1.5 回归,清晨读档角色是困的', () => {
  const late = new Date(2026, 5, 3, 23, 0).getTime()
  const d = ms.decayMood(mood(0, 5, late), late + 2 * HOUR)
  assert.ok(Math.abs(d.energy - (1.5 + 3.5 * 0.75 ** 2)) < 1e-9, `energy=${d.energy}`)
})

test('刚更新过的情绪不衰减(updatedAt 在未来/相等时原样返回)', () => {
  const d = ms.decayMood(mood(2, 5), T0)
  assert.equal(d.valence, 2)
  assert.equal(d.energy, 5)
})

test('增量应用:单笔 |Δ|≤2、值域 clamp、cause 记录', () => {
  const out = ms.applyMoodDeltas(
    table(mood(2, 4.5)),
    [{ who: 'A', dValence: 5, dEnergy: 0.3, cause: '  被当众夸上天  ' }],
    T0,
  )
  assert.equal(out.A.valence, 3) // 2+5 单笔钳到 2,值域钳到 3
  assert.equal(out.A.energy, 4.8)
  assert.equal(out.A.cause, '被当众夸上天')
  assert.equal(out.B.valence, 0) // 别人不动
})

test('增量应用:负向与向下钳位,零增量不动 updatedAt', () => {
  const out = ms.applyMoodDeltas(
    table(mood(-2, 1), mood(0, 0)),
    [
      { who: 'A', dValence: -2, dEnergy: -2 },
      { who: 'B', dValence: 0, dEnergy: 0 },
    ],
    T0,
  )
  assert.equal(out.A.valence, -3)
  assert.equal(out.A.energy, 0)
  assert.equal(out.B.updatedAt, T0) // 零增量跳过:updatedAt 保持原值
  // 非法 who 忽略
  const skip = ms.applyMoodDeltas(table(mood(0, 2.5)), [{ who: 'X', dValence: 1 }], T0)
  assert.equal(skip.A.valence, 0)
})

test('量化边界:双通道组合出七个情绪面', () => {
  assert.equal(ms.quantizeMood(mood(-2, 3)).id, 'angry')
  assert.equal(ms.quantizeMood(mood(-2, 2)).id, 'sad')
  assert.equal(ms.quantizeMood(mood(2, 4)).id, 'excited')
  assert.equal(ms.quantizeMood(mood(2, 2)).id, 'content')
  assert.equal(ms.quantizeMood(mood(0, 4)).id, 'restless')
  assert.equal(ms.quantizeMood(mood(0, 1)).id, 'sleepy')
  assert.equal(ms.quantizeMood(mood(0, 2.5)).id, 'calm')
  assert.equal(ms.quantizeMood(mood(-1.4, 2.5)).id, 'calm')
})

test('主演出块:只列有波澜的角色,带"不是主要矛盾/模式风格优先"纪律', () => {
  const block = ms.moodPromptBlock(table(mood(0, 2.5), mood(-2, 3)), T0)
  assert.match(block, /当前心情余波/)
  assert.match(block, /乙还在气头上/)
  assert.match(block, /余怒未消/)
  assert.match(block, /不是本集主要矛盾/)
  assert.match(block, /以模式风格为准/)
  assert.doesNotMatch(block, /甲/)
})

test('主演出块:全员平静返回空串(不注水)', () => {
  assert.equal(ms.moodPromptBlock(table(mood(0, 2.5)), T0), '')
})

test('主演出块:衰减 30 小时后情绪归平静,不再注入', () => {
  const block = ms.moodPromptBlock(table(mood(0, 2.5), mood(-2, 3)), T0 + 30 * HOUR)
  assert.equal(block, '')
})

test('短通道单行:有波澜才给一行,平静为空', () => {
  const line = ms.moodHintLine(table(mood(0, 2.5), mood(-2, 1), mood(2, 4)), ['A', 'B', 'C'], T0)
  assert.match(line, /心情余波/)
  assert.match(line, /乙蔫了/)
  assert.match(line, /丙兴奋劲还没过/)
  assert.match(line, /以任务为准/)
  assert.equal(ms.moodHintLine(table(mood(0, 2.5)), ['A'], T0), '')
})

test('集内瞬时情绪:从最近已播 action 轨迹推导,中性动作不报', () => {
  const hint = ms.recentMoodHint([
    { speaker: 'A', text: '你说谁不行?', action: 'angry' },
    { speaker: 'B', text: '哈哈哈哈', action: 'laugh' },
  ])
  assert.match(hint, /集内情绪提示/)
  assert.match(hint, /甲刚被怼到炸毛/)
  assert.match(hint, /乙正笑得停不下来/)

  const neutral = ms.recentMoodHint([
    { speaker: 'A', text: '我跟你说', action: 'talk' },
    { speaker: 'B', text: '就这?', action: 'idle' },
  ])
  assert.equal(neutral, '')
})

test('集内瞬时情绪:只看最近 6 句,翻篇的情绪不再带', () => {
  const lines = [
    { speaker: 'A', text: '气死了', action: 'angry' },
    ...Array.from({ length: 6 }, (_, i) => ({
      speaker: i % 2 ? 'B' : 'A',
      text: `后来聊到${i}`,
      action: 'talk',
    })),
  ]
  assert.equal(ms.recentMoodHint(lines), '')
})

test('姿势染色:只有负向强情绪染,正向与平静不染', () => {
  assert.equal(ms.tintedRelaxPose(mood(-2, 3), T0), 'angry')
  assert.equal(ms.tintedRelaxPose(mood(-2, 1), T0), 'sad')
  assert.equal(ms.tintedRelaxPose(mood(2, 4), T0), null)
  assert.equal(ms.tintedRelaxPose(mood(0, 2.5), T0), null)
})

test('读档清洗:坏数据回默认、越界钳位、cause 截断', () => {
  const t = ms.sanitizeMoodTable(
    {
      A: { valence: 'bad', energy: 99, updatedAt: 'x', cause: 123 },
      B: { valence: -5, energy: 2, updatedAt: T0, cause: '一'.repeat(50) },
    },
    T0,
  )
  assert.equal(t.A.valence, 0)
  assert.equal(t.A.energy, 5) // 非法字段外的越界值照常钳位
  assert.equal(t.A.updatedAt, 0)
  assert.equal(t.A.cause, undefined)
  assert.equal(t.B.valence, -3)
  assert.equal(t.B.cause.length, 30)
  assert.equal(t.C.valence, 0)
  assert.equal(t.C.energy, 2.5) // 缺失条目回白天基线默认
})
