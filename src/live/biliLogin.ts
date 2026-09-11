// B站扫码登录:设置面板出二维码 → 手机B站App扫一扫确认 → 轮询拿到登录 cookie 回填。
// 接口(passport.bilibili.com,无验证码,B站网页版自家在用):
//   generate → { url(二维码内容), qrcode_key }
//   poll     → data.code: 86101 未扫码 | 86090 已扫未确认 | 86038 已失效 | 0 成功
//   成功时 data.url 是 crossDomain 跳转链接,查询参数里带全套登录 cookie
//   (DedeUserID/SESSDATA/bili_jct)——浏览器读不到 Set-Cookie,解析该链接是社区通行做法。
import { invoke } from '@tauri-apps/api/core'
import { inTauri } from '../storage/configStore'
import type { BiliHttpResponse } from './types'

const PASSPORT = 'https://passport.bilibili.com'
const POLL_MS = 1500
/** 二维码有效期约 180s;过期自动重生成,最多 3 轮 */
const QR_TTL_MS = 175_000 // 服务端 180s 失效,客户端提前 5s 判定,避免扫到临界失效码
const MAX_ROUNDS = 4
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export type QrPhase = 'waiting' | 'scanned' | 'ok' | 'expired' | 'error'

export interface QrLoginHooks {
  /** round = 二维码轮次号(每次过期刷新递增):UI 凭它丢弃旧轮的迟到异步结果 */
  onQr: (round: number, url: string) => void
  onPhase: (p: QrPhase, message?: string) => void
  onSuccess: (r: { cookie: string; uid: number }) => void
}

export interface QrLoginHandle {
  cancel(): void
}

/** 从 crossDomain 跳转链接解析登录 cookie 与 uid。缺关键字段/坏链接返回 null。
 *  纯函数,node --test 直测。注意:不能走 URLSearchParams——它会把 '+' 解码成空格,
 *  而 SESSDATA 值里可能出现 '+',必须用 decodeURIComponent(不动 '+') */
export function cookieFromCrossUrl(url: string): { cookie: string; uid: number } | null {
  try {
    const qs = url.slice(url.indexOf('?') + 1)
    const get = (key: string): string | null => {
      for (const pair of qs.split('&')) {
        const eq = pair.indexOf('=')
        if (eq > 0 && pair.slice(0, eq) === key) return decodeURIComponent(pair.slice(eq + 1))
      }
      return null
    }
    const sess = get('SESSDATA')
    const dede = get('DedeUserID')
    if (!sess || !dede) return null
    const jct = get('bili_jct')
    const cookie =
      `DedeUserID=${dede}; SESSDATA=${sess}` + (jct ? `; bili_jct=${jct}` : '')
    return { cookie, uid: Number(dede) }
  } catch {
    return null
  }
}

// 设备凭证 cookie:官方登录页浏览器天生携带 buvid3/buvid4/buvid_fp/b_nut/bili_ticket,
// 扫码 key 与生成者设备信任度绑定——匿名裸请求生成的 key 手机扫码报"不支持该链接"。
// buvid 来自 finger/spi;bili_ticket = HMAC-SHA256(key='XgwSnGZ1p', msg='ts'+时间戳) 换
// GenWebTicket(社区 bilibili-API-collect #903 算法);全部取一次缓存,失败回落匿名。
let deviceCookieCache: string | null = null

async function deviceCookie(): Promise<string> {
  if (deviceCookieCache !== null) return deviceCookieCache
  if (!inTauri) return '' // 浏览器预览:无 Tauri 运行时,invoke 不可用
  try {
    const ts = Math.floor(Date.now() / 1000)
    const parts: string[] = []
    const spi = await invoke<BiliHttpResponse>('bili_http_request', {
      url: 'https://api.bilibili.com/x/frontend/finger/spi',
      method: 'GET',
    }).catch(() => null)
    const b =
      spi && spi.status === 200
        ? ((JSON.parse(spi.body) as { data?: { b_3?: string; b_4?: string } })?.data ?? {})
        : {}
    if (b?.b_3 && b?.b_4) {
      parts.push(`buvid3=${b.b_3}`, `buvid4=${b.b_4}`, `b_nut=${ts}`)
      // buvid_fp:设备指纹摘要(32 位十六进制,格式与官方一致;取 UA 摘要,自洽即可)
      const fp = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(UA))
      parts.push(`buvid_fp=${[...new Uint8Array(fp)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32)}`)
    }
    // bili_ticket:hmac_sha256 后按 query 参数换 JWT(3 天有效)
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('XgwSnGZ1p'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const hexsign = await crypto.subtle
      .sign('HMAC', hmacKey, new TextEncoder().encode(`ts${ts}`))
      .then((sig) => [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join(''))
    const ticket = await invoke<BiliHttpResponse>('bili_http_request', {
      url: `https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?key_id=ec02&hexsign=${hexsign}&context[ts]=${ts}&csrf=`,
      method: 'POST',
      referer: 'https://www.bilibili.com/',
    })
      .then((resp) =>
        resp.status === 200
          ? ((JSON.parse(resp.body) as { data?: { ticket?: string } })?.data?.ticket ?? '')
          : '',
      )
      .catch(() => '')
    if (ticket) parts.push(`bili_ticket=${ticket}`, `bili_ticket_expires=${ts + 259_200}`)
    deviceCookieCache = parts.join('; ')
  } catch (e) {
    console.warn('[live] 设备凭证获取失败,回落匿名扫码', e)
  }
  return deviceCookieCache ?? ''
}

interface BiliEnvelope<T> {
  code: number
  message?: string
  data?: T
}

interface QrGenerateData {
  url: string
  qrcode_key: string
}

interface QrPollData {
  code: number
  message?: string
  url?: string
}

async function getJsonFull<T>(path: string): Promise<{ data: T; setCookie: string[] }> {
  const url = `${PASSPORT}${path}`
  const cookie = await deviceCookie()
  // Tauri 内走自有 Rust 命令:插件会剥离 Cookie/Referer 禁止头(设备凭证根本发不出去),
  // Rust 侧全量透传请求头并回传响应 Set-Cookie;浏览器 dev 直连
  let status: number
  let body: string
  let setCookie: string[]
  if (inTauri) {
    const parsed = await invoke<BiliHttpResponse>('bili_http_request', {
      url,
      method: 'GET',
      cookie,
      referer: 'https://www.bilibili.com/',
    })
    status = parsed.status
    body = parsed.body
    setCookie = parsed.set_cookie ?? []
  } else {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15_000),
    })
    status = res.status
    body = await res.text()
    const h = res.headers
    setCookie =
      typeof (h as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (h as { getSetCookie: () => string[] }).getSetCookie().filter(Boolean)
        : [h.get('set-cookie') ?? ''].filter(Boolean)
  }
  if (status !== 200) throw new Error(`HTTP ${status}`)
  const envelope = JSON.parse(body) as BiliEnvelope<T>
  if (envelope.code !== 0 || !envelope.data) throw new Error(envelope.message || `code ${envelope.code}`)
  return { data: envelope.data, setCookie }
}

