// SentenceSplitter 行为矩阵:句末标点 / 增量跨 delta / 软断(>24 字遇逗号) /
// 60 字硬顶 / 换行断句 / flush 尾句 / 英文小数不受影响。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let mod

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  mod = await server.ssrLoadModule('/src/engine/sentenceSplitter.ts')
})

after(async () => server?.close())

test('句末标点即断,多句一次吐出并 trim', () => {
  const s = mod.createSentenceSplitter()
  assert.deepEqual(s.feed('  你好呀。今天天气怎么样? '), ['你好呀。', '今天天气怎么样?'])
})

test('增量喂入,跨 delta 的句子到标点才出', () => {
  const s = mod.createSentenceSplitter()
  assert.deepEqual(s.feed('我们出发'), [])
  assert.deepEqual(s.feed('吧,好'), [])
  assert.deepEqual(s.feed('吗。'), ['我们出发吧,好吗。'])
})

test('缓冲超 24 字后遇逗号让步断句(降首句延迟)', () => {
  const s = mod.createSentenceSplitter()
  const out = s.feed('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳,后面还有')
  assert.deepEqual(out, ['一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳,'])
  assert.equal(s.flush(), '后面还有')
})

test('60 字硬顶强断(无标点不饿死 TTS)', () => {
  const s = mod.createSentenceSplitter()
  const out = s.feed('x'.repeat(60) + 'y')
  assert.equal(out.length, 1)
  assert.equal(out[0].length, 60)
  assert.deepEqual(s.feed('z'), [])
  assert.equal(s.flush(), 'yz')
})

test('换行算句末,连续空行不产空句', () => {
  const s = mod.createSentenceSplitter()
  assert.deepEqual(s.feed('第一行\n\n第二行'), ['第一行'])
  assert.equal(s.flush(), '第二行')
})

test('flush 交出尾句;空流 flush 为空串', () => {
  assert.equal(mod.createSentenceSplitter().flush(), '')
  const s = mod.createSentenceSplitter()
  assert.deepEqual(s.feed('还有一点'), [])
  assert.equal(s.flush(), '还有一点')
})

test('英文句点不是断点(3.14 不被拆),靠硬顶兜底', () => {
  const s = mod.createSentenceSplitter()
  assert.deepEqual(s.feed('version is 3.14 ok'), [])
  assert.equal(s.flush(), 'version is 3.14 ok')
  // 硬顶断出 60 字,余量仍在缓冲,flush 交出
  const s2 = mod.createSentenceSplitter()
  assert.deepEqual(s2.feed('a'.repeat(70)), ['a'.repeat(60)])
  assert.equal(s2.flush(), 'a'.repeat(10))
})
