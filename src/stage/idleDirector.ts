import { SpriteVariantPicker, type SpriteVariant } from './spriteVariants'

const REST_MIN_MS = 12_000
const REST_MAX_MS = 25_000
const DEFAULT_HOLD_MS = 7_000

type TimerHandle = ReturnType<typeof globalThis.setTimeout>

export interface IdleFrame {
  file: string
  special: boolean
}

export interface IdleDirectorConfig {
  baseFile: string
  variants: readonly SpriteVariant[] | undefined
  onFrame: (frame: IdleFrame) => void
}

interface IdleClock {
  now: () => number
  random: () => number
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle
  clearTimeout: (timer: TimerHandle) => void
}

const browserClock: IdleClock = {
  now: Date.now,
  random: Math.random,
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
}

function randomBetween(clock: IdleClock, min: number, max: number): number {
  return min + Math.max(0, Math.min(clock.random(), 0.999999999999)) * (max - min)
}

/**
 * 管理“基础 idle → 特殊姿势 → 基础 idle”的完整待机生命周期。
 * React 层只负责在角色可待机时 start，在交互或演出开始时 stop。
 */
export class IdleDirector {
  private readonly picker = new SpriteVariantPicker()
  private readonly clock: IdleClock
  private timer: TimerHandle | undefined
  private generation = 0

  constructor(clock: IdleClock = browserClock) {
    this.clock = clock
  }

  start(config: IdleDirectorConfig): void {
    this.stop()
    const delayed = config.variants?.filter(
      (variant) => (variant.activationDelayMs ?? 0) > 0,
    )
    if (!delayed?.length) return

    const generation = this.generation
    const initialDelay = Math.min(
      ...delayed.map((variant) => Math.max(0, variant.activationDelayMs ?? 0)),
    )
    // activationDelayMs 是中位值；上下浮动 25%，避免两名角色同步换姿势。
    this.schedule(generation, initialDelay * randomBetween(this.clock, 0.75, 1.25), () => {
      this.showNext(config, delayed, generation)
    })
  }

  stop(): void {
    this.generation += 1
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private showNext(
    config: IdleDirectorConfig,
    variants: readonly SpriteVariant[],
    generation: number,
  ): void {
    const file = this.picker.pick(
      'idle',
      config.baseFile,
      variants,
      this.clock.now(),
      this.clock.random,
    )
    if (file === config.baseFile) {
      this.scheduleRest(config, variants, generation)
      return
    }

    config.onFrame({ file, special: true })
    const selected = variants.find((variant) => variant.file === file)
    const holdMs = Math.max(500, selected?.holdMs ?? DEFAULT_HOLD_MS)
    this.schedule(generation, holdMs, () => {
      config.onFrame({ file: config.baseFile, special: false })
      this.scheduleRest(config, variants, generation)
    })
  }

  private scheduleRest(
    config: IdleDirectorConfig,
    variants: readonly SpriteVariant[],
    generation: number,
  ): void {
    this.schedule(generation, randomBetween(this.clock, REST_MIN_MS, REST_MAX_MS), () => {
      this.showNext(config, variants, generation)
    })
  }

  private schedule(generation: number, delayMs: number, callback: () => void): void {
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      if (generation !== this.generation) return
      callback()
    }, Math.max(0, Math.round(delayMs)))
  }
}
