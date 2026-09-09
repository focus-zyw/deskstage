// 演出队列：顺序消费一段对话脚本，按台词时长驱动 UI，可随时中止。
// LLM 生成的 dialog 数组与硬编码脚本走同一条路；
// 台词可带演出信息(停顿/听者动作/语气),节奏由喜剧时机决定而不只是字数。
// 类型与清洗集中在 dialogSchema(唯一事实源),这里只管播放。

import { clampPauseMs, type DialogLine, type Speaker } from './dialogSchema'

export type { DialogLine, Delivery, Speaker } from './dialogSchema'

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
