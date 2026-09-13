// send_live_message 工具:以主播身份在直播间发弹幕(external 级,必须确认)。
// 凭据纪律:cookie 由适配器内部从凭据库('live:cookie')读取,csrf(bili_jct)
// 从 cookie 解析——入参、日志、结果、观察块里永不出现;真实房间号经 room_init
// 归一(短号也能发)。B站通道域名白名单已覆盖 api.live.bilibili.com。
import { invoke } from '@tauri-apps/api/core'
import { readSecret } from '../../storage/secrets'
import { getConfig } from '../../storage/configStore'
import { scoreByRules } from '../candidateGate'
import { validateToolInput, type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'

const inputSchema: ToolInputSchema = {
  properties: {
    text: { type: 'string', description: '要发送的弹幕内容', maxLength: 30 },
  },
  required: ['text'],
}

interface BiliResp {
  status: number
  body: string
}

async function readLiveCookie(): Promise<string> {
  const cfg = await getConfig()
  const secret = await readSecret('live:cookie')
  return (secret ?? cfg.live.cookie ?? '').trim()
}

const manifest: ToolManifest = {
  id: 'send_live_message',
  label: '发弹幕',
  description: '以主播身份在当前直播间发送一条弹幕',
  risk: 'external',
  inputSchema,
  timeoutMs: 20_000,
  defaultEnabled: false,
  match: (text, ctx) => {
    if (!ctx.isLive) return 0 // 非直播不候选:发弹幕的前提是直播中
    return scoreByRules(text, [
      { re: /(发个?弹幕|发条弹幕|弹幕发|发到直播间|在直播间说|直播间里说)/, weight: 1 },
      { re: /(弹幕)/, weight: 0.6 },
    ])
  },
  presentation: { actor: 'A', pendingText: '这条我亲自发~', action: 'wave' },
}

export const sendLiveMessageTool: CharacterTool = {
  manifest,
  available: async () => {
    try {
      const cfg = await getConfig()
      if (!cfg.live.roomId.trim()) return false
      return /bili_jct=/i.test(await readLiveCookie())
    } catch {
      return false
    }
  },
  validate: (input) => validateToolInput(inputSchema, input),
  async execute(input, ctx) {
    const v = validateToolInput(inputSchema, input)
    if (!v.ok) return { ok: false, summary: v.reason, errorCode: 'invalid' }
    const text = String(v.value.text)
    const cookie = await readLiveCookie()
    const csrf = cookie.match(/bili_jct=([^;\s]+)/i)?.[1]
    if (!csrf) return { ok: false, summary: '没有可用的直播登录凭据', errorCode: 'no-credential' }
    const cfg = await getConfig()
    ctx.report?.('解析直播间…')
    const init = await invoke<BiliResp>('bili_http_request', {
      url: `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(cfg.live.roomId.trim())}`,
      cookie,
    })
    const realRoomId = safeJson(init.body)?.data?.room_id
    if (typeof realRoomId !== 'number' || realRoomId <= 0) {
      return { ok: false, summary: '直播间号无效(解析不到真实房间号)', errorCode: 'bad-room' }
    }
    ctx.report?.('发送弹幕中…')
    const body = new URLSearchParams({
      bubble: '0',
      msg: text,
      color: '16777215',
      mode: '1',
      roomid: String(realRoomId),
      csrf,
      csrf_token: csrf,
      platform: 'pc',
    }).toString()
    const resp = await invoke<BiliResp>('bili_http_request', {
      url: 'https://api.live.bilibili.com/msg/send',
      method: 'POST',
      cookie,
      referer: `https://live.bilibili.com/${realRoomId}`,
      body,
    })
    const out = safeJson(resp.body) as { code?: number; message?: string } | null
    if (out?.code !== 0) {
      // B站拒绝(风控/频率/长度):message 带原因,不回传 cookie 与完整报文
      return {
        ok: false,
        summary: `弹幕未发出(code ${out?.code ?? resp.status})${out?.message ? `:${out.message.slice(0, 60)}` : ''}`,
        errorCode: 'bili-reject',
      }
    }
    return { ok: true, summary: `弹幕已发送:${text}` }
  },
}

function safeJson(s: string): { data?: { room_id?: number } } | null {
  try {
    return JSON.parse(s) as { data?: { room_id?: number } } | null
  } catch {
    return null
  }
}
