// 穿透管理器：
// - 默认整个窗口忽略鼠标事件（点击直接落到下层应用）
// - Rust 侧轮询全局光标并推送位置；命中已注册区域时恢复本窗口交互
// - 移出区域后恢复穿透。命中判定在光标轮询侧统一完成，DOM 事件只负责点击。
// - 窗口为全屏透明覆盖层：角色可在屏幕任意位置显示/缩放，
//   除已注册区域外全部穿透，不影响日常操作。
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window'
import { LogicalSize, LogicalPosition } from '@tauri-apps/api/dpi'
import { listen } from '@tauri-apps/api/event'

export interface HitRegion {
  getRect: () => DOMRect
}

const regions = new Map<string, HitRegion>()
const subs = new Set<(id: string | null) => void>()
let interactive = false
let hovered: string | null = null
let winOrigin = { x: 0, y: 0 } // 窗口左上角的物理像素坐标
let scale = 1
let initialized = false
// 截屏框选模式:整窗恢复交互并暂停穿透切换(画布铺满全屏,热区判定无意义)
let captureMode = false

/** 截屏框选模式开关(App 在渲染 CaptureOverlay 期间开启,结束后关闭) */
export function setCaptureMode(on: boolean): void {
  captureMode = on
  void setInteractive(on).catch(() => {})
}

/** 注册一个可命中区域（角色、按钮等），返回注销函数 */
export function registerHitRegion(id: string, region: HitRegion): () => void {
  regions.set(id, region)
  return () => regions.delete(id)
}

/** 订阅命中状态变化，立即回调一次当前值 */
export function onHoverChange(fn: (id: string | null) => void): () => void {
  subs.add(fn)
  fn(hovered)
  return () => subs.delete(fn)
}

async function setInteractive(v: boolean) {
  if (v === interactive) return
  interactive = v
  // true = 忽略鼠标事件（穿透），false = 恢复交互
  await getCurrentWindow().setIgnoreCursorEvents(!v)
}

function hitTest(px: number, py: number): string | null {
  // Rust 推送的是屏幕物理像素，换算成窗口内逻辑坐标后与 DOMRect 比较
  const lx = (px - winOrigin.x) / scale
  const ly = (py - winOrigin.y) / scale
  for (const [id, region] of regions) {
    const r = region.getRect()
    if (lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom) return id
  }
  return null
}

/** 初始化：铺满主显示器并开始监听光标。只需调用一次。 */
export async function initPointerManager() {
  if (initialized) return
  initialized = true
  const win = getCurrentWindow()

  const monitor = await currentMonitor()
  if (monitor) {
    scale = monitor.scaleFactor
    const logicalW = monitor.size.width / scale
    const logicalH = monitor.size.height / scale
    await win.setSize(new LogicalSize(logicalW, logicalH))
    await win.setPosition(new LogicalPosition(0, 0))
  }
  const pos = await win.outerPosition()
  winOrigin = { x: pos.x, y: pos.y }

  await setInteractive(false) // 初始：全窗口穿透
  await win.show() // 定位完成后再显示，避免初始闪烁

  // 显示器布局/DPI 缩放变化时,窗口原点与缩放系数都要重算,
  // 否则热区整体漂移:该穿透的不穿透、该点到的点不到
  const recomputeOrigin = async () => {
    const p = await win.outerPosition()
    winOrigin = { x: p.x, y: p.y }
    const mon = await currentMonitor()
    if (mon) scale = mon.scaleFactor
  }
  void win.onMoved(() => void recomputeOrigin())
  void win.onScaleChanged(() => void recomputeOrigin())

  await listen<[number, number]>('cursor-pos', (e) => {
    if (captureMode) return // 框选期间整窗可交互,不做穿透切换
    const [px, py] = e.payload
    const id = hitTest(px, py)
    if (id !== hovered) {
      hovered = id
      subs.forEach((fn) => fn(id))
    }
    void setInteractive(id !== null)
  })
}
