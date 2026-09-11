// 互动事件账本:data/interactions.json。记录观众对角色的捣乱行为,
// 攒够后在下一集生成的 prompt 里注入"抱怨观众"的开场素材(注入即清零计数)。
// 与 story.json(记忆系统)互不干涉;浏览器预览降级 localStorage。

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { inTauri } from './configStore'
import { recapText } from '../engine/interactionRules'
import type { Speaker } from '../performer/dialogSchema'

export interface InteractionStats {
  pokeA: number
  pokeB: number
  pokeC: number
  interrupts: number
  drags: number
  sinceInject: number
  /** 主动行为被用户打断的连击计数(按行为分桶):连续 >=3 次 → 该类行为冷却翻倍 */
  dismissSpontaneous: number
  dismissReplay: number
  dismissBreak: number
}

const DEFAULTS: InteractionStats = {
  pokeA: 0, pokeB: 0, pokeC: 0, interrupts: 0, drags: 0, sinceInject: 0,
  dismissSpontaneous: 0, dismissReplay: 0, dismissBreak: 0,
}
const LS_KEY = 'vc-interactions'
const INJECT_THRESHOLD = 3
const DISMISS_THRESHOLD = 3

let cache: InteractionStats | null = null

function sanitize(v: unknown): InteractionStats {
  const o = (v ?? {}) as Record<string, unknown>
  const num = (x: unknown) => (Number.isFinite(Number(x)) ? Math.max(0, Math.floor(Number(x))) : 0)
  return {
    pokeA: num(o.pokeA), pokeB: num(o.pokeB), pokeC: num(o.pokeC),
    interrupts: num(o.interrupts), drags: num(o.drags),
    sinceInject: num(o.sinceInject),
    dismissSpontaneous: num(o.dismissSpontaneous),
    dismissReplay: num(o.dismissReplay),
    dismissBreak: num(o.dismissBreak),
  }
}

async function readAll(): Promise<InteractionStats> {
  if (cache) return cache
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitize(JSON.parse(raw))
    } catch { /* ignore */ }
    return { ...DEFAULTS }
  }
  try {
    const base = await appDataDir()
    const file = await join(base, 'data', 'interactions.json')
    if (await exists(file)) return sanitize(JSON.parse(await readTextFile(file)))
  } catch (e) {
    console.warn('互动账本读取失败(静默)', e)
  }
  return { ...DEFAULTS }
}

async function writeAll(stats: InteractionStats): Promise<void> {
  cache = stats
  if (!inTauri) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(stats)) } catch { /* ignore */ }
    return
  }
  try {
    const base = await appDataDir()
    const dir = await join(base, 'data')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    await writeTextFile(await join(dir, 'interactions.json'), JSON.stringify(stats, null, 2))
  } catch (e) {
    console.warn('互动账本落盘失败(静默)', e)
  }
}

/** 记录一次捣乱行为 */
export async function logInteraction(kind: 'pokeA' | 'pokeB' | 'pokeC' | 'interrupts' | 'drags'): Promise<void> {
  const stats = await readAll()
  const next = sanitize({ ...stats, [kind]: (stats as unknown as Record<string, number>)[kind] + 1, sinceInject: stats.sinceInject + 1 })
  await writeAll(next)
}

/** 若攒够素材,返回注入下一集 prompt 的抱怨文案(调用方注入后应调 markInjected)。
 *  消费时把戳/拖计数一并清零——账本是"这一期攒的量",不无限累计,
 *  否则开场抱怨会报出"拖了上百次"这种吓人的终身累计数 */
export async function takeRecap(): Promise<string | null> {
  const stats = await readAll()
  if (stats.sinceInject < INJECT_THRESHOLD) return null
  const next = sanitize({
    ...stats,
    pokeA: 0, pokeB: 0, pokeC: 0, drags: 0,
    sinceInject: 0,
  })
  await writeAll(next)
  return recapText(stats.pokeA, stats.pokeB, stats.drags, stats.pokeC)
}

/** 预览版 takeRecap:判定条件与文案完全一致,但不重置计数——预生成场景先 peek,
 *  真正开播时再 takeRecap() 消费(两次之间新增的互动会被一并消费,可接受) */
export async function peekRecap(): Promise<string | null> {
  const stats = await readAll()
  if (stats.sinceInject < INJECT_THRESHOLD) return null
  return recapText(stats.pokeA, stats.pokeB, stats.drags, stats.pokeC)
}

/** 记被打断的角色对应的账本键 */
const POKE_KEY: Record<Speaker, 'pokeA' | 'pokeB' | 'pokeC'> = { A: 'pokeA', B: 'pokeB', C: 'pokeC' }

/** 打断是双倍恶劣行为:额外 +1 */
export async function logInterrupt(target: Speaker): Promise<void> {
  const stats = await readAll()
  const key = POKE_KEY[target]
  await writeAll(sanitize({
    ...stats,
    [key]: (stats as unknown as Record<string, number>)[key] + 1,
    interrupts: stats.interrupts + 1,
    sinceInject: stats.sinceInject + 2,
  }))
}

export async function logDrag(): Promise<void> {
  const stats = await readAll()
  await writeAll(sanitize({ ...stats, drags: stats.drags + 1, sinceInject: stats.sinceInject + 1 }))
}

// ---------- 主动行为降频记账 ----------
// 用户提前掐断某类主动行为(自发闲聊/自动重放/久坐提醒) → 连击 +1;
// 用户做出任何主动互动(戳/聊天/点播) → 连击清零。连击满 3 该类冷却翻倍。

export type DismissableKind = 'spontaneous' | 'replay' | 'break'

export async function logDismiss(kind: DismissableKind): Promise<void> {
  const key = `dismiss${kind.charAt(0).toUpperCase()}${kind.slice(1)}` as
    | 'dismissSpontaneous' | 'dismissReplay' | 'dismissBreak'
  const stats = await readAll()
  await writeAll(sanitize({ ...stats, [key]: stats[key] + 1 }))
}

/** 用户主动互动:所有降频连击清零(还在陪玩的观众不该被降频) */
export async function resetDismissals(): Promise<void> {
  const stats = await readAll()
  if (stats.dismissSpontaneous === 0 && stats.dismissReplay === 0 && stats.dismissBreak === 0) return
  await writeAll(sanitize({ ...stats, dismissSpontaneous: 0, dismissReplay: 0, dismissBreak: 0 }))
}

/** 该类主动行为的冷却倍率:连击满 3 翻倍,满 6 再翻(封顶 4 倍) */
export async function dismissCooldownMultiplier(kind: DismissableKind): Promise<number> {
  const stats = await readAll()
  const key = `dismiss${kind.charAt(0).toUpperCase()}${kind.slice(1)}` as
    | 'dismissSpontaneous' | 'dismissReplay' | 'dismissBreak'
  if (stats[key] >= 6) return 4
  if (stats[key] >= DISMISS_THRESHOLD) return 2
  return 1
}
