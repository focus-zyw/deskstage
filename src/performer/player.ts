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
  /** 中止(手动停止/被新播放顶掉/停在选择点):上报真实开播过的台词前缀;自然播完不触发 */
  onStopped?: (played: DialogLine[]) => void
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
  /** 抉择暂停期的控制器:暂停时 this.ctrl 让位为 null(守卫按空闲处理),
   *  但 stop() 仍须真正 abort 它——否则停止后恢复逻辑会把僵尸控制器赋回
   *  this.ctrl,onDone 误触发且 playing 永久为真(直到下一次 play) */
  private pausedCtrl: AbortController | null = null
  private cbs: PlayerCallbacks
  /** 本次播放中真实开播过的台词(开播即计入,中止时按前缀上报) */
  private played: DialogLine[] = []
  /** 流式播放的在途迭代器:stop() 时 best-effort return()(generator finally
   *  释放网页会话等后台资源),UI 清场不等待它 */
  private streamIterator: AsyncGenerator<DialogLine, unknown, void> | null = null

  constructor(cbs: PlayerCallbacks) {
    this.cbs = cbs
  }

  get playing(): boolean {
    return this.ctrl !== null
  }

  /** 逐句节奏(公共辅法):句前蓄势 → 开播 → 最短可读 → 闭嘴 → 句尾留白 →
   *  非末句的句间 gap。返回 false = 中止(播放循环按前缀上报退出) */
  private async playOne(
    line: DialogLine,
    index: number,
    ctrl: AbortController,
    opts: { gap: number; isLast: boolean; endLine?: boolean },
  ): Promise<boolean> {
    // 句前蓄势:包袱抖出来之前先停一拍,停顿本身就是笑点的一部分
    const before = clampPauseMs(line.pauseBefore)
    if (before) await sleep(before, ctrl.signal)
    if (ctrl.signal.aborted) return false
    // 推进时机由语音层决定(语音真正结束/纯文本估时);最短可读时间防气泡闪烁
    this.played.push(line)
    const { speechPhase } = this.cbs.onLineStart(line, index)
    await Promise.all([speechPhase, sleep(MIN_READABLE_MS, ctrl.signal)])
    if (ctrl.signal.aborted) return false
    // 声音一停立即闭嘴;气泡与听者反应留进句尾留白,响底包袱有笑的时间
    this.cbs.onSpeechEnd(line.speaker)
    const after = clampPauseMs(line.pauseAfter)
    if (after) await sleep(after, ctrl.signal)
    if (ctrl.signal.aborted) return false
    // 最后一句跳过 onLineEnd:气泡定格给观众笑的时间(收底拍由 onDone 侧统一清理);
    // endLine:false = 调用方(流式)自己等 lookahead 后决定是否清气泡
    if (!opts.isLast && opts.endLine !== false) {
      this.cbs.onLineEnd(line.speaker)
      await sleep(opts.gap, ctrl.signal)
    }
    return !ctrl.signal.aborted
  }

  /** 播放一段脚本；重复调用会先停掉上一段(其 onStopped 会先同步触发)。
   *  choice+after 同时提供时:播完 before 后触发 onChoice 暂停,
   *  等 resume(branchId) 继续 */
  play(
    lines: DialogLine[],
    opts: { gap?: number; choice?: ChoicePoint; after?: Record<string, DialogLine[]> } = {},
  ) {
    this.stop()
    this.played = []
    const ctrl = new AbortController()
    this.ctrl = ctrl
    const gap = opts.gap ?? 400
    void (async () => {
      if (lines.length > 0) this.cbs.onStart?.(lines[0])
      for (let i = 0; i < lines.length; i++) {
        const keep = await this.playOne(lines[i], i, ctrl, {
          gap,
          isLast: i === lines.length - 1,
        })
        if (!keep) break
      }
      // 观众抉择点:暂停推进,窗体侧弹按钮;resume(branchId) 后播对应分支
      if (!ctrl.signal.aborted && opts.choice && opts.after) {
        this.pausedCtrl = ctrl
        this.ctrl = null // 暂停期间视作非播放态(守卫按空闲处理)
        this.cbs.onChoice?.(opts.choice)
        const branchId = await new Promise<string>((resolve) => {
          this.choiceWaiter = resolve
        })
        this.pausedCtrl = null
        // 停止于抉择点(waiter 收到 __aborted__):播放权不再恢复,守卫保持空闲、onDone 不触发
        if (ctrl.signal.aborted) return
        this.ctrl = ctrl
        const afterLines = branchId === '__aborted__' ? [] : opts.after[branchId] ?? []
        if (afterLines.length > 0) this.cbs.onStart?.(afterLines[0])
        for (let i = 0; i < afterLines.length; i++) {
          const keep = await this.playOne(afterLines[i], i, ctrl, {
            gap,
            isLast: i === afterLines.length - 1,
          })
          if (!keep) break
        }
      }
      if (!ctrl.signal.aborted) {
        this.ctrl = null
        this.cbs.onDone()
      }
    })()
  }

  /** 流式播放(多 AI 剧场):逐句消费异步生成器,单句 lookahead——
   *  播当前句时立即恢复 generator(下一句的网页请求已在飞),等下一句期间
   *  当前气泡保留;确认 done 才把当前句当最后一句(不清气泡,onSourceEnd
   *  先于 onDone 交还生成结果供提交语义定 naturalness)。
   *  停止契约:stop() 立即同步 onStopped(已播前缀),iterator.return() 是
   *  best-effort 异步尾随(UI 不等待;generator finally 负责后台释放会话)。
   *  首句之前 source 抛错 → onSourceError(played 为空,调用方回退兜底) */
  playStream<TResult>(
    source: AsyncGenerator<DialogLine, TResult, void>,
    opts: {
      gap?: number
      /** 已在播放器外产出的第一句(relay 的 prepareRelay 交付) */
      initial?: DialogLine
      onSourceEnd?(result: TResult): void
      onSourceError?(error: unknown, played: DialogLine[]): void
    } = {},
  ) {
    this.stop()
    this.played = []
    const ctrl = new AbortController()
    this.ctrl = ctrl
    this.streamIterator = source
    const gap = opts.gap ?? 400
    const { onSourceEnd, onSourceError } = opts
    void (async () => {
      try {
        let current: DialogLine | null = null
        let nextPromise: Promise<IteratorResult<DialogLine, TResult>> | null = null
        if (opts.initial) {
          current = opts.initial
          nextPromise = source.next()
        } else {
          const first = await source.next()
          if (first.done) {
            this.ctrl = null
            this.cbs.onDone()
            return
          }
          current = first.value
          nextPromise = source.next()
        }
        while (current) {
          // 单句 lookahead:立即恢复 generator,下一句的网页请求已在飞
          const followingPromise = nextPromise ?? source.next()
          // endLine:false:是否清当前气泡要等 lookahead 结果(最后一句定格)
          const keep = await this.playOne(current, this.played.length, ctrl, {
            gap,
            isLast: false,
            endLine: false,
          })
          if (!keep) break
          const following = await followingPromise
          if (following.done) {
            this.ctrl = null
            this.streamIterator = null
            onSourceEnd?.(following.value)
            this.cbs.onDone()
            return
          }
          this.cbs.onLineEnd(current.speaker)
          await sleep(gap, ctrl.signal)
          if (ctrl.signal.aborted) break
          current = following.value
          nextPromise = source.next()
        }
        if (!ctrl.signal.aborted) {
          this.ctrl = null
          this.cbs.onDone()
        }
      } catch (e) {
        this.ctrl = null
        this.streamIterator = null
        onSourceError?.(e, [...this.played])
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
    // 确实在播(或停在选择点/流式在途)才上报中止前缀;防御性空停不打扰
    if (this.ctrl !== null || this.choiceWaiter !== null || this.streamIterator !== null) {
      this.cbs.onStopped?.([...this.played])
    }
    this.played = []
    this.choiceWaiter?.('__aborted__')
    this.choiceWaiter = null
    this.pausedCtrl?.abort() // 抉择暂停期 this.ctrl 为 null,真正的控制器在这里 abort
    this.pausedCtrl = null
    this.ctrl?.abort()
    this.ctrl = null
    // 流式收尾:best-effort 异步 return()(generator finally 释放网页会话),
    // UI 清场与停声不等待它
    const it = this.streamIterator
    this.streamIterator = null
    if (it) void it.return(undefined as never).catch(() => {})
  }
}
