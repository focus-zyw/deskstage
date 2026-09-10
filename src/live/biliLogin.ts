// B站扫码登录:设置面板出二维码 → 手机B站App扫一扫确认 → 轮询拿到登录 cookie 回填。
// 接口(passport.bilibili.com,无验证码,B站网页版自家在用):
//   generate → { url(二维码内容), qrcode_key }
//   poll     → data.code: 86101 未扫码 | 86090 已扫未确认 | 86038 已失效 | 0 成功
//   成功时 data.url 是 crossDomain 跳转链接,查询参数里带全套登录 cookie
//   (DedeUserID/SESSDATA/bili_jct)——浏览器读不到 Set-Cookie,解析该链接是社区通行做法。
import { fetch as rustFetch } from '@tauri-apps/plugin-http'
import { inTauri } from '../storage/configStore'

const PASSPORT = 'https://passport.bilibili.com'
const POLL_MS = 1500
/** 二维码有效期约 180s;过期自动重生成,最多 3 轮 */
const QR_TTL_MS = 185_000
const MAX_ROUNDS = 3
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export type QrPhase = 'waiting' | 'scanned' | 'ok' | 'expired' | 'error'

export interface QrLoginHooks {
  /** 二维码内容(url),UI 负责渲染成图 */
  onQr: (url: string) => void
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

async function getJson(path: string): Promise<Record<string, unknown>> {
  const f = inTauri ? rustFetch : fetch
  let res: Response
  try {
    res = await f(`${PASSPORT}${path}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    })
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    // scope 拒绝 = 运行中的 app 是加白名单前启动的旧实例
    if (/not allowed on the configured scope/i.test(msg))
      throw new Error('接口未授权,请完全退出应用后重新打开(旧实例缺少新白名单)')
    if (!inTauri) throw new Error('浏览器预览不支持扫码,请在本应用窗口内使用')
    throw new Error(msg)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { code?: number; message?: string; data?: Record<string, unknown> }
  if (json.code !== 0 || !json.data) throw new Error(json.message || `code ${json.code}`)
  return json.data
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
      const d = await getJson('/x/passport-login/web/qrcode/generate')
      key = String(d.qrcode_key)
      if (!cancelled) hooks.onQr(String(d.url))
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
        const d = await getJson(`/x/passport-login/web/qrcode/poll?qrcode_key=${key}`)
        const code = Number(d.code)
        if (code === 0) {
          const r = cookieFromCrossUrl(String(d.url ?? ''))
          if (cancelled) return
          if (r) {
            hooks.onPhase('ok', `登录成功(UID ${r.uid}),Cookie 已回填`)
            hooks.onSuccess(r)
          } else {
            hooks.onPhase('error', '登录成功但解析 Cookie 失败,请改用手动粘贴')
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
