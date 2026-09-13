// 诊断跨窗桥 · 主窗侧:诊断环在主窗(埋点发生地),设置窗的「链路诊断」分页
// 经这里增量同步。三条通路:
//   · push:订阅 diag store 的 dirty 队列,emitTo('settings','diag-upsert') 增量推送
//     (store 内部已做 1s 尾随节流,会话结束即时推);
//   · snapshot:设置窗打开面板时发 settings-action('diag-snapshot'),这里回全量;
//   · action:详情捕获开关(diag-arm)与清空(diag-clear)从设置窗回传。
// 只在主窗装配一次(bridgeServer);顺带把使用者称呼同步给脱敏层。

import { emitTo, listen } from '@tauri-apps/api/event'
import { setDiagUpsert, getDiagSnapshot, armDetail, disarmDetail, clearDiag, getDetailState } from './store'
import { setKnownUserName } from './redact'
import { getConfigSnapshot, subscribeConfig } from '../storage/configStore'

export const DIAG_UPSERT_EVENT = 'diag-upsert'

/** 主窗装配:推送 + 动作受理;返回卸载函数 */
export function initDiagBridgeServer(): Promise<unknown[]> {
  // 脱敏上下文:使用者称呼随配置差分刷新(掩码 [USER_NAME] 用)
  let prevName = ''
  const syncName = () => {
    const name = getConfigSnapshot().userProfile?.userName ?? ''
    if (name !== prevName) {
      prevName = name
      setKnownUserName(name)
    }
  }
  syncName()
  subscribeConfig(syncName)

  setDiagUpsert((payload) => {
    void emitTo('settings', DIAG_UPSERT_EVENT, payload).catch(() => {})
  })
  return Promise.all([
    listen('diag-snapshot', () => {
      // 应答走同一 upsert 事件,full = 整环替换
      void emitTo('settings', DIAG_UPSERT_EVENT, { full: true, sessions: getDiagSnapshot().sessions }).catch(() => {})
    }),
    listen('diag-arm', (e) => {
      const p = e.payload as { disarm?: boolean; once?: boolean; minutes?: number; rawText?: boolean } | undefined
      if (p?.disarm) disarmDetail()
      else armDetail({ once: p?.once, minutes: p?.minutes, rawText: p?.rawText })
      void emitTo('settings', DIAG_UPSERT_EVENT, { full: true, sessions: getDiagSnapshot().sessions, detail: getDetailState() }).catch(() => {})
    }),
    listen('diag-clear', () => {
      clearDiag()
    }),
  ])
}
