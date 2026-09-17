// 影子大脑装配层:把调度器评估、现场快照、Rust 桥、执行钩子接成一个回路。
// 三个入口——
// · observeEvaluation:调度器每 tick 回传本地评估 → 快照推入 Rust 环 + 归档;
// · consultBrain:接管模式下候选触发前问外部大脑(长轮询 + 预算,超时回落本地);
// · syncBrainBridge:App 启动/配置变化时启停 Rust 监听器(dev 构建才有效)。
// 事件消费(bridge-decision/bridge-speak):决策落影子存档,指挥过闸后经执行
// 钩子上屏。本模块任何失败都静默——影子/接管绝不放大故障到演出主流程。
// 设计见 docs/影子大脑桥接设计方案.md。

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { appDataDir, join } from '@tauri-apps/api/path'
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import type { DialogLine } from '../performer/dialogSchema'
import { getConfig, inTauri } from '../storage/configStore'
import { worldState, isFullscreenApp } from '../world'
import { getMoods } from '../storage/moodStore'
import { listChatTurns } from '../storage/chatLogStore'
import { readStats } from '../storage/interactionStore'
import { prepareTurnMemory } from '../storage/memoryStore'
import { getConfigSnapshot } from '../storage/configStore'
import {
  schedulerTiming,
  quotaCapOf,
  noteSpontaneous,
  type ConsultVerdict,
} from '../runtime/proactiveScheduler'
import { getCaps } from '../runtime/runtimeMode'
import { buildBrainInput } from './snapshot'
import { sanitizeBrainDecision, type BrainDecision, type BrainInput, type LocalEvaluation, type ShadowDecisionRecord } from './types'
import { appendShadowRecord } from './shadowStore'

/** 现场指挥的执行钩子(演出导演注入 playShortChat 路径):返回是否真的开始播 */
export type BrainSpeakHook = (lines: DialogLine[]) => boolean

let speakHook: BrainSpeakHook | null = null

/** 演出导演装配时注入执行钩子(桥未开也注册,注册本身零开销);传 null = 卸载清钩 */
export function registerBrainSpeakHook(hook: BrainSpeakHook | null): void {
  speakHook = hook
}

// ---------- 运行状态 ----------

/** Rust 监听器是否由本窗口拉起(决定 observe/consult 是否工作) */
let running = false
/** 事件退订(启停时装卸) */
let unlistens: UnlistenFn[] = []

function brainOnOf(cfg: { enabled: boolean; mode: string }): boolean {
  return cfg.enabled && cfg.mode !== 'off'
}

// ---------- 快照采集(observe 与 consult 共用) ----------

/** 输入镜像:inputId → input,供决策配对回查本地评估(cap 后 LRU 淘汰) */
const mirror = new Map<string, BrainInput>()
const MIRROR_CAP = 200

function remember(input: BrainInput): void {
  mirror.set(input.inputId, input)
  if (mirror.size > MIRROR_CAP) {
    const oldest = mirror.keys().next().value
    if (oldest !== undefined) mirror.delete(oldest)
  }
}

async function collectInput(evaluation: LocalEvaluation): Promise<BrainInput> {
  const cfg = getConfigSnapshot()
  const [moods, turns, stats, memory] = await Promise.all([
    getMoods(),
    listChatTurns(6),
    readStats(),
    prepareTurnMemory({ query: '', n: 3 }).catch(() => null),
  ])
  const timing = schedulerTiming()
  const input = buildBrainInput({
    world: worldState(),
    evaluation,
    quotaCap: quotaCapOf(cfg.proactivity),
    timing,
    moods,
    promptFacts: memory?.promptFacts ?? [],
    lastTurns: turns.map((t) => ({ who: t.who, text: t.text })),
    interactions: stats,
    includeWindowTitle: cfg.contextSense.windowTitle === true,
  })
  remember(input)
  return input
}

let pushInFlight = false
let lastArchiveAt = 0

/** 调度器 observe 依赖:同步入口,零开销(桥没跑直接返回),异步部分去重 */
export function observeEvaluation(evaluation: LocalEvaluation): void {
  if (!running || pushInFlight) return
  pushInFlight = true
  void (async () => {
    try {
      const cfg = await getConfig()
      if (!brainOnOf(cfg.shadowBrain)) return
      const input = await collectInput(evaluation)
      await invoke('bridge_push_input', { input })
      // 归档节流:真实决策必采,其余按心跳间隔采样("listen"侧的账也要记,影子对照才完整)
      const now = Date.now()
      if (evaluation.fired || now - lastArchiveAt >= Math.max(60_000, cfg.shadowBrain.heartbeatMs)) {
        lastArchiveAt = now
        await appendShadowRecord('inputs', input)
      }
    } catch {
      // 桥不在线/读取失败:静默,下个 tick 再来
    } finally {
      pushInFlight = false
    }
  })()
}

// ---------- 接管:候选触发前问外部大脑 ----------

interface PendingTakeover {
  requestId: string
  resolve(verdict: ConsultVerdict | null): void
  timer: number
}

let pendingTakeover: PendingTakeover | null = null

/** 调度器 consult 依赖:接管模式下问外部大脑;null = 没问到(回落本地)。
 *  预算内不回就超时——外部大脑再聪明也不许卡住桌宠 */
