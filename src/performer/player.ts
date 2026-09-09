// 演出队列：顺序消费一段对话脚本，按台词时长驱动 UI，可随时中止。
// LLM 生成的 dialog 数组与硬编码脚本走同一条路；
// 台词可带演出信息(停顿/听者动作/语气),节奏由喜剧时机决定而不只是字数。

export type Speaker = 'A' | 'B'

/** 语气词表:deadpan 面瘫 / excited 兴奋 / slow 慢条斯理;缺省 normal */
export const DELIVERIES = ['deadpan', 'excited', 'slow'] as const
export type Delivery = (typeof DELIVERIES)[number]

/** 动作词表:与贴图/CSS 动画一一对应(shake/jump 复用 idle 图 + 位移动画) */
export const VALID_ACTIONS = new Set([
  'idle',
  'talk',
  'happy',
  'laugh',
  'shy',
  'sleepy',
  'wave',
  'thinking',
  'angry',
  'sad',
  'surprise',
  'shake',
  'jump',
])

export interface DialogLine {
  speaker: Speaker
  text: string
  action: string // 动作词表,见 VALID_ACTIONS
  /** 句前停顿 ms:包袱前蓄势(协议建议 300~600) */
  pauseBefore?: number
  /** 句尾额外停留 ms:响底后留白(协议建议 900~1500) */
  pauseAfter?: number
  /** 听者此刻的反应动作(词表同 action;缺省不改变) */
  listenerAction?: string
  /** 语气:驱动说话节奏(CSS)与 TTS 语速 */
  delivery?: Delivery
}

/** 停顿钳位:非法/≤0 视为无停顿,上限 1.5s 防呆 */
export function clampPauseMs(v: unknown): number | undefined {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(1500, Math.round(n))
}

/** 语气清洗:非法或缺省 normal 返回 undefined */
export function sanitizeDelivery(v: unknown): Delivery | undefined {
  return typeof v === 'string' && (DELIVERIES as readonly string[]).includes(v)
    ? (v as Delivery)
    : undefined
}

/** 台词动作清洗:非法归一为 talk */
export function sanitizeAction(v: unknown): string {
  return typeof v === 'string' && VALID_ACTIONS.has(v) ? v : 'talk'
}

/** 气泡显示时长：基础 1.2s + 每字 160ms */
export function bubbleDuration(text: string): number {
  return 1200 + text.length * 160
}

export interface PlayerCallbacks {
  /** 一句台词开始：显示气泡 + 切动作;index 用于语音预合成下一句 */
  onLine: (line: DialogLine, index: number) => void
  /** 一句台词结束：清气泡 + 回 idle */
  onLineEnd: (speaker: Speaker) => void
  /** 整段播完（自然结束，非 stop） */
  onDone: () => void
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })

export class PerformancePlayer {
  private ctrl: AbortController | null = null
  private cbs: PlayerCallbacks

  constructor(cbs: PlayerCallbacks) {
    this.cbs = cbs
  }

  get playing(): boolean {
    return this.ctrl !== null
  }

  /** 播放一段脚本；重复调用会先停掉上一段 */
  play(lines: DialogLine[], opts: { gap?: number } = {}) {
    this.stop()
    const ctrl = new AbortController()
    this.ctrl = ctrl
    const gap = opts.gap ?? 400
    void (async () => {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (ctrl.signal.aborted) break
        // 句前蓄势:包袱抖出来之前先停一拍,停顿本身就是笑点的一部分
        const before = clampPauseMs(line.pauseBefore)
        if (before) await sleep(before, ctrl.signal)
        if (ctrl.signal.aborted) break
        this.cbs.onLine(line, i)
        await sleep(bubbleDuration(line.text), ctrl.signal)
        if (ctrl.signal.aborted) break
        this.cbs.onLineEnd(line.speaker)
        // 句尾留白:响底包袱后多停一拍,给笑的时间
        const after = clampPauseMs(line.pauseAfter)
        if (after) await sleep(after, ctrl.signal)
        if (ctrl.signal.aborted) break
        await sleep(gap, ctrl.signal)
      }
      if (!ctrl.signal.aborted) {
        this.ctrl = null
        this.cbs.onDone()
      }
    })()
  }

  stop() {
    this.ctrl?.abort()
    this.ctrl = null
  }
}
