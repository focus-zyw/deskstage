// B站弹幕 Provider(真实实现)。链路:
//   房间号 → room_init 换真实长号(支持短号) → getDanmuInfo 拿 token+WS 主机
//   → wss://…/sub 认证(protover 2,zlib)→ 30s 心跳 → op5 消息包解压解析 DANMU_MSG
// HTTP 走 tauri-plugin-http(Rust 转发免 CORS);WS 是 webview 原生,B站不校验来源。
// 断线指数退避重连;generation 计数保证 disconnect 后旧连接的回调全部作废。

import { fetch as rustFetch } from '@tauri-apps/plugin-http'
import { inTauri } from '../../storage/configStore'
import type { LiveDanmakuProvider, LiveEvent, LiveStatus } from '../types'
import {
  authBody,
  decodeCompressed,
  decodeStream,
  encodePacket,
  OP_AUTH,
  OP_AUTH_REPLY,
  OP_HEARTBEAT,
  OP_MESSAGE,
  parseDanmuMsg,
  parseSendGift,
  type BiliPacket,
} from './biliProto'

const API = 'https://api.live.bilibili.com'
const HEARTBEAT_MS = 30_000
const RECONNECT_BASE_MS = 3_000
const RECONNECT_MAX_MS = 60_000
// 真实浏览器 UA:B站接口对无 UA 请求可能 403
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

interface ApiResult<T> {
  code: number
  message?: string
  data?: T
}

async function apiGet<T>(path: string, cookie?: string): Promise<T> {
  // Tauri 内走 Rust 转发(免 CORS);浏览器 dev 直连(CORS 不通时冒烟改走注入,不阻塞开发)
  const f = inTauri ? rustFetch : fetch
  const res = await f(`${API}${path}`, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://live.bilibili.com/',
      // Origin 显式传空:插件强加 webview 来源 Origin 时B站接口会 403(需 unsafe-headers feature)
      Origin: '',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  })
  if (!res.ok) throw new Error(`B站接口 HTTP ${res.status}`)
  const json = (await res.json()) as ApiResult<T>
  if (json.code !== 0) throw new Error(`B站接口错误:${json.message || json.code}`)
  return json.data as T
}

/** 规整用户凭证:只贴了 SESSDATA 值时补上键名;完整 Cookie 串原样用 */
function normalizeCookie(credential: string): string {
  const c = credential.trim()
  return c.includes('=') ? c : `SESSDATA=${c}`
}

interface BiliCredential {
  cookie: string
  /** 登录账号的 uid(cookie 的 DedeUserID;拿不到回落 0) */
  uid: number
}

/** 解析登录凭证:cookie 里带 DedeUserID 直接用;只有 SESSDATA 时问一次 nav 接口拿自己的 uid
 *  (带 cookie 无风控)。失败不致命——回落匿名 uid=0,只是观众名可能仍被打码 */
async function prepareCredential(credential?: string): Promise<BiliCredential | null> {
  if (!credential?.trim()) return null
  const cookie = normalizeCookie(credential)
  const dede = cookie.match(/DedeUserID=(\d+)/i)
  if (dede) return { cookie, uid: Number(dede[1]) }
  try {
    const f = inTauri ? rustFetch : fetch
    const res = await f('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'User-Agent': UA, Referer: 'https://live.bilibili.com/', Cookie: cookie },
    })
    const mid = ((await res.json()) as { data?: { mid?: number } })?.data?.mid
    if (typeof mid === 'number' && mid > 0) return { cookie, uid: mid }
  } catch (e) {
    console.warn('[live] nav 取 uid 失败,回落匿名连接', e)
  }
  return { cookie, uid: 0 }
}

async function resolveRealRoom(roomId: string, cookie?: string): Promise<number> {
  const id = Number(roomId)
  if (!Number.isFinite(id) || id <= 0) throw new Error('房间号应为数字')
  const data = await apiGet<{ room_id: number }>(`/room/v1/Room/room_init?id=${id}`, cookie)
  if (!data?.room_id) throw new Error('房间不存在或已封禁')
  return data.room_id
}