async function getJson<T>(path: string): Promise<T> {
  return (await getJsonFull<T>(path)).data
}

/** 从 Set-Cookie 行提取登录三件套(DedeUserID/SESSDATA/bili_jct)。纯函数,node --test 直测。
 *  兼容插件把多条 Set-Cookie 合并成一行的形态:按「逗号+名=」切分
 *  (SESSDATA 值内的逗号后面不紧跟 名=,不会被误切) */
export function cookieFromSetCookie(lines: string[]): { cookie: string; uid: number } | null {
  let sess = ''
  let dede = ''
  let jct = ''
  const flat = lines.flatMap((line) => line.split(/,\s*(?=[A-Za-z0-9_]+=)/))
  for (const line of flat) {
    const kv = line.trim().split(';')[0]
    const eq = kv.indexOf('=')
    if (eq <= 0) continue
    const name = kv.slice(0, eq)
    const value = kv.slice(eq + 1)
    if (name === 'SESSDATA') sess = value
    else if (name === 'DedeUserID') dede = value
    else if (name === 'bili_jct') jct = value
  }
  if (!sess || !dede) return null
  const cookie = `DedeUserID=${dede}; SESSDATA=${sess}` + (jct ? `; bili_jct=${jct}` : '')
  return { cookie, uid: Number(dede) }
}

/** 启动一轮扫码登录(生成二维码→轮询→成功回调)。cancel 后所有回调静默,可重复开新会话 */
export function startQrLogin(hooks: QrLoginHooks): QrLoginHandle {
  let cancelled = false
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      window.setTimeout(r, ms)
    })

  async function run(round: number): Promise<void> {
    let key = ''
    try {
      // from 值必须与请求的 source 一致,且手机B站App按 from 路由扫码流程:
      // main_web(登录页流程)的码手B扫码报"不支持该链接",main-fe-header(主站页头流程)可正常确认
      const d = await getJson<QrGenerateData>('/x/passport-login/web/qrcode/generate?source=main-fe-header&go_url=')
      if (!d.url || !d.qrcode_key) throw new Error('B站二维码响应缺少 url 或 qrcode_key')
      key = d.qrcode_key
      // 二维码内容 = 接口返回的 url 原样(官方登录页同样直接画 data.url,不做转换)
      if (!cancelled) hooks.onQr(round, d.url)
    } catch (e) {
      if (!cancelled) hooks.onPhase('error', `二维码生成失败:${(e as Error).message ?? e}`)
      return
    }
    const deadline = Date.now() + QR_TTL_MS
    const expired = () => {
      if (round + 1 >= MAX_ROUNDS) {
        if (!cancelled) hooks.onPhase('error', '二维码多次过期已停止,请重新点击扫码登录')
        return true
      }
      if (!cancelled) hooks.onPhase('expired', '二维码过期,自动刷新中…')
      void run(round + 1)
      return true
    }
    for (;;) {
      await sleep(POLL_MS)
      if (cancelled) return
      if (Date.now() > deadline && expired()) return
      try {
        const { data: d, setCookie } = await getJsonFull<QrPollData>(
          `/x/passport-login/web/qrcode/poll?qrcode_key=${key}&source=main-fe-header`,
        )
        const code = Number(d.code)
        if (code === 0) {
          // 双路解析:优先 Set-Cookie(权威),退化到 crossDomain 链接参数;都失败带原始数据便于定位
          const r = cookieFromSetCookie(setCookie) ?? cookieFromCrossUrl(d.url ?? '')
          if (cancelled) return
          if (r) {
            hooks.onPhase('ok', `登录成功(UID ${r.uid}),Cookie 已回填`)
            hooks.onSuccess(r)
          } else {
            hooks.onPhase(
              'error',
              `登录成功但拿不到 Cookie(set-cookie ${setCookie.length} 条,url=${String(d.url ?? '').slice(0, 60) || '空'})`,
            )
          }
          return
        }
        if (code === 86090 && !cancelled) hooks.onPhase('scanned', '已扫码,请在手机上确认')
        else if (code === 86038 && expired()) return
        // 86101 未扫码:静默继续轮询
      } catch {
        // 单次轮询失败(网络抖动)忽略,下一轮再试
      }
    }
  }

  void run(0)
  return {
    cancel() {
      cancelled = true
    },
  }
}
