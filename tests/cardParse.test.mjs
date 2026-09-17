// Character Card 解析回归:合成 PNG 字节(tEXt/zTXt)与裸 JSON,覆盖
// v2/v3/平铺 v1 归一、ccv3 优先、宏替换、世界书条目归一、坏输入报错。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflate } from 'pako'

const { parseCharacterCard, pngTextChunks, resolveMacros } = await import('../src/cardImport/parseCard.ts')

/** 合成 PNG chunk:length(BE) + type + data + 4 字节占位 CRC */
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, 0xdeadbeef)
  return out
}

const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const latin1 = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff))

function pngWithText(entries) {
  const parts = [SIG]
  for (const { keyword, text, ztx = false } of entries) {
    const data = ztx
      ? [...latin1(keyword), 0, 0, ...deflate(text)]
      : [...latin1(keyword), 0, ...latin1(text)]
    parts.push(chunk(ztx ? 'zTXt' : 'tEXt', new Uint8Array(data)))
  }
  parts.push(chunk('IEND', new Uint8Array(0)))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const b64 = (json) => Buffer.from(JSON.stringify(json), 'utf8').toString('base64')

const V2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '灰原哀',
    description: '科学家的气息,冷淡但心软。{{char}}不喜欢幼稚的玩笑。',
    personality: '毒舌,聪明,傲娇',
    scenario: '阿笠博士家的客厅',
    first_mes: '{{user}}来啦……哼。',
    mes_example: '<START>\n{{user}}: 早安\n{{char}}: ……咖啡。\n<START>\n{{user}}: 晚安\n{{char}}: 别吵。',
    alternate_greetings: ['', '另一版开场'],
    creator_notes: '测试卡',
    creator: 'tester',
    character_version: '1.2',
    tags: ['science', 'test'],
    character_book: {
      entries: [
        { keys: ['组织'], content: '黑衣组织的背景……', constant: false, priority: 5 },
        { keys: [], content: '故事发生在东京。', extensions: { constant: true }, priority: 10 },
        { keys: ['博士'], content: '', constant: true, priority: 99 },
        { keys: '单个键', content: '键为字符串也能归一', enabled: false },
      ],
    },
  },
}

test('tEXt chara 块:V2 卡完整归一', () => {
  const r = parseCharacterCard({ bytes: pngWithText([{ keyword: 'chara', text: b64(V2) }]) })
  assert.ok(r.ok)
  assert.equal(r.card.spec, 'chara_card_v2')
  assert.equal(r.card.name, '灰原哀')
  assert.ok(r.card.description.includes('冷淡但心软'))
  assert.equal(r.card.firstMes, '{{user}}来啦……哼。')
  assert.equal(r.card.alternateGreetings.length, 1)
  assert.equal(r.card.loreBook.length, 3) // 空 content 条目被滤
  const constant = r.card.loreBook.find((e) => e.constant)
  assert.ok(constant && constant.content === '故事发生在东京。') // extensions.constant 归一
  const keyed = r.card.loreBook.find((e) => e.keys.length > 0)
  assert.deepEqual(keyed.keys, ['组织'])
  assert.ok(r.sourceJson.includes('灰原哀'))
})

test('ccv3 优先于 chara:同图双块取 V3', () => {
  const V3 = { spec: 'chara_card_v3', data: { name: 'V3角色', description: '新版' } }
  const r = parseCharacterCard({
    bytes: pngWithText([
      { keyword: 'chara', text: b64(V2) },
      { keyword: 'ccv3', text: b64(V3), ztx: true },
    ]),
  })
  assert.ok(r.ok)
  assert.equal(r.card.spec, 'chara_card_v3')
  assert.equal(r.card.name, 'V3角色')
})

test('平铺 v1:无 spec 时字段在根上', () => {
  const r = parseCharacterCard({ jsonText: JSON.stringify({ name: '老卡', description: 'v1 形态', first_mes: '嗨' }) })
  assert.ok(r.ok)
  assert.equal(r.card.spec, 'v1')
  assert.equal(r.card.description, 'v1 形态')
})

test('键为字符串/数组、enabled=false 条目保留标记(由编译器决定是否用)', () => {
  const r = parseCharacterCard({ jsonText: JSON.stringify(V2) })
  assert.ok(r.ok)
  const strKey = r.card.loreBook.find((e) => e.comment === undefined && e.keys[0] === '单个键')
  assert.ok(strKey)
  assert.equal(strKey.enabled, false)
})

test('宏替换:{{char}}/<BOT>/{{user}}/<USER> 大小写不敏感,其余宏保留', () => {
  const out = resolveMacros(
    '{{CHAR}}对<BOT>说,<USER>听着;{{random:a,b}}与{{time}}不动',
    { char: '灰原哀', user: '阿笠博士' },
  )
  assert.equal(out, '灰原哀对灰原哀说,阿笠博士听着;{{random:a,b}}与{{time}}不动')
})

test('坏输入:非 PNG / 无卡数据 / 坏 JSON / 缺 name', () => {
  assert.ok(!parseCharacterCard({ bytes: new Uint8Array([1, 2, 3]) }).ok)
  const noCard = pngWithText([{ keyword: 'Comment', text: '无关' }])
  const r1 = parseCharacterCard({ bytes: noCard })
  assert.ok(!r1.ok)
  assert.ok(r1.error.includes('没有角色卡数据'))
  const r2 = parseCharacterCard({ bytes: pngWithText([{ keyword: 'chara', text: Buffer.from('不是base64&&&').toString('base64') + '!!' }]) })
  assert.ok(!r2.ok)
  const r3 = parseCharacterCard({ jsonText: '{broken' })
  assert.ok(!r3.ok)
  assert.ok(!parseCharacterCard({ jsonText: JSON.stringify({ description: '没名字' }) }).ok)
  assert.ok(!parseCharacterCard({}).ok)
})

test('pngTextChunks:zTXt inflate 还原与结构损坏容错', () => {
  const bytes = pngWithText([{ keyword: 'ccv3', text: 'whatever', ztx: true }])
  const chunks = pngTextChunks(bytes)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].keyword, 'ccv3')
  assert.equal(chunks[0].text, 'whatever')
  // 截断:只剩签名不炸,返回空
  assert.deepEqual(pngTextChunks(SIG), [])
})

test('正文字段剥 markdown 代码围栏(卡作者常整段包 ``` 围栏)', () => {
  const NL = String.fromCharCode(10)
  const desc = ['```plaintext', '---', '', '**Full Name**: Chloe', '---', '```'].join(NL)
  const r = parseCharacterCard({ jsonText: JSON.stringify({ name: 'Chloe', description: desc, first_mes: '```\n嗨```' }) })
  assert.ok(r.ok)
  assert.equal(r.card.description.startsWith('```'), false)
  assert.ok(r.card.description.includes('**Full Name**: Chloe'))
  assert.equal(r.card.firstMes, '嗨')
  // 非围栏正文原样保留;内部围栏不剥
  const r2 = parseCharacterCard({ jsonText: JSON.stringify({ name: 'X', description: '正常\n\n正文', mes_example: 'a\n```py\ncode\n```\nb' }) })
  assert.ok(r2.ok)
  assert.equal(r2.card.description, '正常\n\n正文')
  assert.ok(r2.card.mesExample.includes('```py'))
})
