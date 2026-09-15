// 世界模型 · 引擎核心(依赖注入,测试用假传感器/假时钟)。
// 单一采样循环:fetch → mergeSnapshot(归一+差分)→ 事件上总线 → 访问器/注记读快照。
// 采样失败保持上次状态(envAware 同款纪律),不打扰演出;
// 上一帧未完成时不并发采样,慢传感器不会堆出请求风暴。

import { createBus, type WorldBus } from './bus'
import { mergeSnapshot } from './normalizer'
import { renderWorldNote, type RenderLedger } from './render'
import type { EnvSnapshotRaw, WorldEvent, WorldState } from './types'

export interface WorldClock {
  now(): number
  /** 返回取消函数(与 window.setInterval 语义一致;测试注入虚拟时钟) */
  setInterval(fn: () => void, ms: number): () => void
}

export interface WorldEngineDeps {
  /** 一次采样(Rust env_snapshot 封装);抛错 = 本帧保持现状 */
  fetch(): Promise<EnvSnapshotRaw>
  clock?: WorldClock
}

export interface WorldEngine {
  start(intervalMs?: number): void
  stop(): void
  /** 当前归一状态;未启动/传感器从未成功返回过时为 null */
  snapshot(): WorldState | null
  /** 注记渲染(冷却账本由引擎持有,跨帧跨通道去重) */
  note(cooldownMs: number): string | undefined
  onEvent(fn: (event: WorldEvent) => void): () => void
  /** 桌面文件数摘要注入(低频副传感器,不参与差分) */
  noteDesktopFileCount(count: number): void
  /** 测试钩子:直接注入一帧采样并返回差分(不经 fetch) */
  ingest(raw: EnvSnapshotRaw): WorldEvent[]
}

export const defaultWorldClock: WorldClock = {
  now: () => Date.now(),
  setInterval(fn, ms) {
    const id = window.setInterval(fn, ms)
    return () => window.clearInterval(id)
  },
}

export function createWorldEngine(deps: WorldEngineDeps): WorldEngine {
  const clock = deps.clock ?? defaultWorldClock
  let state: WorldState | null = null
  let stopPolling: (() => void) | null = null
  let polling = false
  const ledger: RenderLedger = new Map()
  const bus: WorldBus<WorldEvent> = createBus<WorldEvent>()

  async function poll(): Promise<void> {
    if (polling) return
    polling = true
    try {
      const raw = await deps.fetch()
      ingest(raw)
    } catch {
      // 传感器失败保持上次状态,不打扰演出
    } finally {
      polling = false
    }
  }

  function ingest(raw: EnvSnapshotRaw): WorldEvent[] {
    const merged = mergeSnapshot(state, raw, clock.now())
    state = merged.state
    merged.events.forEach((e) => bus.emit(e))
    return merged.events
  }

  return {
    start(intervalMs = 60_000) {
      if (stopPolling !== null) return
      void poll()
      stopPolling = clock.setInterval(() => void poll(), intervalMs)
    },
    stop() {
      stopPolling?.()
      stopPolling = null
      state = null
      ledger.clear()
    },
    snapshot: () => state,
    note: (cooldownMs) => renderWorldNote(state, cooldownMs, clock.now(), ledger),
    onEvent: (fn) => bus.subscribe(fn),
    noteDesktopFileCount(count) {
      if (state) state.desktopFileCount = count
    },
    ingest,
  }
}