interface DanmuInfo {
  token: string
  host_list: { host: string; wss_port: number }[]
}

async function getDanmuInfo(realRoomId: number, cookie?: string): Promise<DanmuInfo> {
  // 注意:getDanmuInfo 已上 gaia 风控(裸请求 -352);老接口 getConf 同样返回
  // token + 主机表且无风控,故用它(社区 blivedm 系 2025 起的通行做法之一)。
  // 两接口字段名不同:host_list vs host_server_list,此处归一。
  // 带登录 cookie 请求时 token 绑定该会话,弹幕服务器才会回真实用户名(否则打码)
  const data = await apiGet<
    DanmuInfo & { host_server_list?: { host: string; wss_port: number }[] }
  >(`/room/v1/Danmu/getConf?room_id=${realRoomId}&platform=web&player=web`, cookie)
  const hosts = data?.host_list ?? data?.host_server_list ?? []
  const host = hosts.find((h) => h.wss_port > 0)
  if (!data?.token || !host) throw new Error('拿不到弹幕服务器信息')
  return { token: data.token, host_list: hosts }
}

/** 单次会话的连接上下文:generation 不匹配 = 已被 disconnect/重开,回调作废 */
class BilibiliProvider implements LiveDanmakuProvider {
  readonly platform = 'bilibili' as const

