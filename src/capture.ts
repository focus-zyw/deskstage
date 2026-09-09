// ShareX 式截屏流程(主窗口侧):
// 触发(工具栏/快捷键)→ 隐藏主窗 260ms → Rust 冻结主屏为 PNG → 打开全屏框选覆盖窗
// → 覆盖窗松开鼠标时 Rust 裁剪并写系统剪贴板 → 覆盖窗销毁后恢复主窗。
// 角色排除双保险:主窗启动即被 WDA_EXCLUDEFROMCAPTURE 系统级排除(设置可关),
// 抓屏前的隐藏在 WDA 关闭时兜底,保证角色绝不进画面。

import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { appDataDir, join } from '@tauri-apps/api/path'
import { mkdir } from '@tauri-apps/plugin-fs'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { register, unregister } from '@tauri-apps/plugin-global-shortcut'
import { getConfig } from './storage/configStore'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const OVERLAY_LABEL = 'capture'

/** 把截屏失败原因送到主窗气泡(调试与用户反馈两用) */
function reportError(e: unknown): void {
  const msg = String((e as Error)?.message ?? e).slice(0, 80)
  console.warn('[capture] 截屏失败:', msg)
  void emit('capture-error', msg).catch(() => {})
}

let running = false
let registeredHotkey = ''

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
      await sleep(120) // 主窗先回来,覆盖窗马上盖上去
    }

    // 残留覆盖窗(上次异常退出)先清掉,否则同 label 建窗会失败
    const stale = (await WebviewWindow.getAll()).find((w) => w.label === OVERLAY_LABEL)
    if (stale) await stale.destroy().catch(() => {})

    // 覆盖窗用独立数据目录:主窗配了 additionalBrowserArgs,WebView2 规定
    // browser args 不同的 WebView 必须使用不同数据目录,否则创建报 0x8007139F
    const base = await appDataDir()
    const dataDirectory = await join(base, 'data', 'capture-webview')
    await mkdir(dataDirectory, { recursive: true }).catch(() => {})

    // 全屏交给系统 fullscreen:true 会在 Windows 上导致 WebView2 创建失败
    // (0x8007139F,实测),改用主窗口的 screen 逻辑尺寸铺满(同显示器,无换算问题);
    // 覆盖窗内部用 innerWidth 与图像宽的比值做坐标换算,不受 DPI 影响
    const overlay = new WebviewWindow(OVERLAY_LABEL, {
      url: `index.html?capture=1&p=${encodeURIComponent(path)}`,
      x: 0,
      y: 0,
      width: window.screen.width,
      height: window.screen.height,
      decorations: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      shadow: false,
      focus: true,
      title: '截屏框选',
      dataDirectory,
    })
    overlay.once('tauri://error', (e) => {
      reportError(`覆盖窗创建失败:${String((e as { payload?: unknown })?.payload ?? e)}`)
      if (hidden) void main.show().catch(() => {})
      running = false
    })
    overlay.once('tauri://destroyed', () => {
      if (hidden) void main.show().catch(() => {})
      running = false
    })
    // 创建看门狗:创建失败时 error/destroyed 事件都可能不触发(wry 层失败只写日志),
    // running 若卡死会让之后所有截屏点击被早退吞掉,5 秒未建窗就强制解锁
    window.setTimeout(() => {
      if (running) {
        if (hidden) void main.show().catch(() => {})
        running = false
        reportError('覆盖窗创建超时')
      }
    }, 5000)
  } catch (e) {
    if (hidden) await main.show().catch(() => {})
    running = false
    reportError(e)
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
