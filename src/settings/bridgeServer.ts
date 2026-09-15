// 主窗侧的设置桥服务端:监听设置窗发来的动作(回放/复位/群聊发送等)与退出/关闭信号。
// 配置保存不再经过这里:两个窗口都经 Rust 统一状态中心(config_service)读写,
// 进程锁串行化 + config-changed 广播。主窗对配置变化的响应(快捷键换绑/捕获排除/
// 环境轮询/人设采纳)统一由 initConfigEffects 差分驱动——写者无关,任何来源的
// 保存(设置窗/主窗功能/未来预览)都汇入同一条快照流。
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import {
  getConfigSnapshot,
  subscribeConfig,
  type AppConfig,
} from '../storage/configStore'
import {
  setCEnabled,
  setCharacterGenders,
  setCharacterNames,
  setPersonaOverride,
} from '../engine/persona'
import { startWorld, stopWorld } from '../world'
import { applyScreenshotHotkey } from '../capture'
import { applyAppHotkeys } from '../hotkeys'
import type { SettingsBridge } from './useSettingsSession'
import { initDiagBridgeServer } from '../diag/bridge'
import { cancelDiscovery, maybeRestockTopicCandidates } from '../topic/discovery'

/** 配置副作用:差分驱动。快照每次发布都与上一版逐字段比对,变化的才触发——
 *  首次回调只建立基线(启动初始化仍由各模块自行完成,避免双跑) */
export function initConfigEffects(): void {
  let prev: AppConfig | null = null
  subscribeConfig(() => {
    const next = getConfigSnapshot()
    const base = prev
    prev = next
    if (!base) return
    if (base.hotkeys !== next.hotkeys || base.screenshot.hotkey !== next.screenshot.hotkey) {
      void applyScreenshotHotkey() // 快捷键按新配置换绑
      void applyAppHotkeys() // 演出动作快捷键同理换绑
    }
    if (base.screenshot.hideSelf !== next.screenshot.hideSelf) {
      void invoke('set_capture_excluded', { enable: next.screenshot.hideSelf }).catch(() => {})
    }
    // 环境感知或久坐提醒任一开启都需要轮询(久坐依赖键鼠空闲传感器,与环境感知解耦)
    if (base.envSense !== next.envSense || base.breakReminder !== next.breakReminder) {
      if (next.envSense || next.breakReminder.enabled) startWorld()
      else stopWorld()
    }
    if (base.persona !== next.persona || base.personaSource !== next.personaSource) {
      const p = next.persona // 空串 = 还原内置人设(persona 模块内回落)
      setPersonaOverride(p.a, p.b, p.c, next.personaSource)
    }
    if (base.characters !== next.characters) {
      setCEnabled(next.characters.C.enabled !== false) // C 关闭/开启即时采纳(新演出与话题包同步收窄)
    }
    if (base.topicPrefs !== next.topicPrefs) {
      // AI 扩充开关的副作用收口在配置提交之后(此处读到的已是新配置,无保存竞态):
      // 开→尝试补货;关→中止在途请求(中止不计失败、不进冷却)
      const wasOn = base.topicPrefs.sources.aiGenerated
      const on = next.topicPrefs.sources.aiGenerated
      if (!wasOn && on) void maybeRestockTopicCandidates()
      if (wasOn && !on) cancelDiscovery()
    }
    if (base.names !== next.names) setCharacterNames(next.names.a, next.names.b, next.names.c)
    if (base.genders !== next.genders) setCharacterGenders(next.genders.a, next.genders.b, next.genders.c) // 性别纪律立即采纳
  })
}

export interface SettingsBridgeServerRefs {
  /** bridge 随渲染重建,用 getter 拿最新实例,监听只注册一次 */
  getBridge(): SettingsBridge
  /** 设置窗请求退出整个程序 */
  onExitRequest(): void
  /** 设置窗已自隐藏(主窗同步开关态,工具栏按钮才能正确切换) */
  onClosed(): void
}

/** 初始化主窗侧监听与配置副作用;返回卸载函数(App 卸载时清理) */
export function initSettingsBridgeServer(refs: SettingsBridgeServerRefs): Promise<UnlistenFn[]> {
  initConfigEffects()
  void initDiagBridgeServer().catch(() => {}) // 诊断推送/动作受理:失败不影响主桥
  return Promise.all([
    listen<{
      kind: 'replay' | 'reset-layout' | 'reset-c' | 'privacy-tip' | 'support-thanks' | 'group-send' | 'clear-chatlog'
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
        void bridge
          .onGroupSend(p.text)
          .then((result) =>
            emitTo('settings', 'settings-action-reply', { requestId: p.requestId, result }).catch(() => {}),
          )
      }
      if (p.kind === 'clear-chatlog' && p.requestId) {
        void Promise.resolve(bridge.onClearChatlog?.() ?? undefined)
          .catch(() => undefined)
          .then(() => emitTo('settings', 'settings-action-reply', { requestId: p.requestId, result: 'accepted' }).catch(() => {}))
      }
    }),
    listen('settings-closed', () => refs.onClosed()),
    listen('app-exit-request', () => refs.onExitRequest()),
  ])
}
