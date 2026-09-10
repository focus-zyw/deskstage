// 设置即存队列:字段变更合并进待存包,immediate 立即冲刷,否则防抖到期一次性落盘。
// 面板高频输入(文本域逐键)不会逐键写盘;离散操作(开关/下拉)立即落盘,
// 且顺带带走已排队字段(与原 App.tsx 内联管线语义一致:合并的是"待存包",不是整份配置)。
// 纯逻辑、无 React/无 DOM 依赖,可被 node 测试直接驱动。

export type SettingsSavePack = Record<string, unknown>

export interface SettingsSaveQueue {
  /** 字段即存入口:immediate=true 立即冲刷(开关/下拉等离散操作),否则防抖合并(文本输入) */
  save(partial: SettingsSavePack, immediate?: boolean): Promise<void>
  /** 立即冲刷待存包(无待存内容时空转) */
  flush(): Promise<void>
  /** 丢弃待存包并取消挂起的防抖(窗口卸载时防"迟到落盘") */
  dispose(): void
  /** 是否有待存字段或挂起的防抖 */
  pending(): boolean
}

export function createSettingsSaveQueue(
  commit: (partial: SettingsSavePack) => Promise<void> | void,
  debounceMs = 400,
): SettingsSaveQueue {
  let pending: SettingsSavePack = {}
  let timer: ReturnType<typeof setTimeout> | null = null

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (Object.keys(pending).length === 0) return
    const pack = pending
    pending = {}
    await commit(pack)
  }

  return {
    async save(partial, immediate = false) {
      pending = { ...pending, ...partial }
      if (immediate) return flush()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void flush()
      }, debounceMs)
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = {}
    },
    pending() {
      return timer !== null || Object.keys(pending).length > 0
    },
  }
}
