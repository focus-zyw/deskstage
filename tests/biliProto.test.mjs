// B站弹幕二进制协议解析器测试:直接 import 加载 TS 源码(与 spriteVariants.test.mjs 同模式)。
// zlib 用例:真实 deflate 压缩两个粘连包再解,覆盖"版本2正文→递归解包"主路径。
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { before, test } from 'node:test'

let proto

before(async () => {
  ;({ proto } = { proto: await import('../src/live/providers/biliProto.ts') })
})


/** 手工拼一个包(独立于被测的 encodePacket,互为校验) */
function buildPacket(ver, op, body) {
  const head = Buffer.alloc(16)
  head.writeUInt32BE(16 + body.length, 0)
  head.writeUInt16BE(16, 4)
  head.writeUInt16BE(ver, 6)
  head.writeUInt32BE(op, 8)
  head.writeUInt32BE(1, 12)
  return Buffer.concat([head, body])
}

test('encodePacket 产出的头字段符合协议', () => {
  const body = new TextEncoder().encode('{"uid":0}')
  const pkt = proto.encodePacket(proto.OP_AUTH, body)
  assert.equal(pkt.length, 16 + body.length)
  const view = new DataView(pkt.buffer)
  assert.equal(view.getUint32(0), pkt.length)
  assert.equal(view.getUint16(4), 16)
  assert.equal(view.getUint16(6), 1)
  assert.equal(view.getUint32(8), proto.OP_AUTH)
})

test('decodeStream 拆分粘连包并保留残包', () => {
  const a = buildPacket(1, proto.OP_HEARTBEAT, Buffer.alloc(0))
  const bBody = new TextEncoder().encode('hi')
  const b = buildPacket(1, proto.OP_MESSAGE, bBody)
  const whole = new Uint8Array(Buffer.concat([a, b]))
  const { packets, rest } = proto.decodeStream(whole)
  assert.equal(packets.length, 2)
  assert.equal(packets[0].op, proto.OP_HEARTBEAT)
  assert.equal(packets[1].op, proto.OP_MESSAGE)
  assert.equal(new TextDecoder().decode(packets[1].body), 'hi')
  assert.equal(rest.length, 0)
  // 残包:砍掉最后一字节,解出一包,尾巴留缓冲
  const { packets: partial, rest: tail } = proto.decodeStream(whole.slice(0, -1))
  assert.equal(partial.length, 1)
  assert.equal(tail.length, b.length - 1)
})

test('版本 2 zlib 正文递归解出内嵌包', () => {
  const inner = Buffer.concat([
    buildPacket(1, proto.OP_MESSAGE, new TextEncoder().encode('{"cmd":"DANMU_MSG"}')),
    buildPacket(1, proto.OP_AUTH_REPLY, Buffer.alloc(0)),
  ])
  const compressed = new Uint8Array(deflateSync(inner))
  const { packets } = proto.decodeStream(buildPacket(2, proto.OP_MESSAGE, compressed))
  assert.equal(packets.length, 1)
  assert.equal(packets[0].ver, 2)
  const nested = proto.decodeCompressed(packets[0].body)
  assert.equal(nested.length, 2)
  assert.equal(nested[0].op, proto.OP_MESSAGE)
  assert.equal(nested[1].op, proto.OP_AUTH_REPLY)
})

test('parseDanmuMsg 提取归一化字段,结构不符返回 null', () => {
  const d = proto.parseDanmuMsg([[], '你好世界', [42, '小明'], [], [], [], [], 3])
  assert.deepEqual(d, { content: '你好世界', userId: '42', username: '小明', guard: 3 })
  // uid 缺失/卫舰等级非数字的容错
  assert.deepEqual(proto.parseDanmuMsg([[], 'x', [null, '无名'], [], [], [], [], 'bad']), {
    content: 'x',
    userId: '',
    username: '无名',
    guard: 0,
  })
  assert.equal(proto.parseDanmuMsg(null), null)
  assert.equal(proto.parseDanmuMsg([[], 'x']), null)
})

