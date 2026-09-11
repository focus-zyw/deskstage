// ShareX 式截屏流程(主窗口侧):
// 触发(工具栏/快捷键)→ [角色排除] → Rust 冻结主屏为 PNG → emit('capture-start')
// → App 把主窗临时切到框选模式(CaptureOverlay 铺满冻结图,拖框)→ capture_finish 裁剪进剪贴板。
//
// 为什么不开第二个窗口:实测三种建窗参数组合都会让 WebView2 报
// 0x8007139F ERROR_INVALID_STATE 建窗失败,复用主窗是最稳的路径。
//
// 角色排除双保险:主窗启动即被 WDA_EXCLUDEFROMCAPTURE 系统级排除(设置可关),
// 抓屏前的隐藏在 WDA 关闭时兜底,保证角色绝不进画面。

import { emit } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { register, unregister, isRegistered } from '@tauri-apps/plugin-global-shortcut'
import { getConfig } from './storage/configStore'
import { setCaptureMode } from './input/pointerManager'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let running = false // 框选进行中(覆盖窗挂在屏上)期间防重复触发

/** 把截屏失败原因送到主窗气泡(调试与用户反馈两用) */
function reportError(e: unknown): void {
  const msg = String((e as Error)?.message ?? e).slice(0, 80)
  console.warn('[capture] 截屏失败:', msg)
  void emit('capture-error', msg).catch(() => {})
}

/** 截屏主流程。失败抛错由调用方决定反馈方式(工具栏按钮出气泡,快捷键走 console) */
export async function startScreenshot(): Promise<void> {
  if (running) return
  running = true
  const main = getCurrentWindow()
  let hidden = false
  try {
    const cfg = await getConfig()
    // hideSelf 开启时角色已被 WDA 系统级排除,主窗不用动;
    // 关闭时才隐藏主窗 260ms 兜底,保证角色不进冻结画面
    if (!cfg.screenshot.hideSelf) {
      await main.hide()
      hidden = true
      await sleep(260) // 等 DWM 合成完,避免拍到收起瞬间的残影
    }
    const path = await invoke<string>('capture_screen')
    if (hidden) {
      await main.show().catch(() => {})
      hidden = false
      await sleep(80)
    }
    // 主窗切框选模式:整窗恢复鼠标交互,App 渲染 CaptureOverlay 铺满冻结图
    setCaptureMode(true)
    await emit('capture-start', path)
  } catch (e) {
    if (hidden) await main.show().catch(() => {})
    reportError(e)
  } finally {
    running = false
  }
}

let registeredHotkey = ''

/** 应用设置里的截屏快捷键:换绑全局快捷键(启用才注册)。启动与保存设置后各调一次 */
export async function applyScreenshotHotkey(): Promise<void> {
  try {
    const cfg = await getConfig()
    const hk = cfg.screenshot.enabled ? cfg.screenshot.hotkey.trim() : ''
    if (hk === registeredHotkey) return
    if (registeredHotkey) await unregister(registeredHotkey).catch(() => {})
    registeredHotkey = ''
    if (hk) {
      try {
        await register(hk, (event) => {
          if (event.state === 'Pressed') void startScreenshot().catch((e) => reportError(e))
        })
      } catch (e) {
        // dev 热重载清空 JS 账本后 OS 注册仍在:isRegistered 为真说明本应用已持有,视作成功
        if (!(await isRegistered(hk).catch(() => false))) throw e
      }
      registeredHotkey = hk
    }
  } catch (e) {
    console.warn('[capture] 快捷键注册失败(可能被其他程序占用)', e)
  }
}
