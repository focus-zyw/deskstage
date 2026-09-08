// 同一文件的写操作串行化:消除"读-改-写"并发时后写覆盖前写的竞态
// (如快速连点收藏、拖动保存与设置保存同时发生)。
// 单实例应用,按逻辑文件名的内存 promise 队列即可;不做跨进程文件锁。

const queues = new Map<string, Promise<unknown>>()

/** 把 fn 排到该文件队列尾,前一个操作成功/失败都不阻塞后续 */
export function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(file) ?? Promise.resolve()
  const next = prev.then(
    () => fn(),
    () => fn(),
  )
  // 队列里存吞掉错误的版本,避免 unhandled rejection 污染后续排队者
  queues.set(
    file,
    next.catch(() => undefined),
  )
  return next
}