test('authBody 为匿名 protover2 认证 JSON,uid 可带登录态', () => {
  const anon = JSON.parse(new TextDecoder().decode(proto.authBody(23058, 'tok123')))
  assert.equal(anon.uid, 0)
  assert.equal(anon.roomid, 23058)
  assert.equal(anon.protover, 2)
  assert.equal(anon.key, 'tok123')
  const logged = JSON.parse(new TextDecoder().decode(proto.authBody(23058, 'tok123', 12345)))
  assert.equal(logged.uid, 12345)
  const withBuvid = JSON.parse(new TextDecoder().decode(proto.authBody(23058, 'tok123', 12345, 'buvid-abc')))
  assert.equal(withBuvid.buvid, 'buvid-abc')
  assert.equal('buvid' in anon, false, '匿名认证包不带 buvid 字段')
})

// ---------- parseSendGift:礼物事件归一化 ----------

test('parseSendGift 解析真实结构:total_coin 优先,不重复乘数量', () => {
  const g = proto.parseSendGift({
    giftName: '小花花',
    num: 3,
    price: 100,
    coin_type: 'gold',
    total_coin: 300,
    uid: 4242,
    uname: '小明',
  })
  assert.deepEqual(g, {
    giftName: '小花花',
    count: 3,
    coinType: 'gold',
    totalCoin: 300, // 有总价字段就用总价,不能 300×3
    userId: '4242',
    username: '小明',
  })
})

test('parseSendGift 无 total_coin 时回退 单价×数量', () => {
  const g = proto.parseSendGift({ giftName: '能量箭头', num: 10, price: 50, coin_type: 'gold' })
  assert.equal(g.totalCoin, 500)
  assert.equal(g.userId, '')
  assert.equal(g.username, '')
})

test('parseSendGift silver 礼物金额按 0 计', () => {
  const g = proto.parseSendGift({ giftName: '辣条', num: 1, price: 100, coin_type: 'silver', total_coin: 100 })
  assert.equal(g.coinType, 'silver')
  assert.equal(g.totalCoin, 0)
  // coin_type 缺失/异常值 → gold 白名单外归 gold,但金额照算
  const d = proto.parseSendGift({ giftName: 'x', num: 2, price: 10 })
  assert.equal(d.coinType, 'gold')
  assert.equal(d.totalCoin, 20)
})

test('parseSendGift 钳位:非有限/负数归零,数量下限 1,超限封顶', () => {
  assert.equal(proto.parseSendGift({ giftName: 'x', num: 2, price: -5 }).totalCoin, 0)
  assert.equal(proto.parseSendGift({ giftName: 'x', num: 2, price: Number.NaN }).totalCoin, 0)
  assert.equal(proto.parseSendGift({ giftName: 'x', num: 0, price: 100 }).count, 1)
  assert.equal(proto.parseSendGift({ giftName: 'x', num: 'bad', price: 100 }).count, 1)
  assert.equal(
    proto.parseSendGift({ giftName: 'x', num: 999999, price: 999999999 }).totalCoin,
    10_000_000,
  )
})

test('parseSendGift 结构不符返回 null,giftName 空白也拒收', () => {
  assert.equal(proto.parseSendGift(null), null)
  assert.equal(proto.parseSendGift('bad'), null)
  assert.equal(proto.parseSendGift({ num: 1 }), null)
  assert.equal(proto.parseSendGift({ giftName: '   ', num: 1 }), null)
})

test('parseSendGift giftName 去首尾空白,uid 数字化', () => {
  const g = proto.parseSendGift({ giftName: '  猫爪  ', num: 1 })
  assert.equal(g.giftName, '猫爪')
  const u = proto.parseSendGift({ giftName: 'x', num: 1, uid: 0 })
  assert.equal(u.userId, '0')
})
