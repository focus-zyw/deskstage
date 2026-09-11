// 应用动作的全局快捷键:配置驱动的注册/换绑中心,动作回调由 App 侧登记。
// 为什么必须走 OS 级 global-shortcut:主窗口默认 WS_EX_NOACTIVATE + 鼠标穿透,
// 平时不持有键盘焦点,窗口内 keydown 收不到按键(详见 input/pointerManager)。
// 与截屏快捷键(capture.ts)同模式但独立演进;本模块导入期无副作用,可被单测加载。

import { register, unregister, isRegistered } from '@tauri-apps/plugin-global-shortcut'
import { emit } from '@tauri-apps/api/event'
import { getConfig, type HotkeysConfig } from './storage/configStore'

/** 可绑定的动作 id;新增动作 = HotkeysConfig 加一字段 + App 侧 setHotkeyHandler 登记 */
export type HotkeyActionId = keyof HotkeysConfig

/** 动作回调登记表:App 挂载时写入带最新闭包的处理器,快捷键触发时按 id 现查 */
const handlers = new Map<HotkeyActionId, () => void>()

export function setHotkeyHandler(id: HotkeyActionId, fn: () => void): void {
  handlers.set(id, fn)
}

/** 解析期望生效的绑定表(纯函数,单测覆盖)。规则:
 *  空串跳过;同组合键先到先得(后者视为未设置);与截屏快捷键撞车的让位截屏 */
export function resolveHotkeyBindings(
  hotkeys: HotkeysConfig,
  screenshotHotkey: string,
): { shortcut: string; action: HotkeyActionId }[] {
  const norm = (s: string) => s.trim().toUpperCase()
  // 空串占位无碍:循环里空组合键先被跳过,永远撞不到它
  const taken = new Set<string>([norm(screenshotHotkey)])
  const out: { shortcut: string; action: HotkeyActionId }[] = []
  for (const action of Object.keys(hotkeys) as HotkeyActionId[]) {
    const shortcut = norm(hotkeys[action])
    if (!shortcut || taken.has(shortcut)) continue
    taken.add(shortcut)
    out.push({ shortcut, action })
  }
  return out
}

/** 当前已注册的绑定(组合键+动作成对保留,换绑时只动真正变化的) */
let registered: { shortcut: string; action: HotkeyActionId }[] = []

/** 应用设置里的动作快捷键:增量换绑(失效的注销,变化的注册,未变的保留避免同键双回调)。
 *  启动与保存设置后各调一次;单个注册失败不拖垮其余绑定,失败经 hotkey-error 事件出气泡 */
export async function applyAppHotkeys(): Promise<void> {
  try {
    const cfg = await getConfig()
    const desired = resolveHotkeyBindings(cfg.hotkeys, cfg.screenshot.hotkey)
    const same = (a: { shortcut: string; action: HotkeyActionId }, b: typeof a) =>
      a.shortcut === b.shortcut && a.action === b.action
    // 注销失效绑定:组合键被改/清空,或动作对调(动作 id 不同也算失效)
    for (const old of registered) {
      if (!desired.some((d) => same(d, old))) await unregister(old.shortcut).catch(() => {})
    }
    const kept = registered.filter((b) => desired.some((d) => same(d, b)))
    registered = kept
    for (const b of desired) {
      // 动作未登记(App 未挂载/未来新增字段)不注册,免得按了没反应;未变的保留
      if (!handlers.has(b.action) || kept.some((k) => same(k, b))) continue
      try {
        await register(b.shortcut, (event) => {
          if (event.state === 'Pressed') handlers.get(b.action)?.()
        })
        registered.push(b)
      } catch (e) {
        // register 抛错未必真失败:dev 热重载会清空 JS 账本但 OS 注册还在,两次换绑
        // 并发也会撞车——此时 isRegistered 为真说明本应用已持有,实际在生效,不报错
        if (await isRegistered(b.shortcut).catch(() => false)) {
          registered.push(b)
        } else {
          console.warn(`[hotkeys] ${b.action} 的 ${b.shortcut} 注册失败(可能被其他程序占用)`, e)
          void emit('hotkey-error', { action: b.action, shortcut: b.shortcut }).catch(() => {})
        }
      }
    }
  } catch (e) {
    console.warn('[hotkeys] 快捷键换绑失败', e)
  }
}
