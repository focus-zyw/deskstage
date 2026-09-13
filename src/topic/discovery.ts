// AI 后台候选发现:当候选仓可用卡不足时,后台调用一次 LLM 批量生成候选,
// 经本地清洗(sanitizer)后入仓。铁律:
//  · 只在后台跑——点播关键路径永不等待本模块;失败一律静默(记尝试时间,退避)
//  · feature flag:cfg.topicPrefs.aiDiscover 默认关(涉模型调用费用),且要求已配 API Key
//  · 调度纪律:单飞(同时最多 1 个);冷却 = 距上次尝试 6 小时 或 已消费 5 张;
//    每日最多 4 次尝试;一次生成 6 张;TTL 14 天;池上限 40
//  · 隐私:输入只有类别级语境(见 prompt.ts),原始屏幕/窗口标题/剪贴板不进入
import { complete, type CompletionOptions } from '../engine/llmGateway'
import { envForegroundCategory } from '../engine/envAware'
import { getConfig } from '../storage/configStore'
import { getTopicState, mutateTopicState, MAX_RESERVOIR } from './store'
import { parseBanWords, sanitizeGeneratedCard, timeBucketOf } from './planner'
import { buildDiscoveryMessages, parseDiscoveryCards } from './prompt'
import type { DiscoveryInput } from './prompt'
import type { TopicCard } from './types'

export const DISCOVERY_POLICY = {
  /** 池中可用卡低于该值才触发补货 */
  MIN_POOL: 8,
  /** 距上次尝试的冷却 */
  COOLDOWN_MS: 6 * 60 * 60 * 1000,
  /** 消费计数触发的补货阈值 */
  CONSUMED_TRIGGER: 5,
  /** 每日最多尝试次数 */
  DAILY_LIMIT: 4,
  /** 一次生成的候选数上限 */
  BATCH: 6,
  /** 候选 TTL(入库时写 expiresAt,读取侧按需过滤) */
  TTL_MS: 14 * 24 * 60 * 60 * 1000,
  /** 单次请求超时 */
  TIMEOUT_MS: 30_000,
} as const

export interface DiscoveryDeps {
  complete: (options: CompletionOptions) => Promise<string>
  getConfig: () => Promise<{
    apiKey: string
    envSense: boolean
    userProfile: { banTopics: string; likes: string }
    topicPrefs: { aiDiscover: boolean; distance: 'near' | 'medium' | 'far' }
  }>
  envCategory: () => string | null
  now: () => number
}

const defaultDeps: DiscoveryDeps = {
  complete,
  getConfig,
  envCategory: () => envForegroundCategory(),
  now: () => Date.now(),
}

let inFlight = false
let abortCtrl: AbortController | null = null

/** 应用退出时中止在途请求(不入账的尝试下次启动重新计) */
export function cancelDiscovery(): void {
  abortCtrl?.abort()
}

/** 本地时区日戳(YYYY-MM-DD);日限计数与"今天"的归属依据 */
export function localDay(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 补货闸门:开关/Key/池量/冷却/日限全过才真正发起;返回是否发起了请求 */
export async function maybeRestockTopicCandidates(
  deps: Partial<DiscoveryDeps> = {},
): Promise<boolean> {
  if (inFlight) return false
  const d: DiscoveryDeps = { ...defaultDeps, ...deps }
  const now = d.now()
  const cfg = await d.getConfig()
  // feature flag:默认关,显式开启且配置了 API Key 才工作(网页模型不参与后台 JSON 生成)
  if (!cfg.topicPrefs.aiDiscover || !cfg.apiKey.trim()) return false
  const state = await getTopicState()
  const usable = state.reservoir.filter((c) => !c.expiresAt || c.expiresAt > now).length
  if (usable >= DISCOVERY_POLICY.MIN_POOL) return false
  const cooled =
    now - state.discovery.lastAttemptAt > DISCOVERY_POLICY.COOLDOWN_MS ||
    state.discovery.consumedSinceRestock >= DISCOVERY_POLICY.CONSUMED_TRIGGER
  if (!cooled) return false
  const usedToday =
    state.discovery.attemptDay === localDay(now) ? state.discovery.attemptCount : 0
  if (usedToday >= DISCOVERY_POLICY.DAILY_LIMIT) return false
  return restock(d)
}

async function restock(deps: DiscoveryDeps): Promise<boolean> {
  inFlight = true
  abortCtrl = new AbortController()
  const now = deps.now()
  let accepted = 0
  try {
    const cfg = await deps.getConfig()
    const state = await getTopicState()
    const input: DiscoveryInput = {
      interests: cfg.userProfile.likes
        .split(/[,，、;；\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      recentTopics: state.recent.slice(-20).map((r) => ({ title: r.title })),
      timeBucket: timeBucketOf(now),
      envCategory: cfg.envSense ? deps.envCategory() : null,
      banText: cfg.userProfile.banTopics,
      distance: cfg.topicPrefs.distance,
    }
    const raw = await deps.complete({
      messages: buildDiscoveryMessages(input),
      temperature: 0.9,
      maxTokens: 2000,
      jsonMode: true,
      timeoutMs: DISCOVERY_POLICY.TIMEOUT_MS,
      signal: abortCtrl.signal,
    })
    const rawCards = parseDiscoveryCards(raw)
    accepted = await mergeCards(rawCards, cfg.userProfile.banTopics, now)
    return accepted > 0
  } catch (e) {
    console.warn('话题候选发现失败(静默,稍后退避重试)', e)
    // 失败也记尝试:静默退避一个冷却周期,避免无 Key/限流时空转连发
    try {
      await mutateTopicState((s) => {
        applyDiscoveryAttempt(s, deps.now())
        return { state: s, result: undefined }
      })
    } catch {
      // 记账失败不影响主流程
    }
    return false
  } finally {
    inFlight = false
    abortCtrl = null
  }
}

/** 尝试记账(成功与失败都走):刷新尝试时间/清消费计数/累加当日次数 */
function applyDiscoveryAttempt(s: import('./types').TopicStateV1, now: number): void {
  const today = localDay(now)
  s.discovery = {
    lastAttemptAt: now,
    consumedSinceRestock: 0,
    attemptDay: today,
    attemptCount: (s.discovery.attemptDay === today ? s.discovery.attemptCount : 0) + 1,
  }
}

/** 清洗入库 + 尝试记账(成败都记:失败静默退避一个冷却周期);返回入库张数 */
async function mergeCards(rawCards: unknown[], banText: string, now: number): Promise<number> {
  const banWords = parseBanWords(banText)
  let accepted = 0
  try {
    await mutateTopicState((s) => {
      const existing = new Set<string>([
        ...s.reservoir.map((c) => c.fingerprint),
        ...s.recent.map((r) => r.fingerprint),
      ])
      const fresh: TopicCard[] = []
      for (const rc of rawCards) {
        if (fresh.length >= DISCOVERY_POLICY.BATCH) break
        const card = sanitizeGeneratedCard(rc, { banWords, existingFingerprints: existing, now })
        if (card) {
          fresh.push(card)
          existing.add(card.fingerprint)
        }
      }
      applyDiscoveryAttempt(s, now)
      if (fresh.length > 0) {
        const freshFps = new Set(fresh.map((f) => f.fingerprint))
        const kept = s.reservoir.filter((c) => !freshFps.has(c.fingerprint))
        s.reservoir = [...kept, ...fresh].slice(-MAX_RESERVOIR)
        accepted = fresh.length
      }
      return { state: s, result: accepted }
    })
  } catch (e) {
    console.warn('话题候选入库失败(静默)', e)
  }
  return accepted
}
