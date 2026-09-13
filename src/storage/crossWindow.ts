// 跨窗口 store 变更通知:设置窗口拆分后,设置窗可写的共享 store(气泡主题/自定义模式/
// 记忆等)落盘后需让主窗强制重读,否则主窗快照滞留旧值。config 走专用 config-changed
// 通道,不经过这里。
import { emitTo } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { inTauri } from './configStore'

/** 设置窗写入共享 store 后调用;主窗收到 store-changed 后按注册表刷新对应 store */
export function notifyMainStoreChanged(store: string): void {
  if (!inTauri) return
  if (getCurrentWindow().label !== 'settings') return
  void emitTo('main', 'store-changed', { store }).catch(() => {})
}
