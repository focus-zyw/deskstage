// 招牌怪癖·生成编排(设计方案 §4):单次 JSON 查询走 llmGateway 的 API 通道,
// 失败静默放弃(怪癖是馈赠不是任务,绝不阻塞演出链路)。冷启动惰性触发:
// 开启系统后某启用角色怪癖为空时补一条,带在飞闸与失败冷却;手动补一条绕过冷却。

import { complete } from '../engine/llmGateway'
import { getConfigSnapshot } from '../storage/configStore'
import { isCharacterEnabled, nameOf, personaText, pronounOf, type ActorSlot } from '../engine/persona'
import { QUIRK_SLOTS, QUIRK_TYPES, type QuirkCauseType, type QuirkEntry, type QuirkType, type QuirkValence } from './types'
import { buildQuirkPrompt } from './prompt'
import {
  bumpEpisode,
  getBookSync,
  insertQuirk,
  makeId,
  mutateShape,
} from './store'

const GEN_TIMEOUT_MS = 60_000
/** 冷启动失败后的全局冷却(手动补一条不受限) */
const FAIL_COOLDOWN_MS = 5 * 60_000

const inFlight = new Set<ActorSlot>()
let lastFailAt = 0

// ---------- 获取公示(群聊房间 control 消息;App 注入 sink,无运行时为 no-op) ----------

let announceSink: ((text: string) => void) | null = null

export function setAnnounceSink(fn: ((text: string) => void) | null): void {
  announceSink = fn
}

type AcquiredListener = () => void
const acquiredListeners = new Set<AcquiredListener>()

/** 订阅怪癖变动(设置页刷新用);返回退订函数 */
export function onQuirkAcquired(listener: AcquiredListener): () => void {
  acquiredListeners.add(listener)
  return () => {
    acquiredListeners.delete(listener)
  }
}

function announceAcquired(slot: ActorSlot, behavior: string): void {
  announceSink?.(`「${nameOf(slot)}」长出了新怪癖:${behavior}`)
  for (const l of acquiredListeners) l()
}

// ---------- 输出解析(容忍围栏/混杂文本;结构校验,不做语义去重——同域靠 prompt 约束) ----------

export interface ParsedQuirk {
  trigger: string
  behavior: string
  valence: QuirkValence
  type: QuirkType
  cause: string
  causeType: QuirkCauseType
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  return raw.slice(start, end + 1)
}

/** 解析并校验模型输出:trigger/behavior/valence 严格,type/causeType/cause 容错缺省 */
export function parseQuirkJson(raw: string): ParsedQuirk | null {
  const json = extractJsonObject(raw)
  if (!json) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  const trigger = typeof obj.trigger === 'string' ? obj.trigger.trim().slice(0, 80) : ''
  const behavior = typeof obj.behavior === 'string' ? obj.behavior.trim().slice(0, 80) : ''
  const valence = obj.valence
  if (!trigger || !behavior) return null
  if (valence !== 'red' && valence !== 'blue') return null
  const type = (QUIRK_TYPES as readonly string[]).includes(obj.type as string) ? (obj.type as QuirkType) : '触发式'
  const causeType: QuirkCauseType =
    obj.causeType === 'memory' || obj.causeType === 'interaction' || obj.causeType === 'inferred'
      ? obj.causeType
      : 'inferred'
  const cause = typeof obj.cause === 'string' ? obj.cause.trim().slice(0, 120) : ''
  return { trigger, behavior, valence, type, cause, causeType }
}

/** 模型行使"宁缺毋滥"出口:{"skip":true} 且没给怪癖字段 → 正常空手,不算失败不进冷却 */
export function isSkipResponse(raw: string): boolean {
  const json = extractJsonObject(raw)
  if (!json) return false
  try {
    const obj = JSON.parse(json) as Record<string, unknown>
    return obj.skip === true && typeof obj.trigger !== 'string'
  } catch {
    return false
  }
}

// ---------- 生成 ----------

