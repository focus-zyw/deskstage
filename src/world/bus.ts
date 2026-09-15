// 世界模型 · 事件总线:同步订阅列表,emit 时逐个回调,订阅异常互相隔离。
// 为什么不做消息队列/异步分发:消费者都是本进程内的轻量判定(闸门/主动行为触发),
// 同步语义反而可测、无乱序;监听返回退订函数,由调用方在卸载时清理。

export interface WorldBus<T> {
  subscribe(fn: (event: T) => void): () => void
  emit(event: T): void
}

export function createBus<T>(): WorldBus<T> {
  const listeners = new Set<(event: T) => void>()
  return {
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    emit(event) {
      for (const fn of [...listeners]) {
        try {
          fn(event)
        } catch {
          // 单个消费者异常不拖垮其他消费者,也不打断采样循环
        }
      }
    },
  }
}
