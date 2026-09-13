// 主播模式管线:弹幕消息 → 过滤/限流 → AI 决策 → 单句回复回调。
// 为什么不是 player 剧本:弹幕回复是事件驱动的单句流,走气泡+TTS 的轻量路径
// (App 侧复用聊天通道的呈现节奏);点播演出(全部模式)走剧本队列,两者互斥由
// runtimeMode('streaming' 独占)保证。
// 弹幕源来自 src/live 的 Provider 注册表,本模块对平台无感知。
// AI 通道分档:API 档(默认)快速单条;网页模型档(cfg.webchatEnabled)攒批慢速——
// 一次网页调用回多条弹幕,过期容忍/最小间隔/频控同步放宽(paceFor)。

import { providerFor } from '../live'
import type { DanmakuMessage, LiveEvent, LivePlatform, LiveStatus } from '../live'
import { generateLiveReply, generateLiveReplyBatch } from '../engine/llmClient'
import { getConfig } from '../storage/configStore'
import { noteActivity } from './proactiveScheduler'
import { showProp } from './propEffects'
import { createGiftReactions, type GiftReactions } from './giftReactions'
import { diag } from '../diag/store'
import type { Speaker } from '../performer/dialogSchema'

export interface LiveReply {
  speaker: Speaker
  text: string
  action: string
  /** 该条回复对应的弹幕作者(供气泡/称呼用) */
  username: string
}

export interface LiveSessionHooks {
  onReply: (r: LiveReply) => void
  onStatus: (s: LiveStatus) => void
}

// ---------- 限流参数(调参都在这里) ----------
const INBOX_CAP = 24 // 队列上限,满丢最旧(弹幕是即时性的,旧了没回的价值)
const DEDUP_MS = 30_000 // 同用户同内容 30s 内只进一次
const PUMP_MS = 800 // 泵轮询间隔

export interface LivePace {
  /** 出队时已过期的弹幕直接丢 */
  staleMs: number
  /** 两次回复最小间隔(≥气泡呈现节奏,防嘴快过脑) */
  minGapMs: number
  /** AI 调用令牌桶:免费/低价档也别打爆 */
  callsPerMin: number
  /** 积压时一次喂给 AI 的弹幕数 */
  batchSize: number
}

/** API 档(快速单条)/ 网页档(慢速攒批:一次网页调用几十秒,回多条摊薄延迟) */
export function paceFor(webchat: boolean): LivePace {
  return webchat
    ? { staleMs: 90_000, minGapMs: 30_000, callsPerMin: 2, batchSize: 5 }
    : { staleMs: 15_000, minGapMs: 2_000, callsPerMin: 8, batchSize: 5 }
}

interface Session {
  roomId: string
  platform: LivePlatform
  inbox: DanmakuMessage[]
  seen: Map<string, number>
  banTopics: string[]
  recentReplies: string[]
  callTimes: number[]
  busy: boolean
  lastReplyAt: number
  pumpTimer: number | null
  /** 无 API Key 且未开网页模型时弹幕 AI 回复静默禁用;礼物旁路不依赖 Key 照常工作 */
  hasApiKey: boolean
  /** 网页模型档(开播快照):攒批慢速回复,不需要 API Key */
  webchat: boolean
  /** 礼物互动开关(道具动效与感谢语,一个开关管两者);开播时快照,与 banTopics 同策略 */
  giftReactionsEnabled: boolean
  /** 礼物旁路:档位道具 + 模板感谢语(revision 门与 AI 回复共享) */
  reactions: GiftReactions
  onReply: (r: LiveReply) => void
  onStatus: (s: LiveStatus) => void
}

let session: Session | null = null

