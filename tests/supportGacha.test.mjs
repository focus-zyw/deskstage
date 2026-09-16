// 支持作者抽奖回归:金额换算边界、权重落档统计(带宽校验)、硬保底时序、
// 连抽与账本/图鉴一致性、账本清洗(坏数据回默认、陌生 id 丢弃)、文案渲染。
// gacha.ts/pool.ts 运行时零依赖,node --test 直接 import 加载。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let g
let p

before(async () => {
  g = await import('../src/features/support/gacha.ts')
  p = await import('../src/features/support/pool.ts')
})


/** mulberry32 种子随机:统计用例可复现 */
function seeded(seed) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// rng=()=>0.5:自然落档恒为 common(权重表首段),史诗保底落 epic(0.5*10 ≥ 2)——
// 正好用来把保底时序钉成确定序列
const halfRng = () => 0.5

test('金额换算:非正数/非数值 0 抽,向下取整,单笔钳上限', () => {
  const t = g.amountToDraws
  assert.equal(t(0), 0)
  assert.equal(t(-5), 0)
  assert.equal(t(Number.NaN), 0)
  assert.equal(t(Number.POSITIVE_INFINITY), 0)
  assert.equal(t(0.9), 0)
  assert.equal(t(1), 1)
  assert.equal(t(5.9), 5)
  assert.equal(t(g.MAX_SINGLE_YUAN), g.MAX_SINGLE_YUAN)
  assert.equal(t(g.MAX_SINGLE_YUAN + 1000), g.MAX_SINGLE_YUAN)
})

test('池子自检:四档都有货、id 唯一、权重合计 100', () => {
  assert.equal(new Set(p.THANKS_POOL.map((x) => x.id)).size, p.THANKS_POOL.length)
  for (const r of p.RARITY_ORDER) {
    assert.ok(p.THANKS_POOL.some((x) => x.rarity === r), `稀有度 ${r} 至少一条`)
  }
  const total = p.RARITY_ORDER.reduce((s, r) => s + p.RARITY_META[r].weight, 0)
  assert.equal(total, 100)
})

test('权重落档:大数统计落在带宽内(普通占大头,传说最少)', () => {
  const N = 30_000
  const counts = { common: 0, rare: 0, epic: 0, legendary: 0 }
  let pity = { sinceEpic: 0, sinceLegendary: 0 }
  const rng = seeded(20260912)
  for (let i = 0; i < N; i++) {
    const r = g.rollOnce(pity, rng)
    counts[r.prize.rarity]++
    pity = r.pity
  }
  // 带宽刻意放宽:硬保底会把史诗+/传说比例向上抬,这里只验"权重在起作用"而非精确概率
  const ratio = (k) => counts[k] / N
  assert.ok(ratio('common') > 0.55 && ratio('common') < 0.85, `common=${ratio('common').toFixed(3)}`)
  assert.ok(ratio('rare') > 0.08 && ratio('rare') < 0.35, `rare=${ratio('rare').toFixed(3)}`)
  assert.ok(ratio('epic') > 0.05 && ratio('epic') < 0.3, `epic=${ratio('epic').toFixed(3)}`)
  assert.ok(ratio('legendary') > 0.005 && ratio('legendary') < 0.08, `legendary=${ratio('legendary').toFixed(3)}`)
  assert.ok(ratio('legendary') < ratio('epic'), '传说必须比史诗稀有')
})

