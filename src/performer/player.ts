// 演出队列：顺序消费一段对话脚本，按台词时长驱动 UI，可随时中止。
// LLM 生成的 dialog 数组与硬编码脚本走同一条路；
// 台词可带演出信息(停顿/听者动作/语气),节奏由喜剧时机决定而不只是字数。
// 类型与清洗集中在 dialogSchema(唯一事实源),这里只管播放。

import { clampPauseMs, deliverySpeed, type ChoicePoint, type DialogLine, type Speaker } from './dialogSchema'

export type { DialogLine, Delivery, Speaker, ChoicePoint, ChoiceOption } from './dialogSchema'

/** 气泡显示时长：基础 1.2s + 每字 160ms */
export function bubbleDuration(text: string): number {
  return 1200 + text.length * 160
}

export interface PlayerCallbacks {
  /** 一句台词开始:显示气泡 + 切动作;index 用于语音预合成下一句。
   *  可返回「这句语音播放结束」的 promise(tts 的 speakTracked):播放器等语音真正
   *  结束再推进(下限 70% 预估时长,估算+8s 兜底防悬挂);返回 null 按纯预估推进 */
  onLine: (line: DialogLine, index: number) => Promise<void> | null | undefined
  /** 一句台词结束：清气泡 + 回 idle */
  onLineEnd: (speaker: Speaker) => void
  /** 整段播完（自然结束，非 stop） */
  onDone: () => void
  /** 播放到观众抉择点:暂停推进,等 resume(branchId) 继续 */
  onChoice?: (choice: ChoicePoint) => void
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

/** 一句台词的推进节奏:有语音 = max(70% 预估, 语音结束),避免语音尾巴被下一句掐断
 *  或语音结束后干等;无语音(null = 被压制/未接语音)按原预估时长 */
async function lineWait(
  dur: number,
  audio: Promise<void> | null | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!audio) {
    await sleep(dur, signal)
    return
  }
  await Promise.all([
    sleep(Math.round(dur * 0.7), signal),
    Promise.race([audio, sleep(dur + 8000, signal)]),
  ])
}

export class PerformancePlayer {
  private ctrl: AbortController | null = null
  private cbs: PlayerCallbacks

  constructor(cbs: PlayerCallbacks) {
    this.cbs = cbs
  }

  get playing(): boolean {
    return this.ctrl !== null
  }

  /** 播放一段脚本；重复调用会先停掉上一段。
   *  choice+after 同时提供时:播完 before 后触发 onChoice 暂停,
   *  等 resume(branchId) 播对应分支 */
  play(
    lines: DialogLine[],
    opts: { gap?: number; choice?: ChoicePoint; after?: Record<string, DialogLine[]> } = {},
  ) {
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
        const audio = this.cbs.onLine(line, i)
        // 气泡时长按语速修正:slow 的语音更长,气泡停留等比加长,避免下一句打断语音
        const dur = Math.round(bubbleDuration(line.text) / deliverySpeed(line.delivery))
        await lineWait(dur, audio, ctrl.signal)
        if (ctrl.signal.aborted) break
        // 句尾留白:此间气泡与听者反应继续停留,响底包袱有笑的时间
        const after = clampPauseMs(line.pauseAfter)
        if (after) await sleep(after, ctrl.signal)
        if (ctrl.signal.aborted) break
        // 最后一句跳过 onLineEnd:响底表情定格给观众笑的时间(收底拍由 onDone 侧统一回 idle)
        if (i < lines.length - 1) {
          this.cbs.onLineEnd(line.speaker)
          await sleep(gap, ctrl.signal)
        }
      }
      // 观众抉择点:暂停推进,窗体侧弹按钮;resume(branchId) 后播对应分支
      if (!ctrl.signal.aborted && opts.choice && opts.after) {
        this.ctrl = null // 暂停期间视作非播放态(守卫按空闲处理)
        this.cbs.onChoice?.(opts.choice)
        const branchId = await new Promise<string>((resolve) => {
          this.choiceWaiter = resolve
        })
        this.ctrl = ctrl
        const afterLines = branchId === '__aborted__' ? [] : opts.after[branchId] ?? []
        for (let i = 0; i < afterLines.length; i++) {
          const line = afterLines[i]
          if (ctrl.signal.aborted) break
          const before = clampPauseMs(line.pauseBefore)
          if (before) await sleep(before, ctrl.signal)
          if (ctrl.signal.aborted) break
          const audio = this.cbs.onLine(line, i)
          const dur = Math.round(bubbleDuration(line.text) / deliverySpeed(line.delivery))
          await lineWait(dur, audio, ctrl.signal)
          if (ctrl.signal.aborted) break
          const after = clampPauseMs(line.pauseAfter)
          if (after) await sleep(after, ctrl.signal)
          if (ctrl.signal.aborted) break
          if (i < afterLines.length - 1) {
            this.cbs.onLineEnd(line.speaker)
            await sleep(gap, ctrl.signal)
          }
        }
      }
      if (!ctrl.signal.aborted) {
        this.ctrl = null
        this.cbs.onDone()
      }
    })()
  }

  /** 从抉择点继续:播指定分支 */
  resume(branchId: string) {
    this.choiceWaiter?.(branchId)
    this.choiceWaiter = null
  }

  private choiceWaiter: ((branchId: string) => void) | null = null

  stop() {
    this.choiceWaiter?.('__aborted__')
    this.choiceWaiter = null
    this.ctrl?.abort()
    this.ctrl = null
  }
}
