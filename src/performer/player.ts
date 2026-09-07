// 演出队列：顺序消费一段对话脚本，按台词时长驱动 UI，可随时中止。
// M2 中 LLM 生成的 dialog 数组将直接喂给同一个播放器，前端表现层不用改。

export type Speaker = 'A' | 'B'

export interface DialogLine {
  speaker: Speaker
  text: string
  action: string // 动作词表：idle|talk|happy|angry|sad|surprise|shake|jump
}

/** 气泡显示时长：基础 1.2s + 每字 160ms */
export function bubbleDuration(text: string): number {
  return 1200 + text.length * 160
}

export interface PlayerCallbacks {
  /** 一句台词开始：显示气泡 + 切动作 */
  onLine: (line: DialogLine) => void
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
      for (const line of lines) {
        if (ctrl.signal.aborted) break
        this.cbs.onLine(line)
        await sleep(bubbleDuration(line.text), ctrl.signal)
        if (ctrl.signal.aborted) break
        this.cbs.onLineEnd(line.speaker)
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
