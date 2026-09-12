// 日历情境与待机池组合回归:节日判定/季节带/pickAmbientClip 优先级四象限。
// pickAmbientClip 的 rand 可注入——节日全替换、2% 彩蛋、时间∪情绪、默认回落逐一对拍。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let calendar
let machine

const mood = (valence, energy) => ({ valence, energy, updatedAt: 0 })

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  calendar = await server.ssrLoadModule('/src/stage/resident/residentCalendar.ts')
  machine = await server.ssrLoadModule('/src/stage/resident/residentMachine.ts')
})

after(async () => {
  await server?.close()
})

test('公历节日判定:圣诞窗口覆盖多天,万圣单日', () => {
  assert.equal(calendar.festivalOf(12, 24, 2026), 'christmas')
  assert.equal(calendar.festivalOf(12, 26, 2026), 'christmas')
  assert.equal(calendar.festivalOf(12, 27, 2026), null)
  assert.equal(calendar.festivalOf(10, 31, 2026), 'halloween')
})

test('农历对照表:2026 春节窗口/端午/中秋命中,非节日日为 null', () => {
  assert.equal(calendar.festivalOf(2, 17, 2026), 'spring')
  assert.equal(calendar.festivalOf(2, 16, 2026), 'spring')
  assert.equal(calendar.festivalOf(6, 19, 2026), 'duanwu')
  assert.equal(calendar.festivalOf(9, 25, 2026), 'zhongqiu')
  assert.equal(calendar.festivalOf(7, 1, 2026), null)
  // 表外年份安全回落
  assert.equal(calendar.festivalOf(2, 17, 2035), null)
})

test('季节带:6-8 夏,12/1/2 冬,过渡季 null', () => {
  assert.equal(calendar.seasonOf(7), 'summer')
  assert.equal(calendar.seasonOf(1), 'winter')
  assert.equal(calendar.seasonOf(4), null)
})

test('pickAmbientClip 优先级:节日全替换 > 稀有彩蛋 > 时间∪情绪 > 默认', () => {
  // 节日日:无论 rand 序列怎么掷,都落在节日池内(春节池成员)
  const springPool = calendar.FESTIVAL_CLIPS.spring
  for (let i = 0; i < 40; i++) {
    const clip = machine.pickAmbientClip({ mood: mood(0, 2.5), slotId: 'noon', month: 2, day: 17, year: 2026 }, Math.random)
    assert.ok(springPool.includes(clip), `节日日应走节日池,得到 ${clip}`)
  }
  // 非节日 + rand 首掷 <2% → 稀有彩蛋池
  const rare = machine.pickAmbientClip({ mood: mood(0, 2.5), slotId: 'noon', month: 7, day: 10, year: 2026 }, () => 0.01)
  assert.ok(
    ['whale_rise', 'whale_bubble', 'dove', 'card_magic', 'juggle', 'gomoku', 'bloom', 'eat_token'].includes(rare),
    `2% 应掷稀有池,得到 ${rare}`,
  )
  // 常规:中午(4月过渡季,无季节项)合并池 = ['lunch', ...默认池15项],
  // rand 取 0.03(避开 2% 彩蛋区,仍在首个时间项)
  const lunch = machine.pickAmbientClip({ mood: mood(0, 2.5), slotId: 'noon', month: 4, day: 10, year: 2026 }, () => 0.03)
  assert.equal(lunch, 'lunch')
  // 情绪注入:同一时段生气时,合并池 ['lunch','turn','caught','tap','rage_quit','whale_slam'],
  // rand=0.7 落在情绪区的 rage_quit 上([4/6, 5/6) 区间)
  const angryHit = machine.pickAmbientClip({ mood: mood(-2.5, 3), slotId: 'noon', month: 4, day: 10, year: 2026 }, () => 0.7)
  assert.equal(angryHit, 'rage_quit')
})

test('非特色时段回落情绪池/默认池,不会为空', () => {
  // lateNight 无时段特色:平静走默认池成员,生气走情绪专属成员
  const calm = machine.pickAmbientClip({ mood: mood(0, 2.5), slotId: 'lateNight', month: 4, day: 15, year: 2026 }, () => 0.99)
  assert.ok(machine.AMBIENT_CLIPS.includes(calm), `得到 ${calm}`)
  const angry = machine.pickAmbientClip({ mood: mood(-2.5, 3), slotId: 'lateNight', month: 4, day: 15, year: 2026 }, () => 0.99)
  assert.equal(angry, 'whale_slam')
})
