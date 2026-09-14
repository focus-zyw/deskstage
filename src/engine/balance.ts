// LLM 供应商余额查询 + 当日消费差值记账(右键角色「查询余额」互动的引擎侧)。
// 支持 DeepSeek(GET {origin}/user/balance)与 Kimi/Moonshot(GET {baseUrl}/users/me/balance)
// 两家公开余额接口;Tauri 内走 plugin-http(IPC 出站,不受 CSP 限),浏览器预览回退原生 fetch。
// 今日已用按"当日基准余额 − 当前余额"差值记账(参考 DeepSeek-Balance-Whale-Widget 的
// 余额差口径):日期翻转或检测到充值(余额高于基准)时重置基准——宁可不报,不报错数。
// 纪律:密钥只进请求头,不进日志、不进 localStorage;记账数据只存余额数字。

import { inTauri } from '../storage/configStore'

export type BalanceVendorId = 'deepseek' | 'moonshot'

export interface BalanceInfo {
  vendorId: BalanceVendorId
  isAvailable: boolean
  currency: string
  /** 会随消费递减的口径:DeepSeek=total_balance,Kimi=available_balance */
  total: number
  granted: number
  toppedUp: number
}

/** 按 baseUrl 识别支持余额查询的供应商;识别不出(自定义端点等)返回 null */
export function balanceVendorOf(baseUrl: string): BalanceVendorId | null {
  let host = ''
  try {
    host = new URL(baseUrl).host
  } catch {
    return null
  }
  if (host === 'api.deepseek.com') return 'deepseek'
  if (host === 'api.moonshot.cn') return 'moonshot'
  return null
}

/** 余额接口地址:DeepSeek 在域根(不在 /v1 下),Kimi 在 /v1 之下 */
export function balanceEndpoint(baseUrl: string, vendor: BalanceVendorId): string {
  if (vendor === 'deepseek') {
    const u = new URL(baseUrl)
    return `${u.origin}/user/balance`
  }
  return `${baseUrl.replace(/\/+$/, '')}/users/me/balance`
}

const toNum = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const rawHead = (raw: string): string =>
  raw ? `:${raw.replace(/\s+/g, ' ').slice(0, 80)}` : ''

/** 响应解析(纯函数,导出供测试):字段缺失/无法解析时抛带响应摘要的可读错误。
 *  供应商字段命名有差异,做宽容提取(Kimi 依次试 available_balance/total_balance/balance) */
export function parseBalanceResponse(vendor: BalanceVendorId, json: unknown, raw = ''): BalanceInfo {
  const head = rawHead(raw)
  const o = (json ?? {}) as Record<string, unknown>
  if (vendor === 'deepseek') {
    const list = o.balance_information as unknown
    if (!Array.isArray(list)) {
      // 网关/风控层可能返回带中文 message 的 JSON(如限流、地区限制),原样透传比"结构异常"有用
      const msg =
        typeof o.message === 'string' && o.message
          ? o.message
          : typeof (o.error as Record<string, unknown> | undefined)?.message === 'string'
            ? ((o.error as Record<string, unknown>).message as string)
            : ''
      throw new Error(msg ? `供应商返回:${msg}` : `接口结构异常${head}`)
    }
    if (list.length === 0) throw new Error('账户暂无余额明细(可能还未产生计费)')
    const b = (list[0] ?? {}) as Record<string, unknown>
    const total = Number(b.total_balance)
    if (!Number.isFinite(total)) throw new Error(`接口结构异常${head}`)
    return {
      vendorId: vendor,
      isAvailable: o.is_available !== false,
      currency: typeof b.currency === 'string' && b.currency ? b.currency : 'CNY',
      total,
      granted: toNum(b.granted_balance),
      toppedUp: toNum(b.topped_up_balance),
    }
  }
  const d = (o.data ?? {}) as Record<string, unknown>
  const total = Number(d.available_balance ?? d.total_balance ?? d.balance)
  if (!Number.isFinite(total)) {
    const msg = typeof o.message === 'string' && o.message ? `供应商返回:${o.message}` : `接口结构异常${head}`
    throw new Error(msg)
  }
  return {
    vendorId: 'moonshot',
    isAvailable: true,
    currency: typeof d.currency === 'string' && d.currency ? d.currency : 'CNY',
    total,
    granted: toNum(d.granted_balance),
    toppedUp: toNum(d.topped_up_balance),
  }
}

async function platformFetch(deps?: { fetchImpl?: typeof fetch }): Promise<typeof fetch> {
  if (deps?.fetchImpl) return deps.fetchImpl
  if (inTauri) {
    const mod = await import('@tauri-apps/plugin-http')
    return mod.fetch as unknown as typeof fetch
  }
  return fetch.bind(globalThis)
}