export async function consultBrain(
  candidate: 'spontaneous' | 'break',
): Promise<ConsultVerdict | null> {
  if (!running || pendingTakeover) return null
  const cfg = await getConfig()
  if (cfg.shadowBrain.mode !== 'takeover') return null
  const timing = schedulerTiming()
  const idleForMs =
    timing.allowedSince === null
      ? 0
      : Date.now() - Math.max(timing.allowedSince, timing.lastActivityAt)
  const input = await collectInput({
    blocked: null,
    candidate,
    fired: false,
    decline: null,
    idleForMs,
    quotaUsed: timing.quotaCount,
    reasons: ['接管模式:等待外部大脑裁决'],
  })
  const requestId = `breq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const took = await invoke<boolean>('bridge_offer_request', {
    request: { requestId, candidate, input },
  }).catch(() => false)
  if (!took) return null // 没有 Agent 挂在长轮询上:回落本地,不空等
  const budget = Math.max(1000, cfg.shadowBrain.takeoverBudgetMs)
  return new Promise<ConsultVerdict | null>((resolve) => {
    pendingTakeover = {
      requestId,
      resolve,
      timer: window.setTimeout(() => {
        pendingTakeover = null
        resolve(null) // 超时:本地照常,迟到的决策仍会被落影子
      }, budget),
    }
  })
}

// ---------- 事件消费 ----------

function settleTakeover(decision: BrainDecision): boolean {
  if (!pendingTakeover || decision.requestId !== pendingTakeover.requestId) return false
  window.clearTimeout(pendingTakeover.timer)
  const resolve = pendingTakeover.resolve
  pendingTakeover = null
  if (decision.decision === 'listen') {
    resolve('listen')
  } else {
    resolve({ verdict: 'speak', lines: decision.lines })
  }
  return true
}

async function handleDecision(payload: unknown): Promise<void> {
  const o = (payload ?? {}) as Record<string, unknown>
  const result = sanitizeBrainDecision(o.decision)
  if (!result.ok) return // 坏决策直接丢
  const decision = result.decision
  const tookOver = settleTakeover(decision)
  // 影子存档:接管应答也记(带 mode),迟到应答自然变成 mode=takeover 的影子记录
  const record: ShadowDecisionRecord = {
    ts: Date.now(),
    mode: tookOver || o.mode === 'takeover' ? 'takeover' : 'shadow',
    decision,
    localAtDecision: mirror.get(decision.inputId)?.local ?? null,
  }
  await appendShadowRecord('decisions', record)
}

async function handleSpeak(payload: unknown): Promise<void> {
  const o = (payload ?? {}) as Record<string, unknown>
  const body = (o.body ?? {}) as Record<string, unknown>
  const reply = (ok: boolean, error?: string): void => {
    void invoke('bridge_speak_reply', { ok, error: error ?? null }).catch(() => {})
  }
  // 兼容两种形状:{lines:[{speaker,text,action}]} 或 {text, action?, speaker?}
  const rawLines = Array.isArray(body.lines)
    ? body.lines
    : typeof body.text === 'string'
      ? [{ speaker: body.speaker ?? 'A', text: body.text, action: body.action }]
      : []
  const result = sanitizeBrainDecision({
    inputId: 'speak',
    decision: 'speak',
    lines: rawLines,
  })
  if (!result.ok || result.decision.lines.length === 0) {
    reply(false, 'bad-lines')
    return
  }
  // 与主动行为同一闸门:勿扰/面板/演出/语音/角色隐藏/全屏时不播
  const caps = getCaps()
  if (!caps.proactiveAllowed || caps.charHidden || isFullscreenApp()) {
    reply(false, 'gated')
    return
  }
  if (!speakHook || !speakHook(result.decision.lines)) {
    reply(false, 'busy')
    return
  }
  noteSpontaneous(Date.now()) // 指挥占自发预算,防外部连发把配额刷爆
  reply(true)
}

// ---------- 启停(Rust 监听器 + 事件订阅) ----------

interface BridgeDiscovery {
  token: string
  port: number
  startedAt: number
}

async function discoveryFile(): Promise<string> {
  const base = await appDataDir()
  const dir = await join(base, 'data')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return join(dir, 'bridge.json')
}

/** 读旧发现文件里的 token(保持稳定,Agent 侧不用换 token) */
async function loadBridgeToken(): Promise<string> {
  try {
    const file = await discoveryFile()
    if (await exists(file)) {
      const raw = JSON.parse(await readTextFile(file)) as Partial<BridgeDiscovery>
      if (typeof raw.token === 'string' && raw.token) return raw.token
    }
  } catch {
    // 坏文件按无 token 处理
  }
  return crypto.randomUUID()
}

async function writeDiscovery(info: BridgeDiscovery): Promise<void> {
  try {
    await writeTextFile(await discoveryFile(), JSON.stringify(info, null, 2))
  } catch (e) {
    console.warn('bridge.json 写入失败(Agent 需手动获知端口)', e)
  }
}

/** App 启动与配置变化时调用:按配置启停 Rust 监听器(仅 dev 构建有效) */
export async function syncBrainBridge(): Promise<void> {
  if (!inTauri || !import.meta.env.DEV) return
  const cfg = await getConfig()
  const want = brainOnOf(cfg.shadowBrain)
  if (want && !running) {
    try {
      const token = await loadBridgeToken()
      const port = await invoke<number>('bridge_start', { token })
      await writeDiscovery({ token, port, startedAt: Date.now() })
      if (unlistens.length === 0) {
        unlistens = [
          await listen<unknown>('bridge-decision', (ev) => void handleDecision(ev.payload)),
          await listen<unknown>('bridge-speak', (ev) => void handleSpeak(ev.payload)),
        ]
      }
      running = true
    } catch (e) {
      console.warn('影子大脑桥启动失败(不影响其他功能)', e)
    }
  } else if (!want && running) {
    running = false
    await invoke('bridge_stop').catch(() => {})
    unlistens.forEach((fn) => fn())
    unlistens = []
  }
}