test('硬保底时序:第 10 抽必史诗+,第 40 抽必传说(确定序列)', () => {
  let pity = { sinceEpic: 0, sinceLegendary: 0 }
  const rarities = []
  for (let i = 0; i < 40; i++) {
    const r = g.rollOnce(pity, halfRng)
    rarities.push(r.prize.rarity)
    pity = r.pity
  }
  assert.equal(rarities[9], 'epic') // 第 10 抽:史诗保底
  assert.equal(rarities[19], 'epic')
  assert.equal(rarities[29], 'epic')
  assert.equal(rarities[39], 'legendary') // 第 40 抽:传说保底
  for (let i = 0; i < 40; i++) {
    if (![9, 19, 29, 39].includes(i)) assert.equal(rarities[i], 'common', `第 ${i + 1} 抽应为自然 common`)
  }
  // 从任意深坑状态单抽也能触发
  const deep = { sinceEpic: g.PITY_EPIC - 1, sinceLegendary: g.PITY_LEGENDARY - 1 }
  assert.equal(g.rollOnce(deep, halfRng).prize.rarity, 'legendary') // 传说保底优先
})

test('连抽一致性:次数钳住、图鉴计数合计=总抽数、条目都在池子里', () => {
  let ledger = { ...g.defaultLedger(), drawsLeft: 25 }
  const r = g.drawFromLedger(ledger, 100, seeded(7))
  ledger = r.ledger
  assert.equal(r.prizes.length, 25) // 被剩余次数钳住
  assert.equal(ledger.drawsLeft, 0)
  assert.equal(ledger.totalDraws, 25)
  const counted = Object.values(ledger.collection).reduce((s, e) => s + e.count, 0)
  assert.equal(counted, ledger.totalDraws)
  for (const id of Object.keys(ledger.collection)) {
    assert.ok(p.prizeById(id), `图鉴条目 ${id} 必须在池子里`)
  }
  // 空账本再抽:一无所出,账本原样
  const empty = g.drawFromLedger(g.defaultLedger(), 10)
  assert.equal(empty.prizes.length, 0)
  assert.equal(empty.ledger.drawsLeft, 0)
})

test('支持落账:金额进流水、次数按换算加,单笔超额钳住', () => {
  let ledger = g.defaultLedger()
  ledger = g.foldSupport(ledger, 5.5)
  assert.equal(ledger.totalSupportedYuan, 5.5)
  assert.equal(ledger.drawsLeft, 5)
  ledger = g.foldSupport(ledger, 0)
  ledger = g.foldSupport(ledger, -3)
  assert.equal(ledger.drawsLeft, 5)
  ledger = g.foldSupport(ledger, 3000)
  assert.equal(ledger.totalSupportedYuan, 2005.5) // 单笔按上限 2000 记
  assert.equal(ledger.drawsLeft, 2005)
})

test('账本清洗:非对象/坏字段回默认,陌生 id 与坏计数丢弃', () => {
  assert.deepEqual(g.sanitizeLedger(null), g.defaultLedger())
  assert.deepEqual(g.sanitizeLedger('oops'), g.defaultLedger())
  const dirty = {
    drawsLeft: -10,
    totalDraws: 'x',
    totalSupportedYuan: Number.NaN,
    pity: { sinceEpic: 3.7, sinceLegendary: -1 },
    collection: {
      n1: { count: 2, firstAt: 123 },
      ghost: { count: 5, firstAt: 1 }, // 池子里没有 → 丢
      n2: { count: -4, firstAt: 2 }, // 坏计数 → 丢
      n3: 'junk', // 结构坏 → 丢
    },
  }
  const s = g.sanitizeLedger(dirty)
  assert.equal(s.drawsLeft, 0)
  assert.equal(s.totalDraws, 0)
  assert.equal(s.totalSupportedYuan, 0)
  assert.equal(s.pity.sinceEpic, 3)
  assert.equal(s.pity.sinceLegendary, 0)
  assert.deepEqual(s.collection, { n1: { count: 2, firstAt: 123 } })
})

test('文案渲染:{name} 全替换,空称呼回退「老板」', () => {
  assert.equal(p.resolveSupportText('谢谢{name}!{name}人真好!', '小明'), '谢谢小明!小明人真好!')
  assert.equal(p.resolveSupportText('谢谢{name}!', '   '), '谢谢老板!')
  assert.equal(p.cleanSupportName('很长的名字'.repeat(10)), '很长的名字'.repeat(3).slice(0, 12))
})
