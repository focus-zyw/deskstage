// 设置窗口侧的跨窗口桥:设置窗独立 WebView 后,所有"触碰应用其余部分"的回调
// 都走 emitTo('main') 事件,不再持有主窗任何对象。groupSend 需要受理结果,
// 用 requestId + 回执事件做一次应答式往返(超时按 busy 兜底)。
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { inTauri } from '../storage/configStore'
import type { SettingsBridge } from './useSettingsSession'

/** 设置窗动作统一入口的事件名(main 侧 bridgeServer 监听) */
export const SETTINGS_ACTION_EVENT = 'settings-action'
export const SETTINGS_REPLY_EVENT = 'settings-action-reply'
export const SETTINGS_CLOSED_EVENT = 'settings-closed'
export const APP_EXIT_REQUEST_EVENT = 'app-exit-request'

/** 关闭设置窗:窗口预建于启动时,这里只隐藏不销毁(WebView2 复用,再开秒出) */
export async function hideSettingsWindow(): Promise<void> {
  if (!inTauri) return
  await emit(SETTINGS_CLOSED_EVENT)
  await getCurrentWindow().hide()
}

/** 设置窗请求退出整个应用(走主窗的退出确认流程) */
export async function requestAppExit(): Promise<void> {
  if (!inTauri) return
  await emit(APP_EXIT_REQUEST_EVENT)
}

interface PendingReply {
  resolve: (result: 'accepted' | 'busy' | 'empty') => void
  timer: number
}

export function createEventBridge(): SettingsBridge {
  if (!inTauri) {
    // 浏览器原型/测试环境:动作无处投递,静默吞掉
    const noop = () => {}
    return {
      onReplay: noop,
      onResetLayout: noop,
      onResetC: noop,
      onPrivacyTip: noop,
      onSupportThanks: noop,
      onGroupSend: async () => 'empty',
    }
  }
  const pending = new Map<string, PendingReply>()
  void listen<{ requestId: string; result: 'accepted' | 'busy' | 'empty' }>(
    SETTINGS_REPLY_EVENT,
    (e) => {
      const p = pending.get(e.payload.requestId)
      if (!p) return
      window.clearTimeout(p.timer)
      pending.delete(e.payload.requestId)
      p.resolve(e.payload.result)
    },
  )
  return {
    onReplay: (ep) => void emitTo('main', SETTINGS_ACTION_EVENT, { kind: 'replay', episode: ep }),
    onResetLayout: () => void emitTo('main', SETTINGS_ACTION_EVENT, { kind: 'reset-layout' }),
    onResetC: () => void emitTo('main', SETTINGS_ACTION_EVENT, { kind: 'reset-c' }),
    onPrivacyTip: () => void emitTo('main', SETTINGS_ACTION_EVENT, { kind: 'privacy-tip' }),
    onSupportThanks: (content) => void emitTo('main', SETTINGS_ACTION_EVENT, { kind: 'support-thanks', content }),
    onGroupSend: (text) =>
      new Promise((resolve) => {
        const requestId = `gs${Date.now()}${Math.random().toString(36).slice(2, 8)}`
        const timer = window.setTimeout(() => {
          pending.delete(requestId)
          resolve('busy') // 应答式往返超时:按忙碌兜底,不让设置页卡死
        }, 4000)
        pending.set(requestId, { resolve, timer })
        void emitTo('main', SETTINGS_ACTION_EVENT, { kind: 'group-send', text, requestId })
      }),
  }
}
