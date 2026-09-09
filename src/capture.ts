// ShareX 式截屏流程(主窗口侧):
// 触发(工具栏/快捷键)→ 隐藏主窗 260ms → Rust 冻结主屏为 PNG → 打开全屏框选覆盖窗
// → 覆盖窗松开鼠标时 Rust 裁剪并写系统剪贴板 → 覆盖窗销毁后恢复主窗。
// 角色排除双保险:主窗启动即被 WDA_EXCLUDEFROMCAPTURE 系统级排除(设置可关),
// 抓屏前的隐藏在 WDA 关闭时兜底,保证角色绝不进画面。

import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { register, unregister } from '@tauri-apps/plugin-global-shortcut'
import { getConfig } from './storage/configStore'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const OVERLAY_LABEL = 'capture'

let running = false
let registeredHotkey = ''

/** 截屏主流程。失败抛错由调用方决定反馈方式(工具栏按钮出气泡,快捷键走 console) */
export async function startScreenshot(): Promise<void> {
  if (running) return
  running = true
  const main = getCurrentWindow()
  try {
    // 冻结抓屏前把主窗收起:角色不进画面。WDA 开启时是双保险,关闭时是唯一兜底
    await main.hide()
    let path: string
    try {
      await sleep(260) // 等 DWM 合成完,避免拍到收起瞬间的残影
      path = await invoke<string>('capture_screen')
    } catch (e) {
      await main.show().catch(() => {})
      throw e
    }

    // 残留覆盖窗(上次异常退出)先清掉,否则同 label 建窗会失败
    const stale = (await WebviewWindow.getAll()).find((w) => w.label === OVERLAY_LABEL)
    if (stale) await stale.destroy().catch(() => {})

    // 全屏交给系统 fullscreen:true:逻辑尺寸换算在多 DPI 下不可靠。
    // 覆盖窗内部用 innerWidth 与图像宽的比值做坐标换算,不受窗口实际 DPI 影响
    const overlay = new WebviewWindow(OVERLAY_LABEL, {
      url: `index.html?capture=1&p=${encodeURIComponent(path)}`,
      fullscreen: true,
      decorations: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      shadow: false,
      focus: true,
      title: '截屏框选',
    })
    overlay.once('tauri://destroyed', () => {
      void main.show().catch(() => {})
      running = false
    })
    // running 保持 true 直到覆盖窗销毁,期间不重复触发
  } catch (e) {
    running = false
    throw e
  }
}

/** 应用设置里的截屏快捷键:换绑全局快捷键(启用才注册)。启动与保存设置后各调一次 */
export async function applyScreenshotHotkey(): Promise<void> {
  try {
    const cfg = await getConfig()
    const hk = cfg.screenshot.enabled ? cfg.screenshot.hotkey.trim() : ''
    if (hk === registeredHotkey) return
    if (registeredHotkey) await unregister(registeredHotkey).catch(() => {})
    registeredHotkey = ''
    if (hk) {
      await register(hk, (event) => {
        if (event.state === 'Pressed') void startScreenshot().catch((e) => console.warn('[capture] 截屏失败', e))
      })
      registeredHotkey = hk
    }
  } catch (e) {
    console.warn('[capture] 快捷键注册失败(可能被其他程序占用)', e)
  }
}
