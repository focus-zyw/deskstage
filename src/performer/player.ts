// 演出队列：顺序消费一段对话脚本，由语音生命周期驱动节奏，可随时中止。
// LLM 生成的 dialog 数组与硬编码脚本走同一条路；
// 台词可带演出信息(停顿/听者动作/语气),节奏由喜剧时机决定而不只是字数。
// 类型与清洗集中在 dialogSchema(唯一事实源),这里只管播放。

import { clampPauseMs, type ChoicePoint, type DialogLine, type Speaker } from './dialogSchema'

export type { DialogLine, Delivery, Speaker, ChoicePoint, ChoiceOption } from './dialogSchema'

/** 气泡显示时长(纯文本回退节奏用):基础 1.2s + 每字 160ms */
export function bubbleDuration(text: string): number {
  return 1200 + text.length * 160
}

/** 气泡最短可读时间:有语音时也至少展示这么久,防止气泡闪烁 */
export const MIN_READABLE_MS = 600

/** 首声截止:超时取消本句 TTS 按纯文本播,不允许迟到语音突然插入 */
export const FIRST_AUDIO_DEADLINE_MS = 1200

/** 首声结果 → 本句呈现计划:气泡恒显示(回退分支也绝不丢台词);
 *  超时需取消 TTS;静音/超时按纯文本估时推进,正常出声则由语音结束驱动 */
export function planLinePresentation(
  res: 'audible' | 'silent' | 'timeout',
  estimateMs: number,
): { stopTts: boolean; textDurationMs: number | null } {
  if (res === 'timeout') return { stopTts: true, textDurationMs: estimateMs }
  if (res === 'silent') return { stopTts: false, textDurationMs: estimateMs }
  return { stopTts: false, textDurationMs: null }
}

/** 一句台词的推进阶段 */
export interface LinePhase {
  /** 声音该停的时机:语音真正结束,或纯文本估时走完 */
  speechPhase: Promise<void>
}

export interface PlayerCallbacks {
  /** 发起一句:启动 TTS 并安排 UI(气泡/说话动作在首帧声音出现时同步上屏;
   *  静音或首声超时按纯文本节奏)。返回本句的推进阶段 */
  onLineStart: (line: DialogLine, index: number) => LinePhase
  /** 声音结束:立即停说话动作(闭嘴);气泡保留进句尾留白 */
  onSpeechEnd: (speaker: Speaker) => void
  /** 句尾留白结束:清气泡 */
  onLineEnd: (speaker: Speaker) => void
  /** 整段播完（自然结束，非 stop） */
  onDone: () => void
  /** 播放到观众抉择点:暂停推进,等 resume(branchId) 继续 */
  onChoice?: (choice: ChoicePoint) => void
  /** 脚本/分支开播:预取第一句语音,消除首句文字先行 */
  onStart?: (first: DialogLine) => void
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
      if (lines.length > 0) this.cbs.onStart?.(lines[0])
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (ctrl.signal.aborted) break
        // 句前蓄势:包袱抖出来之前先停一拍,停顿本身就是笑点的一部分
        const before = clampPauseMs(line.pauseBefore)
        if (before) await sleep(before, ctrl.signal)
        if (ctrl.signal.aborted) break
        // 推进时机由语音层决定(语音真正结束/纯文本估时);最短可读时间防气泡闪烁
        const { speechPhase } = this.cbs.onLineStart(line, i)
        await Promise.all([speechPhase, sleep(MIN_READABLE_MS, ctrl.signal)])
        if (ctrl.signal.aborted) break
        // 声音一停立即闭嘴;气泡与听者反应留进句尾留白,响底包袱有笑的时间
        this.cbs.onSpeechEnd(line.speaker)
        const after = clampPauseMs(line.pauseAfter)
        if (after) await sleep(after, ctrl.signal)
        if (ctrl.signal.aborted) break
        // 最后一句跳过 onLineEnd:气泡定格给观众笑的时间(收底拍由 onDone 侧统一清理)
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
        if (afterLines.length > 0) this.cbs.onStart?.(afterLines[0])
        for (let i = 0; i < afterLines.length; i++) {
          const line = afterLines[i]
          if (ctrl.signal.aborted) break
          const before = clampPauseMs(line.pauseBefore)
          if (before) await sleep(before, ctrl.signal)
          if (ctrl.signal.aborted) break
          const { speechPhase } = this.cbs.onLineStart(line, i)
          await Promise.all([speechPhase, sleep(MIN_READABLE_MS, ctrl.signal)])
          if (ctrl.signal.aborted) break
          this.cbs.onSpeechEnd(line.speaker)
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