function causeArchiveOf(slot: ActorSlot): string {
  const causes = getBookSync()[slot]
    .map((q) => q.cause)
    .filter((c) => c.length > 0)
  return causes.map((c) => `- ${c}`).join('\n')
}

export type GenOutcome = 'ok' | 'skip' | 'fail'

/** 为一个角色生成一条怪癖并入库。source=cold 时 recentDigest 缺省(因果可虚构)。
 *  返回 ok=已入库(可能发生替换),skip=未启用/在飞/满锁/冷却,fail=调用或解析失败 */
export async function generateForSlot(
  slot: ActorSlot,
  source: 'cold' | 'crystallized' = 'cold',
  opts: { recentDigest?: string; force?: boolean } = {},
): Promise<GenOutcome> {
  if (!getConfigSnapshot().quirkSystem) return 'skip'
  if (inFlight.has(slot)) return 'skip'
  if (!isCharacterEnabled(slot)) return 'skip'
  if (!opts.force) {
    if (Date.now() - lastFailAt < FAIL_COOLDOWN_MS) return 'skip'
    // 冷启动只补空位;结晶路径(P2)不从此入口进
    if (source === 'cold' && getBookSync()[slot].length > 0) return 'skip'
  }
  inFlight.add(slot)
  try {
    const prompt = buildQuirkPrompt({
      name: nameOf(slot),
      pronoun: pronounOf(slot),
      persona: personaText(slot),
      existing: getBookSync()[slot].map((q) => ({ trigger: q.trigger, behavior: q.behavior, valence: q.valence })),
      recentDigest: opts.recentDigest,
      causeArchive: causeArchiveOf(slot),
    })
    const raw = await complete({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      maxTokens: 800,
      jsonMode: true,
      timeoutMs: GEN_TIMEOUT_MS,
    })
    if (isSkipResponse(raw)) return 'skip' // 宁缺毋滥出口:正常空手,不进失败冷却
    const parsed = parseQuirkJson(raw)
    if (!parsed) {
      lastFailAt = Date.now()
      return 'fail'
    }
    const entry: QuirkEntry = {
      id: makeId(),
      trigger: parsed.trigger,
      behavior: parsed.behavior,
      valence: parsed.valence,
      type: parsed.type,
      cause: parsed.cause,
      causeType: parsed.causeType,
      source,
      locked: false,
      createdAtEp: 0, // mutate 内回填真实集数
      lastUsedEp: -1,
    }
    let acquired = false
    await mutateShape((s) => {
      const withEp: QuirkEntry = { ...entry, createdAtEp: s.episode }
      const result = insertQuirk(s.quirks, slot, withEp)
      if (!result.ok) return s
      acquired = true
      return { ...s, quirks: result.book }
    })
    if (!acquired) return 'skip' // 该价态全部锁定
    announceAcquired(slot, parsed.behavior)
    return 'ok'
  } catch (e) {
    console.warn('怪癖生成失败(静默,下个周期再试)', e)
    lastFailAt = Date.now()
    return 'fail'
  } finally {
    inFlight.delete(slot)
  }
}

/** 冷启动惰性触发:启用角色中怪癖为空者逐个补一条(顺序执行,避免并发请求风暴) */
export async function ensureColdStarts(): Promise<void> {
  if (!getConfigSnapshot().quirkSystem) return
  for (const slot of QUIRK_SLOTS) {
    if (!isCharacterEnabled(slot)) continue
    if (getBookSync()[slot].length > 0) continue
    await generateForSlot(slot, 'cold')
  }
}

/** 主演出集数记账 + 顺手冷启动(generateDialog 每集调用;全部 fire-and-forget,绝不阻塞) */
export async function notePerformanceEpisode(): Promise<void> {
  try {
    await bumpEpisode()
    await ensureColdStarts()
  } catch (e) {
    console.warn('怪癖周期记账失败(静默)', e)
  }
}

// 测试钩子:读取在飞状态(不导出到 index)
export function _isInFlight(slot: ActorSlot): boolean {
  return inFlight.has(slot)
}
