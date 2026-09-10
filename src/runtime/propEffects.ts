// 舞台道具效果:全局 external store(仿 utilityTasks 模式),礼物旁路与工具卡桥共用的唯一写入口。
// 时序不变量(有单测钉死,改实现前先读):
//   1. 同 key 替换绕过冷却 —— 工具卡 running→done 换图不能被冷却拦住;
//   2. 旧道具的到期 timer 不得删除后来替换上的新道具 —— 到期回调按实例 eid 判归属;
//   3. 同屏最多 MAX_SLOTS 个,槽位(0..2)错位排列,不重叠;超限逐出最早展示的;
//   4. 无 key 的展示受每道具最小重现间隔(冷却)约束,防礼物连击刷屏;
//   5. sticky 常驻(工具 running)只能被同 key 替换、dismiss 或 clearProps 移除,不自动到期;
//   6. clearProps() 清空所有道具与 timer(下播/卸载用)。
// 定时器用全局 setTimeout(非 window.*),node --test 环境可直接驱动。

import type { PropId } from '../stage/props'
import { PROPS } from '../stage/props'

/** 淡出动画时长:到期先标记 leaving 播淡出,再真正移除 */
export const PROP_EXIT_MS = 360

export interface PropEffect {
  /** 实例 id:同 key 替换后变化,渲染层以它为 key 重触发入场动画 */
  eid: number
  key: string
  who: 'A' | 'B'
  propId: PropId
  /** 错位槽位 0..2(渲染层按槽位平移,避免重叠) */
  slot: number
  /** true = 已到期,正在播淡出,随后被移除 */
  leaving: boolean
}

export interface ShowPropOptions {
  /** 相同 key 的展示会被替换(替换绕过冷却);缺省 = 独立展示,受冷却约束 */
  key?: string
  /** 展示时长(缺省用注册表默认);0 表示常驻(sticky) */
  durationMs?: number
}

interface SlotEntry {
  effect: PropEffect
  timer: ReturnType<typeof setTimeout> | null
}

const MAX_SLOTS = 3
/** 同一道具两次展示的最小间隔(无 key 展示生效;礼物连击节流) */
const PROP_COOLDOWN_MS = 1_500

let effects: SlotEntry[] = []
let seq = 0
const lastShownAt = new Map<PropId, number>()
const listeners = new Set<() => void>()

/** getSnapshot 缓存:useSyncExternalStore 要求稳定引用,每次 .map() 新数组会死循环(runtimeMode 同款教训) */
let snapshotCache: readonly PropEffect[] = []

function emit(): void {
  snapshotCache = effects.map((e) => e.effect)
  listeners.forEach((l) => l())
}

export function subscribeProps(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function getPropEffects(): readonly PropEffect[] {
  return snapshotCache
}

function removeAt(index: number): void {
  const entry = effects[index]
  if (entry.timer !== null) clearTimeout(entry.timer)
  effects = effects.filter((_, i) => i !== index)
}

/** 按 eid 移除:到期回调的归属校验用,旧 timer 删不掉新道具 */
function removeByEid(eid: number): void {
  const index = effects.findIndex((e) => e.effect.eid === eid)
  if (index >= 0) {
    removeAt(index)
    emit() // 淡出结束真正离场要通知订阅者(否则 UI 停在 leaving 帧)
  }
}

/** 展示一个道具;被冷却拦下时返回 false(纯节流,无副作用) */
export function showProp(who: 'A' | 'B', propId: PropId, opts: ShowPropOptions = {}): boolean {
  const def = PROPS[propId]
  if (!def) return false
  const now = Date.now()
  const keyed = typeof opts.key === 'string'
  if (!keyed && now - (lastShownAt.get(propId) ?? 0) < PROP_COOLDOWN_MS) return false
  lastShownAt.set(propId, now)

  const key = keyed ? opts.key! : `gift:${propId}`
  const durationMs = opts.durationMs ?? def.durationMs
  const eid = ++seq

  // 同 key 替换:复用其槽位;否则占最低空闲槽;满则逐出最早展示的
  let slot = -1
  const sameKey = effects.findIndex((e) => e.effect.key === key)
  if (sameKey >= 0) {
    slot = effects[sameKey].effect.slot
    removeAt(sameKey)
  } else if (effects.length >= MAX_SLOTS) {
    removeAt(0)
  }
  if (slot < 0) {
    const used = new Set(effects.map((e) => e.effect.slot))
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (!used.has(i)) {
        slot = i
        break
      }
    }
  }

  const effect: PropEffect = { eid, key, who, propId, slot, leaving: false }
  const timer =
    durationMs > 0
      ? setTimeout(() => {
          // 归属校验:期间被替换/清除的话,eid 已不在场,直接返回
          const entry = effects.find((e) => e.effect.eid === eid)
          if (!entry) return
          entry.effect.leaving = true
          emit()
          entry.timer = setTimeout(() => removeByEid(eid), PROP_EXIT_MS)
        }, durationMs)
      : null
  effects = [...effects, { effect, timer }]
  emit()
  return true
}

/** 移除指定 key 的全部展示(如翻译被用户取消时撤掉工具卡) */
export function dismissProps(key: string): void {
  const before = effects.length
  effects = effects.filter((e) => {
    if (e.effect.key !== key) return true
    if (e.timer !== null) clearTimeout(e.timer)
    return false
  })
  if (effects.length !== before) emit()
}

/** 清空所有道具与 timer,并重置冷却账(下播/卸载:新一场直播从零开始) */
export function clearProps(): void {
  for (const e of effects) if (e.timer !== null) clearTimeout(e.timer)
  effects = []
  lastShownAt.clear()
  emit()
}
