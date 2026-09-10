// B站弹幕二进制协议解析器测试:vite ssrLoadModule 直载 TS 源码(与 spriteVariants.test.mjs 同模式)。
// zlib 用例:真实 deflate 压缩两个粘连包再解,覆盖"版本2正文→递归解包"主路径。
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let proto

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ proto } = { proto: await server.ssrLoadModule('/src/live/providers/biliProto.ts') })
})

after(async () => {
  await server?.close()
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

test('authBody 为匿名 protover2 认证 JSON', () => {
  const body = new TextDecoder().decode(proto.authBody(23058, 'tok123'))
  const o = JSON.parse(body)
  assert.equal(o.uid, 0)
  assert.equal(o.roomid, 23058)
  assert.equal(o.protover, 2)
  assert.equal(o.key, 'tok123')
})
