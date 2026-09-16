// 电脑感知 → 消息通知:世界模型注记按统一间隔以角色气泡告知用户。
// 产品分层(2026-09 裁决):感知通知给用户看;提示词注入(演出/聊天)暂停,
// 待通知形态跑顺后再评估回归——接缝都留在原地(llmClient/ChatSession/worldNote)。
// 统一显示:每 interval 一条通知,多条感知合并为一句(渲染层 join);
// 冷却账本由 worldNote 持有,同一条感知在冷却窗内不重复通知。
// 不合时(勿扰/演出/语音/全屏)时先不取注记:冷却账本不消费,感知不丢、顺延。

export const WORLD_NOTIFY_INTERVAL_MS = 30 * 60_000 // 统一显示节奏:每 30 分钟一条

export interface WorldNotifyDeps {
  /** 取当前待通知注记(调用即消费冷却账本;空 = 没有新感知) */
  getNote(): string | undefined
  /** 通知是否合时(勿扰/演出/语音/全屏中不合;不合时不取注记) */
  allowed(): boolean
  /** 通知出口(角色气泡) */
  say(text: string): void
  clock?: { setInterval(fn: () => void, ms: number): () => void }
}

const defaultClock = {
  setInterval(fn: () => void, ms: number): () => void {
    const id = window.setInterval(fn, ms)
    return () => window.clearInterval(id)
  },
}

export function createWorldNotify(deps: WorldNotifyDeps) {
  let cancel: (() => void) | null = null
  return {
    /** 启动统一显示节奏(幂等);tick 内先验 allowed 再取注记 */
    start(intervalMs = WORLD_NOTIFY_INTERVAL_MS) {
      if (cancel) return
      const clock = deps.clock ?? defaultClock
      cancel = clock.setInterval(() => {
        if (!deps.allowed()) return
        const note = deps.getNote()
        if (note) deps.say(note)
      }, intervalMs)
    },
    stop() {
      cancel?.()
      cancel = null
    },
  }
}