/** 查询当前供应商余额;网络/鉴权/解析失败都以 Error 抛出,由调用方转成角色台词 */
export async function queryVendorBalance(
  baseUrl: string,
  apiKey: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<BalanceInfo> {
  const vendor = balanceVendorOf(baseUrl)
  if (!vendor) throw new Error('当前供应商未提供公开的余额接口')
  if (!apiKey.trim()) throw new Error('未配置 API Key')
  const url = balanceEndpoint(baseUrl, vendor)
  const doFetch = await platformFetch(deps)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: ctrl.signal,
    })
    if (res.status === 401 || res.status === 403) throw new Error('鉴权失败,检查 API Key 是否正确')
    if (!res.ok) throw new Error(`接口返回 ${res.status}`)
    // 先取文本再解析:解析失败时错误信息能带上响应原文摘要,便于诊断结构差异
    const raw = await res.text()
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      // 网页形态 = DNS/代理劫持或网络异常,单独提示比原文摘要更有用
      throw new Error(
        raw.trimStart().startsWith('<')
          ? '网络返回了网页而不是接口数据(检查代理/加速器/DNS)'
          : `接口返回非 JSON${rawHead(raw)}`,
      )
    }
    return parseBalanceResponse(vendor, json, raw)
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('查询超时(10s)')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 当日消费差值记账 ----------

const TRACK_KEY = 'vc-balance-track'

export interface BalanceTrack {
  /** 记账归属日(本地时区 Y-M-D);日期翻转即重置基准 */
  date: string
  /** 当日基准余额(当日首次查询记入) */
  baseline: number | null
  last: number | null
  lastTs: number
}

export function emptyBalanceTrack(): BalanceTrack {
  return { date: '', baseline: null, last: null, lastTs: 0 }
}

export function loadBalanceTrack(): BalanceTrack {
  try {
    const raw = localStorage.getItem(TRACK_KEY)
    if (raw) return { ...emptyBalanceTrack(), ...(JSON.parse(raw) as Partial<BalanceTrack>) }
  } catch {
    // 记账损坏不致命:回空账本,下次查询重建基准
  }
  return emptyBalanceTrack()
}

export function saveBalanceTrack(track: BalanceTrack): void {
  try {
    localStorage.setItem(TRACK_KEY, JSON.stringify(track))
  } catch {
    // 存储不可用(隐私模式等):记账退化为会话内,不影响查询
  }
}

export type BalanceTrackNote = 'ok' | 'no-baseline' | 'topup'

export interface BalanceTrackUpdate {
  /** 当日已消费;no-baseline/topup 时为 null(基准刚建立,无从作差) */
  todayUsage: number | null
  note: BalanceTrackNote
  track: BalanceTrack
}

const dayOf = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 差值记账(纯函数):usage = 当日基准 − 当前;日期翻转/首次查询记基准;
 *  total 高于基准(充值/赠送到账)时旧差值失真,重置基准并标注 topup */
export function updateBalanceTrack(prev: BalanceTrack, info: { total: number }, now = Date.now()): BalanceTrackUpdate {
  const date = dayOf(now)
  let baseline = prev.date === date ? prev.baseline : null
  let note: BalanceTrackNote = 'ok'
  let todayUsage: number | null = null
  if (baseline === null) {
    baseline = info.total
    note = 'no-baseline'
  } else if (info.total > baseline) {
    baseline = info.total
    note = 'topup'
  } else {
    todayUsage = Math.round((baseline - info.total) * 100) / 100
  }
  return { todayUsage, note, track: { date, baseline, last: info.total, lastTs: now } }
}

/** 结果台词(纯函数,导出供测试):角色口吻的一句话;usage 缺失时给下一步指引 */
export function formatBalanceLine(info: BalanceInfo, usage: number | null, note: BalanceTrackNote): string {
  const money = `${info.currency} ${info.total}`
  if (note === 'topup') return `查到啦~余额 ${money},检测到充值到账,今天的账从头记啦`
  if (usage === null) return `查到啦~余额 ${money},下次再查就能算出今天用了多少啦`
  return `查到啦~余额 ${money},今天用了 ${usage}`
}

// ---------- 结果缓存(60s 节流,防手抖连点打接口;重启后自然失效,重新查一次无妨) ----------

let cache: { line: string; info: BalanceInfo; ts: number } | null = null

export function rememberBalance(info: BalanceInfo, line: string, now = Date.now()): void {
  cache = { info, line, ts: now }
}

/** 60s 内查过 → 返回缓存的台词;否则 null(需要真的发请求) */
export function cachedBalanceLine(now = Date.now(), maxAgeMs = 60_000): string | null {
  return cache && now - cache.ts < maxAgeMs ? cache.line : null
}