function parseBanTopics(raw: string): string[] {
  return raw
    .split(/[,，、\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** 过滤:空/超长/30s 去重/命中雷区。通过 = true */
function passesFilter(s: Session, m: DanmakuMessage): boolean {
  const text = m.content.trim()
  if (!text || text.length > 60) return false
  const dedupKey = `${m.userId || m.username}|${text}`
  const last = s.seen.get(dedupKey)
  if (last && Date.now() - last < DEDUP_MS) return false
  s.seen.set(dedupKey, Date.now())
  if (s.banTopics.some((t) => text.includes(t))) return false
  return true
}

/** 弹幕进入:过滤 + 入队(满丢最旧)+ 抑制久坐提醒(有观众互动就算活跃) */
function handleDanmaku(s: Session, m: DanmakuMessage): void {
  if (!passesFilter(s, m)) return
  noteActivity()
  s.inbox.push(m)
  if (s.inbox.length > INBOX_CAP) s.inbox.shift()
}

/** 事件分流:普通弹幕走过滤+AI 管线;礼物走免 AI 旁路。
 *  礼物的活动记账在开关判断之前(关闭动效,礼物仍是观众活动,照样抑制久坐提醒)。
 *  导出供单测直接驱动(构造假 session) */
export function handleLiveEvent(s: Session, ev: LiveEvent): void {
  if (ev.kind === 'gift') {
    noteActivity()
    s.reactions.onGift(ev)
    return
  }
  handleDanmaku(s, ev)
}

/** 每 800ms 泵一次:凑齐节奏条件就攒批发给 AI 决策。
 *  网页档:generateLiveReplyBatch 一次回多条,逐条呈现(间隔 3.5s,busy 持有防礼物
 *  感谢插队顶气泡);网页失败回退 API 单条版,API 也失败才丢批(网络/超时/解析静默) */
async function pump(s: Session): Promise<void> {
  if (s.busy || s.inbox.length === 0) return
  if (!s.hasApiKey && !s.webchat) return // 无 Key 且无网页模型:弹幕 AI 回复静默禁用(礼物旁路不依赖)
  const pace = paceFor(s.webchat)
  const now = Date.now()
  if (now - s.lastReplyAt < pace.minGapMs) return
  // 令牌桶:60s 窗口内的调用次数封顶
  s.callTimes = s.callTimes.filter((t) => now - t < 60_000)
  if (s.callTimes.length >= pace.callsPerMin) return
  // 出队:过期丢弃,最多取一批
  const batch: DanmakuMessage[] = []
  while (s.inbox.length > 0 && batch.length < pace.batchSize) {
    const m = s.inbox.shift()!
    if (now - m.timestamp <= pace.staleMs) batch.push(m)
  }
  if (batch.length === 0) return
  s.busy = true
  s.callTimes.push(now)
  // 在途仲裁:请求前记录版本,期间礼物感谢插队呈现(revision 变化)则本批结果作废
  const revision = s.reactions.gate.capture()
  // 诊断:每批一次 AI 决策 = 一个弹幕会话(输入是批内弹幕拼接的结构信息)
  const batchId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const batchT0 = Date.now()
  const briefs = batch.map((d) => ({ username: d.username, content: d.content }))
  diag.beginTurn({ id: batchId, source: 'danmaku', text: briefs.map((b) => b.content).join(' '), ts: batchT0 })
  const finishBatch = (outcome: 'spoke' | 'silent' | 'failed'): void => {
    diag.turnFinished(batchId, {
      outcome,
      totalMs: Date.now() - batchT0,
      replyChars: 0,
      replySentences: 0,
    })
    diag.finish(batchId)
  }
  try {
    let replies: { pick: number; reply: string; speaker: Speaker; action: string }[]
    try {
      if (s.webchat) {
        replies = await generateLiveReplyBatch(briefs, s.recentReplies, undefined, batchId)
      } else {
        const r = await generateLiveReply(briefs, s.recentReplies, undefined, batchId)
        replies = r.reply ? [r] : []
      }
    } catch (webchatErr) {
      // 网页档失败回退 API 单条版;没 Key 则无从回退,按丢批处理(与现有 catch 语义一致)
      if (!s.hasApiKey) throw webchatErr
      console.warn('[live] 网页攒批回复失败,本次回退 API 单条', webchatErr)
      diag.fallback(batchId, {
        call: 'liveBatch',
        from: 'webchat',
        reason: `网页攒批失败 → API 单条:${String((webchatErr as Error)?.message ?? webchatErr).slice(0, 100)}`,
      })
      const r = await generateLiveReply(briefs, s.recentReplies, undefined, batchId)
      replies = r.reply ? [r] : []
    }
    // 等待期间已下播 → 丢弃;礼物感谢已插队 → 丢弃(否则会顶掉刚上的感谢气泡)
    if (session !== s) return
    if (!s.reactions.gate.valid(revision)) return
    // 逐条呈现:间隔 3.5s 让气泡读完(busy 持有,期间不取新批;下播/插队即止)
    for (const r of replies) {
      if (session !== s) return
      if (!s.reactions.gate.valid(revision)) return
      s.recentReplies = [...s.recentReplies, r.reply].slice(-5)
      s.lastReplyAt = Date.now()
      const picked = r.pick >= 0 ? batch[r.pick] : undefined
      s.onReply({ speaker: r.speaker, text: r.reply, action: r.action, username: picked?.username ?? '' })
      if (r !== replies[replies.length - 1]) await new Promise((res) => setTimeout(res, 3_500))
    }
    // replies 为空 = AI 判定这批都不值得回,静默丢批
    finishBatch(replies.length > 0 ? 'spoke' : 'silent')
  } catch (e) {
    // 单批失败不致命(网络/超时/解析),静默丢批等下一批;控制台留痕排障
    console.warn('[live] 弹幕决策失败(丢批)', e)
    finishBatch('failed')
  } finally {
    s.busy = false
  }
}

/** 开播:连接 provider + 启动泵。重复调用 = 先停旧会话再开新的 */
export async function startLiveSession(
  platform: LivePlatform,
  roomId: string,
  hooks: LiveSessionHooks,
): Promise<void> {
  stopLiveSession()
  const cfg = await getConfig()
  const s: Session = {
    roomId,
    platform,
    inbox: [],
    seen: new Map(),
    banTopics: parseBanTopics(cfg.userProfile.banTopics),
    recentReplies: [],
    callTimes: [],
    busy: false,
    lastReplyAt: 0,
    pumpTimer: null,
    hasApiKey: Boolean(cfg.apiKey.trim()),
    webchat: cfg.webchatEnabled === true,
    giftReactionsEnabled: cfg.live.giftReactionsEnabled !== false,
    reactions: null!,
    onReply: hooks.onReply,
    onStatus: hooks.onStatus,
  }
  s.reactions = createGiftReactions({
    showProp,
    isEnabled: () => s.giftReactionsEnabled,
    // 感谢语也走统一呈现口;同时推进共享节流,让 AI 泵顺延,两套呈现不打架
    present: (r) => {
      s.lastReplyAt = Date.now()
      s.onReply(r)
    },
  })
  session = s
  // 定期清理去重表,防长播内存缓涨
  window.setInterval(() => {
    const now = Date.now()
    for (const [k, t] of s.seen) if (now - t > DEDUP_MS) s.seen.delete(k)
  }, 60_000)
  s.pumpTimer = window.setInterval(() => void pump(s), PUMP_MS)
  // cookie 选填:带登录态才能拿未打码的观众名(接口第 4 参 = 平台凭证位)
  providerFor(platform).connect(roomId, (ev) => handleLiveEvent(s, ev), hooks.onStatus, cfg.live.cookie || undefined)
}

/** 下播:断开连接、停泵、清会话;幂等 */
export function stopLiveSession(): void {
  const s = session
  session = null
  if (!s) return
  if (s.pumpTimer !== null) window.clearInterval(s.pumpTimer)
  providerFor(s.platform).disconnect()
}
