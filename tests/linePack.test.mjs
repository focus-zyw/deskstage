// 每日互动台词包回归:存档最多 7 份(超出删最早)、取用链"今天的包 → 最早的存档 → null"、
// parseLinePackJson 容错(围栏/杂文本/超长句/缺类目)。取用链是用户点名的行为约定:
// 台词包一天一换,旧包在被淘汰前先用掉,一份都没有才回本地预置池。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let store
let llm

/** 相对今天偏移 offset 天的本地日期键(与 dayKey 同格式) */
function day(offset) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${dd}`
}

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
  store = await server.ssrLoadModule('/src/storage/linePackStore.ts')
  llm = await server.ssrLoadModule('/src/engine/llmClient.ts')
})

after(async () => {
  await server?.close()
  delete globalThis.localStorage
})

test('存档最多 7 份:超出后删除最早的(今天的包也参与排序)', async () => {
  // 存 8 份:day(-7) .. day(0),标签与日期对齐(d1 最旧,d8 是今天)
  for (let i = 1; i <= 8; i++) {
    await store.saveLinePack({ date: day(i - 8), lines: { poke: [`d${i}-a`, `d${i}-b`] } })
  }
  const packs = await store.loadLinePacks()
  assert.equal(packs.length, 7, '应只保留 7 份')
  assert.equal(packs.some((p) => p.date === day(-7)), false, '最早的一份(d1)应被淘汰')
  assert.deepEqual(packs.map((p) => p.date), [-6, -5, -4, -3, -2, -1, 0].map((k) => day(k)))
})

test('取用链:今天的包优先,取空后从最早的存档续取,全部取空回 null', async () => {
  const today = day(0) // d8 的包
  const first = store.takePackLine('poke', today)
  assert.ok(first?.startsWith('d8-'), `第一句应来自今天的包,实际 ${first}`)
  const second = store.takePackLine('poke', today)
  assert.ok(second?.startsWith('d8-'), `今天的包有两句都算今天的,实际 ${second}`)
  const third = store.takePackLine('poke', today)
  assert.ok(third?.startsWith('d2-'), `今天取空后应从最早存档(d2)续取,实际 ${third}`)
  // 之后一路从 d3 取到 d7,取完即 null(调用方回退内置池)
  let line = third
  for (let i = 0; i < 30 && line; i++) line = store.takePackLine('poke', today)
  assert.equal(line, null)
})

test('取用链:所有存档都没有该类目时直接 null,不串到其他类目', () => {
  assert.equal(store.takePackLine('nap', day(0)), null)
})

test('没有今天的包时,从最早的、还有该类目存货的存档取', async () => {
  // 当前存档 d2..d8 都只有 poke;补两份带 joke 的(joke 类目此前未被消费,状态干净)
  await store.saveLinePack({ date: day(1), lines: { joke: ['b-joke'] } })
  await store.saveLinePack({ date: day(2), lines: { joke: ['c-joke'] } })
  // 今天之后(day(3))没有包 → 从最早的带 joke 存档(day(1))取
  assert.equal(store.takePackLine('joke', day(3)), 'b-joke')
  assert.equal(store.takePackLine('joke', day(3)), 'c-joke')
  assert.equal(store.takePackLine('joke', day(3)), null)
})

test('parseLinePackJson:容忍围栏与前后杂文本,缺类目缺席,超长句剔除', () => {
  const raw = [
    '好的,这是台词包:',
    '```json',
    JSON.stringify({
      poke: ['一句话', 42, null, '   ', 'x'.repeat(31), '另一句'],
      headpat: ['摸头句'],
    }),
    '```',
    '希望你喜欢',
  ].join('\n')
  const parsed = llm.parseLinePackJson(raw)
  assert.ok(parsed)
  assert.deepEqual(parsed.poke, ['一句话', '另一句'])
  assert.deepEqual(parsed.headpat, ['摸头句'])
  assert.equal('feed' in parsed, false, '缺失类目不应出现')
})

test('parseLinePackJson:纯 JSON 与剥引号都成立;非 JSON 返回 null', () => {
  const plain = llm.parseLinePackJson(JSON.stringify({ joke: ['冷笑话一句'] }))
  assert.deepEqual(plain.joke, ['冷笑话一句'])
  // 模型把每句又包了一层引号:剥掉
  const quoted = llm.parseLinePackJson('{"trick":["\\"见证奇迹!\\"","（杂技）看招"]}')
  assert.deepEqual(quoted.trick, ['见证奇迹!', '（杂技）看招'])
  assert.equal(llm.parseLinePackJson('不是 JSON'), null)
  assert.equal(llm.parseLinePackJson('{"poke":"不是数组"}'), null)
  assert.equal(llm.parseLinePackJson('{}'), null)
})
