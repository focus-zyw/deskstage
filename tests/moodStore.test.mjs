// 情绪持久层回归:落盘/读档清洗、读时惰性衰减不回写、被戳小步、复位。
// 非 Tauri 环境走 localStorage,先垫桩(与 storyCurator.test 同套路)。
// 注意:store 有内存缓存(首读后不再回磁盘),所以衰减用例必须先于一切加载发生。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

let store

const HOUR = 3_600_000

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
  store = await import('../src/storage/moodStore.ts')
})

after(async () => {
  delete globalThis.localStorage
})

const raw = () => JSON.parse(localStorage.getItem('vc-mood'))

test('同步读在未加载时回中性默认,不炸', () => {
  const m = store.moodOf('A')
  assert.equal(m.valence, 0)
  assert.ok(m.energy > 0 && m.energy <= 5)
})

test('读时惰性衰减:存量过 10 小时后大幅回落,且不回写衰减值', async () => {
  const tenHoursAgo = Date.now() - 10 * HOUR
  localStorage.setItem(
    'vc-mood',
    JSON.stringify({
      version: 1,
      mood: { A: { valence: -2, energy: 4, updatedAt: tenHoursAgo, cause: '旧账' } },
    }),
  )
  const m = await store.getMoods() // 首次加载,读入的是手工档
  // -2 × 0.7^10 ≈ -0.0565:已翻篇,量级不足 1.5 不再进提示词
  assert.ok(Math.abs(m.A.valence + 0.0565) < 0.005, `valence=${m.A.valence}`)
  assert.ok(Math.abs(m.A.valence) < 1.5)
  assert.equal(raw().mood.A.updatedAt, tenHoursAgo) // 读不回写
  assert.equal(m.A.cause, '旧账')
})

test('复位到默认后,应用增量会落盘', async () => {
  await store.resetMoods()
  const first = await store.getMoods()
  assert.equal(first.A.valence, 0)

  await store.applyMoodDeltas([{ who: 'A', dValence: -2, dEnergy: 1, cause: '被当众拆台' }])
  const afterApply = await store.getMoods()
  assert.ok(Math.abs(afterApply.A.valence + 2) < 0.01, `valence=${afterApply.A.valence}`)
  assert.equal(afterApply.A.cause, '被当众拆台')
  assert.ok(Math.abs(raw().mood.A.valence + 2) < 0.01) // 落盘内容可读回
})

test('被戳小步:头一戳开心,窗口内连戳转烦', async () => {
  await store.resetMoods()
  await store.notePoked('B')
  const first = store.moodOf('B')
  assert.ok(first.valence > 0, `valence=${first.valence}`)
  await store.notePoked('B')
  const second = store.moodOf('B')
  assert.ok(second.valence < first.valence, `second=${second.valence}`)
  assert.ok(second.energy >= first.energy)
  assert.match(second.cause, /连戳/)
})

test('复位:三人全部回中性', async () => {
  await store.resetMoods()
  const m = await store.getMoods()
  for (const who of ['A', 'B', 'C']) {
    assert.equal(m[who].valence, 0)
    assert.equal(m[who].cause, undefined)
  }
})