  private gen = 0
  private ws: WebSocket | null = null
  private heartbeatTimer: number | null = null
  private reconnectTimer: number | null = null
  /** 流式分帧的残包缓冲(decodeStream 返回 ArrayBufferLike 视图,字段放宽避免赋值冲突) */
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)

  connect(
    roomId: string,
    onEvent: (e: LiveEvent) => void,
    onStatus: (s: LiveStatus) => void,
    credential?: string,
  ): void {
    this.disconnect()
    const gen = ++this.gen
    void this.run(gen, roomId, onEvent, onStatus, credential)
  }

  disconnect(): void {
    this.gen++
    this.clearTimers()
    this.ws?.close()
    this.ws = null
    this.pending = new Uint8Array(0)
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private async run(
    gen: number,
    roomId: string,
    onEvent: (e: LiveEvent) => void,
    onStatus: (s: LiveStatus) => void,
    credential?: string,
  ): Promise<void> {
    const alive = () => gen === this.gen
    // 凭证每次 connect 解析一次(重连复用);登录态 token 才能拿到未打码的观众名
    const cred = await prepareCredential(credential)
    if (!alive()) return
    let attempts = 0
    for (;;) {
      if (!alive()) return
      onStatus({
        state: 'connecting',
        detail: attempts > 0 ? `第 ${attempts + 1} 次尝试连接` : cred ? `已登录(UID ${cred.uid})` : undefined,
      })
      try {
        const realRoomId = await resolveRealRoom(roomId, cred?.cookie)
        if (!alive()) return
        const info = await getDanmuInfo(realRoomId, cred?.cookie)
        if (!alive()) return
        const host = info.host_list.find((h) => h.wss_port > 0)!
        await this.openSocket(gen, roomId, realRoomId, info.token, cred?.uid ?? 0, `wss://${host.host}:${host.wss_port}/sub`, onEvent, onStatus)
        attempts = 0 // 成功连过一轮,重置退避
      } catch (e) {
        if (!alive()) return
        const msg = (e as Error)?.message ?? String(e)
        onStatus({ state: 'error', detail: msg })
      }
      // 退避重连( disconnect 后 alive=false 直接退出)
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempts++)
      onStatus({ state: 'connecting', detail: `${delay / 1000}s 后重连` })
      await new Promise<void>((r) => {
        this.reconnectTimer = window.setTimeout(r, delay)
      })
    }
  }

  /** 建立一条 WS 并服务到它断开为止(resolve 在 close 时落定) */
  private openSocket(
    gen: number,
    roomId: string,
    realRoomId: number,
    token: string,
    uid: number,
    url: string,
    onEvent: (e: LiveEvent) => void,
    onStatus: (s: LiveStatus) => void,
  ): Promise<void> {
    const alive = () => gen === this.gen
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      const settled = () => {
        this.clearTimers()
        resolve()
      }
      ws.onopen = () => {
        if (!alive()) {
          ws.close()
          return
        }
        ws.send(encodePacket(OP_AUTH, authBody(realRoomId, token, uid)).buffer as ArrayBuffer)
        // 立即一跳 + 周期心跳
        ws.send(encodePacket(OP_HEARTBEAT).buffer as ArrayBuffer)
        this.heartbeatTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(encodePacket(OP_HEARTBEAT).buffer as ArrayBuffer)
        }, HEARTBEAT_MS)
      }
      ws.onmessage = (ev) => {
        if (!alive()) return
        try {
          this.feed(new Uint8Array(ev.data as ArrayBuffer), roomId, onEvent, onStatus)
        } catch (e) {
          console.warn('[live] 弹幕包解析失败(忽略)', e)
        }
      }
      ws.onclose = () => {
        if (alive()) onStatus({ state: 'closed', detail: '连接断开' })
        settled()
      }
      ws.onerror = () => {
        if (alive()) onStatus({ state: 'error', detail: 'WebSocket 连接失败' })
        settled()
      }
      // 认证应答到达即视为 live(onmessage 里置位),这里不重复;超时兜底交给外层重连
    })
  }

  /** 喂入一块 WS 字节:拼上残包缓冲,解出完整包并分发 */
  private feed(
    chunk: Uint8Array,
    roomId: string,
    onEvent: (e: LiveEvent) => void,
    onStatus: (s: LiveStatus) => void,
  ): void {
    const merged = new Uint8Array(this.pending.length + chunk.length)
    merged.set(this.pending)
    merged.set(chunk, this.pending.length)
    let { packets, rest } = decodeStream(merged)
    this.pending = rest
    const queue: BiliPacket[] = [...packets]
    while (queue.length > 0) {
      const p = queue.shift()!
      if (p.ver === 2) {
        // zlib 正文内是粘连的完整包
        queue.push(...decodeCompressed(p.body))
        continue
      }
      if (p.op === OP_MESSAGE) {
        const text = new TextDecoder().decode(p.body)
        const json = JSON.parse(text) as { cmd?: string; info?: unknown; data?: unknown }
        if (json.cmd === 'DANMU_MSG') {
          const d = parseDanmuMsg(json.info)
          if (d && d.content.trim()) {
            onEvent({
              kind: 'danmaku',
              platform: 'bilibili',
              roomId,
              userId: d.userId,
              username: d.username,
              content: d.content,
              timestamp: Date.now(),
              guard: d.guard,
            })
          }
        } else if (json.cmd === 'SEND_GIFT') {
          // 礼物事件(连击按每次 SEND_GIFT 计):归一化为 GiftEvent 走免 AI 旁路。
          // COMBO_SEND 等聚合消息与 INTERACT_WORD v1 仍忽略
          const g = parseSendGift(json.data)
          if (g) {
            onEvent({
              kind: 'gift',
              platform: 'bilibili',
              roomId,
              userId: g.userId,
              username: g.username,
              timestamp: Date.now(),
              gift: { name: g.giftName, count: g.count, coinType: g.coinType, totalCoin: g.totalCoin },
            })
          }
        }
        // 其他 cmd(GIFT 旧版/INTERACT_WORD/…)v1 忽略
      }
      // op3 人气值 / op8 认证应答:v1 只用来确认连通(onopen 后第一跳的应答),不单独上报
      if (p.op === OP_AUTH_REPLY) onStatus({ state: 'live' })
    }
  }
}

export const bilibiliProvider = new BilibiliProvider()
