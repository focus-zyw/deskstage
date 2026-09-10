// B站直播弹幕二进制协议:纯函数解析器,无任何 IO,供 node --test 直接测试。
// 协议(B站官方 web 直播弹幕,blivedm 等社区实现一致):
//   包头 16 字节大端:u32 包总长(含头) | u16 头长(=16) | u16 协议版本 | u32 操作码 | u32 保留
//   版本 1 = 明文正文;版本 2 = 正文是 zlib 压缩的若干粘连完整包;版本 3 = brotli(v1 不用)
//   操作码:2 心跳 3 心跳应答(人气) 5 业务消息(JSON) 7 认证 8 认证应答

import { inflate } from 'pako'

export const OP_HEARTBEAT = 2
export const OP_HEARTBEAT_REPLY = 3
export const OP_MESSAGE = 5
export const OP_AUTH = 7
export const OP_AUTH_REPLY = 8

const HEADER_LEN = 16

export interface BiliPacket {
  ver: number
  op: number
  body: Uint8Array
}

/** 编码一个包(认证/心跳用) */
export function encodePacket(op: number, body: Uint8Array = new Uint8Array(0), ver = 1): Uint8Array {
  const total = HEADER_LEN + body.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, total)
  view.setUint16(4, HEADER_LEN)
  view.setUint16(6, ver)
  view.setUint32(8, op)
  view.setUint32(12, 1) // 序列号固定 1
  out.set(body, HEADER_LEN)
  return out
}

/** 从累积缓冲解出所有完整包,不足一包的尾部原样返回(流式分帧) */
export function decodeStream(buf: Uint8Array): { packets: BiliPacket[]; rest: Uint8Array } {
  const packets: BiliPacket[] = []
  let off = 0
  while (off + HEADER_LEN <= buf.length) {
    const view = new DataView(buf.buffer, buf.byteOffset + off, HEADER_LEN)
    const total = view.getUint32(0)
    if (total < HEADER_LEN || off + total > buf.length) break // 残包/脏数据,留给下一块
    const headerLen = view.getUint16(4)
    const ver = view.getUint16(6)
    const op = view.getUint32(8)
    const bodyStart = off + headerLen
    if (headerLen < HEADER_LEN || bodyStart > off + total) break // 异常头,丢弃整包防死循环
    packets.push({ ver, op, body: buf.slice(bodyStart, off + total) })
    off += total
  }
  return { packets, rest: buf.slice(off) }
}

/** 解压版本 2 的正文(zlib),得到内嵌的粘连包字节流 */
export function inflateBody(body: Uint8Array): Uint8Array {
  return inflate(body, { raw: false })
}

/** 版本 2 包的正文解压后递归解包 */
export function decodeCompressed(body: Uint8Array): BiliPacket[] {
  return decodeStream(inflateBody(body)).packets
}

export interface BiliDanmu {
  content: string
  userId: string
  username: string
  guard: number
}

/** 从 DANMU_MSG 的 info 数组提取归一化字段;结构不符返回 null(协议变更时静默丢弃)。
 *  info[1]=文本 info[2]=[uid, 用户名, …] info[7]=舰长等级 */
export function parseDanmuMsg(info: unknown): BiliDanmu | null {
  if (!Array.isArray(info)) return null
  const content = info[1]
  const user = info[2]
  if (typeof content !== 'string' || !Array.isArray(user)) return null
  const [uid, username] = user as unknown[]
  const guard = typeof info[7] === 'number' ? info[7] : 0
  return {
    content,
    userId: uid !== undefined && uid !== null ? String(uid) : '',
    username: typeof username === 'string' ? username : '',
    guard,
  }
}

/** 构造认证包正文(uid 取自 cookie 的 DedeUserID,匿名=0;protover 2 = zlib,免 brotli 依赖) */
export function authBody(realRoomId: number, token: string, uid = 0): Uint8Array {
  const json = JSON.stringify({
    uid,
    roomid: realRoomId,
    protover: 2,
    platform: 'web',
    type: 2,
    key: token,
  })
  return new TextEncoder().encode(json)
}

export interface BiliGift {
  giftName: string
  count: number
  coinType: 'gold' | 'silver'
  /** 事件总金额(金瓜子;silver 礼物按 0 计):优先服务端总价 total_coin,
   *  取不到才单价 price × num——字段已是总价时绝不能重复乘 */
  totalCoin: number
  userId: string
  username: string
}

// 脏数据钳位上限:单个事件金额(金瓜子)/数量,超出按上限计,负数/非有限数归零
const MAX_COIN = 10_000_000
const MAX_COUNT = 9999

function clampCoin(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(MAX_COIN, Math.round(n))
}

function clampCount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(MAX_COUNT, Math.round(n))
}

/** 从 SEND_GIFT 的 data 提取归一化礼物字段;结构不符返回 null(协议变更时静默丢弃)。
 *  data 常见字段:giftName/num/price/coin_type('gold'|'silver')/total_coin/uid/uname */
export function parseSendGift(data: unknown): BiliGift | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.giftName !== 'string' || !d.giftName.trim()) return null
  const count = clampCount(d.num)
  const coinType = d.coin_type === 'silver' ? 'silver' : 'gold'
  const totalCoin = coinType === 'silver' ? 0 : clampCoin(d.total_coin) || Math.min(MAX_COIN, clampCoin(d.price) * count)
  return {
    giftName: d.giftName.trim(),
    count,
    coinType,
    totalCoin,
    userId: d.uid !== undefined && d.uid !== null ? String(d.uid) : '',
    username: typeof d.uname === 'string' ? d.uname : '',
  }
}
