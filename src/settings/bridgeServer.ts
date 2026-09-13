// 主窗侧的设置桥服务端:监听设置窗发来的动作与配置保存请求。
// 配置单写入口:设置窗不再直写 config.json,统一由主窗读-改-写并广播
// config-changed(主窗自己的 saveConfig 也广播),两端快照从此不漂移。
// 请求串行化:设置页连发 config-save 时按序应用,避免交错读改写互相覆盖。
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { saveConfig, type AppConfig } from '../storage/configStore'
import {
  setCharacterGenders,
  setCharacterNames,
  setPersonaOverride,
} from '../engine/persona'
import { startEnvPolling, stopEnvPolling } from '../engine/envAware'
import { applyScreenshotHotkey } from '../capture'
import { applyAppHotkeys } from '../hotkeys'
import { invoke } from '@tauri-apps/api/core'
import type { SettingsBridge } from './useSettingsSession'

/** 主窗代设置窗落盘一批配置并执行关联副作用(原 useSettingsSession.commitSettings 的主窗半边) */
export async function applyRemoteConfigSave(partial: Partial<AppConfig>): Promise<AppConfig> {
  const next = await saveConfig(partial)
  void applyScreenshotHotkey() // 快捷键按新配置换绑
  void applyAppHotkeys() // 演出动作快捷键同理换绑
  void invoke('set_capture_excluded', { enable: next.screenshot.hideSelf }).catch(() => {})
  // 环境感知或久坐提醒任一开启都需要轮询(久坐依赖键鼠空闲传感器,与环境感知解耦)
  if (next.envSense || next.breakReminder.enabled) startEnvPolling()
  else stopEnvPolling()
  if (partial.persona) setPersonaOverride(partial.persona.a, partial.persona.b, partial.persona.c) // 新人设立即采纳
  if (partial.names) setCharacterNames(partial.names.a, partial.names.b, partial.names.c)
  if (partial.genders) setCharacterGenders(partial.genders.a, partial.genders.b, partial.genders.c) // 性别纪律立即采纳
  return next
}

/** 主窗需要即时感知的设置窗写型 store:收到 store-changed 后强制重读磁盘 */
const STORE_REFRESH: Record<string, () => Promise<void>> = {}

/** store 注册自己的跨窗刷新(bubble 工坊/模式工坊/记忆等设置窗可写的 store 调用) */
export function registerStoreRefresh(store: string, refresh: () => Promise<void>): void {
  STORE_REFRESH[store] = refresh
}

export interface SettingsBridgeServerRefs {
  /** bridge 随渲染重建,用 getter 拿最新实例,监听只注册一次 */
  getBridge(): SettingsBridge
  /** 设置窗请求退出整个程序 */
  onExitRequest(): void
  /** 设置窗已自隐藏(主窗同步开关态,工具栏按钮才能正确切换) */
  onClosed(): void
}

/** 初始化主窗侧监听;返回卸载函数(App 卸载时清理) */
export function initSettingsBridgeServer(refs: SettingsBridgeServerRefs): Promise<UnlistenFn[]> {
  // 串行化处理设置窗请求:handler 内部有 await,直接并发会交错读改写
  let task: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = task.then(fn, fn)
    task = next.catch(() => undefined)
    return next
  }
  return Promise.all([
    listen<{
      kind: 'replay' | 'reset-layout' | 'reset-c' | 'privacy-tip' | 'support-thanks' | 'group-send'
      episode?: Parameters<SettingsBridge['onReplay']>[0]
      content?: Parameters<SettingsBridge['onSupportThanks']>[0]
      text?: string
      requestId?: string
    }>('settings-action', (e) => {
      const bridge = refs.getBridge()
      const p = e.payload
      if (p.kind === 'replay' && p.episode) {
        bridge.onReplay(p.episode)
        return
      }
      if (p.kind === 'reset-layout') return void bridge.onResetLayout()
      if (p.kind === 'reset-c') return void bridge.onResetC()
      if (p.kind === 'privacy-tip') return void bridge.onPrivacyTip()
      if (p.kind === 'support-thanks' && p.content) return void bridge.onSupportThanks(p.content)
      if (p.kind === 'group-send' && typeof p.text === 'string' && p.requestId) {
        void serial(async () => {
          const result = await bridge.onGroupSend(p.text!)
          await emitTo('settings', 'settings-action-reply', { requestId: p.requestId, result })
        })
      }
    }),
    listen<Partial<AppConfig>>('config-save', (e) => {
      void serial(async () => {
        const next = await applyRemoteConfigSave(e.payload)
        // 回执同时兼作设置窗的保存完成信号(其 commitSettings 在等它)
        await emitTo('settings', 'config-changed', { config: next })
      })
    }),
    listen('settings-closed', () => refs.onClosed()),
    listen('app-exit-request', () => refs.onExitRequest()),
    // 设置窗写型 store 的跨窗刷新登记(见各 store 的 notifyMainStoreChanged)
    listen<{ store: string }>('store-changed', (e) => {
      STORE_REFRESH[e.payload.store]?.()
    }),
  ])
}
