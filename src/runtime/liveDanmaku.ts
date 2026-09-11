// 主播模式管线:弹幕消息 → 过滤/限流 → AI 决策 → 单句回复回调。
// 为什么不是 player 剧本:弹幕回复是事件驱动的单句流,走气泡+TTS 的轻量路径
// (App 侧复用聊天通道的呈现节奏);点播演出(相声/日常)仍走剧本队列,两者互斥由
// runtimeMode('streaming' 独占)保证。
// 弹幕源来自 src/live 的 Provider 注册表,本模块对平台无感知。

import { providerFor } from '../live'
import type { DanmakuMessage, LiveEvent, LivePlatform, LiveStatus } from '../live'
import { generateLiveReply } from '../engine/llmClient'
import { getConfig } from '../storage/configStore'
import { noteActivity } from './proactiveScheduler'
import { showProp } from './propEffects'
import { createGiftReactions, type GiftReactions } from './giftReactions'
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
const STALE_MS = 15_000 // 出队时已过期的弹幕直接丢
const MIN_GAP_MS = 2_000 // 两次回复最小间隔(≥气泡呈现节奏,防嘴快过脑)
const CALLS_PER_MIN = 8 // AI 调用令牌桶:免费/低价档也别打爆
const BATCH_SIZE = 5 // 积压时一次喂给 AI 的弹幕数,AI 只挑一条回
const PUMP_MS = 800 // 泵轮询间隔

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
  /** 无 API Key 时弹幕 AI 回复静默禁用;礼物旁路不依赖 Key 照常工作 */
  hasApiKey: boolean
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

/** 每 800ms 泵一次:凑齐节奏条件就攒批发给 AI 决策 */
async function pump(s: Session): Promise<void> {
  if (s.busy || s.inbox.length === 0) return
  if (!s.hasApiKey) return // 无 Key:弹幕 AI 回复静默禁用(不报错不刷屏;礼物旁路不依赖 Key)
  const now = Date.now()
  if (now - s.lastReplyAt < MIN_GAP_MS) return
  // 令牌桶:60s 窗口内的调用次数封顶
  s.callTimes = s.callTimes.filter((t) => now - t < 60_000)
  if (s.callTimes.length >= CALLS_PER_MIN) return
  // 出队:过期丢弃,最多取一批
  const batch: DanmakuMessage[] = []
  while (s.inbox.length > 0 && batch.length < BATCH_SIZE) {
    const m = s.inbox.shift()!
    if (now - m.timestamp <= STALE_MS) batch.push(m)
  }
  if (batch.length === 0) return
  s.busy = true
  s.callTimes.push(now)
  // 在途仲裁:请求前记录版本,期间礼物感谢插队呈现(revision 变化)则本批结果作废
  const revision = s.reactions.gate.capture()
  try {
    const r = await generateLiveReply(
      batch.map((d) => ({ username: d.username, content: d.content })),
      s.recentReplies,
    )
    // 等待期间已下播 → 丢弃;礼物感谢已插队 → 丢弃(否则会顶掉刚上的感谢气泡)
    if (session !== s) return
    if (!s.reactions.gate.valid(revision)) return
    if (r.reply) {
      s.recentReplies = [...s.recentReplies, r.reply].slice(-5)
      s.lastReplyAt = Date.now()
      const picked = r.pick >= 0 ? batch[r.pick] : undefined
      s.onReply({ speaker: r.speaker, text: r.reply, action: r.action, username: picked?.username ?? '' })
    }
    // reply 为空 = AI 判定这批都不值得回,静默丢批
  } catch (e) {
    // 单批失败不致命(网络/超时/解析),静默丢批等下一批;控制台留痕排障
    console.warn('[live] 弹幕决策失败(丢批)', e)
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
