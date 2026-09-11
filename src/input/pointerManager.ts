// 穿透管理器：
// - 默认整个窗口忽略鼠标事件（点击直接落到下层应用）
// - Rust 侧轮询全局光标并推送位置；角色/工具栏由原生钩子拦截并合成 DOM 事件
// - 只有输入面板需要恢复 WebView 交互；移出后恢复穿透。
// - 窗口为全屏透明覆盖层：角色可在屏幕任意位置显示/缩放，
//   除已注册区域外全部穿透，不影响日常操作。
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window'
import { LogicalSize, LogicalPosition } from '@tauri-apps/api/dpi'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

export interface HitRegion {
  getRect: () => DOMRect
  /** 输入框等需要键盘焦点的区域才允许激活全屏透明窗口。 */
  activatesWindow?: boolean
  /** Windows 角色热区：由系统钩子接管，WebView 本身继续保持整窗穿透。 */
  nativePointerTarget?: () => HTMLElement | null
}

interface NativePointerRegion {
  id: string
  left: number
  top: number
  right: number
  bottom: number
}

interface NativePointerPayload {
  kind: 'down' | 'up' | 'wheel'
  id: string
  x: number
  y: number
  deltaY: number
}

const regions = new Map<string, HitRegion>()
const subs = new Set<(id: string | null) => void>()
let interactive: boolean | null = null
let hovered: string | null = null
let winOrigin = { x: 0, y: 0 } // 窗口左上角的物理像素坐标
let scale = 1
let initialized = false
// 截屏框选模式:整窗恢复交互并暂停穿透切换(画布铺满全屏,热区判定无意义)
let captureMode = false
// Tauri 在 Windows 上切换 WS_EX_TRANSPARENT 时会重写扩展窗口样式，连带清掉
// Rust 侧设置的 WS_EX_NOACTIVATE；记住期望值，并在每次穿透切换后重新应用。
let noActivate = true
let nativeRegionSnapshot = ''
let nativeCapture: {
  id: string
  target: Element
  startX: number
  startY: number
} | null = null
const nativePointerEnabled =
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

async function applyNoActivate(): Promise<void> {
  await invoke('set_noactivate', { enable: noActivate }).catch(() => {})
}

/** 设置窗口是否禁止激活；穿透状态变化后会自动保持该策略。 */
export function setWindowNoActivate(enable: boolean): void {
  if (enable === noActivate) return
  noActivate = enable
  void applyNoActivate()
}

/** 截屏框选模式开关(App 在渲染 CaptureOverlay 期间开启,结束后关闭) */
export function setCaptureMode(on: boolean): void {
  captureMode = on
  setWindowNoActivate(!on)
  void setInteractive(on).catch(() => {})
}

/** 注册一个可命中区域（角色、按钮等），返回注销函数 */
export function registerHitRegion(id: string, region: HitRegion): () => void {
  regions.set(id, region)
  syncNativePointerRegions()
  return () => {
    regions.delete(id)
    syncNativePointerRegions()
  }
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
  // 必须在 setIgnoreCursorEvents 之后：Windows 后端会覆盖 NOACTIVATE 样式位。
  await applyNoActivate()
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

function toClientPoint(px: number, py: number) {
  return {
    x: (px - winOrigin.x) / scale,
    y: (py - winOrigin.y) / scale,
  }
}

function nativeRegions(): NativePointerRegion[] {
  if (!nativePointerEnabled) return []
  const result: NativePointerRegion[] = []
  for (const [id, region] of regions) {
    if (!region.nativePointerTarget) continue
    const rect = region.getRect()
    result.push({
      id,
      left: Math.floor(winOrigin.x + rect.left * scale),
      top: Math.floor(winOrigin.y + rect.top * scale),
      right: Math.ceil(winOrigin.x + rect.right * scale),
      bottom: Math.ceil(winOrigin.y + rect.bottom * scale),
    })
  }
  return result
}

function syncNativePointerRegions(): void {
  const native = nativeRegions()
  const snapshot = JSON.stringify(native)
  if (snapshot === nativeRegionSnapshot) return
  nativeRegionSnapshot = snapshot
  void invoke('set_native_pointer_regions', { regions: native }).catch(() => {})
}

function dispatchNativePointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  px: number,
  py: number,
): void {
  const point = toClientPoint(px, py)
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
    }),
  )
}

function nativeTargetAt(root: HTMLElement, px: number, py: number): Element {
  const point = toClientPoint(px, py)
  const hit = document.elementFromPoint(point.x, point.y)
  return hit && root.contains(hit) ? hit : root
}

function onNativePointer(payload: NativePointerPayload): void {
  if (payload.kind === 'down') {
    const root = regions.get(payload.id)?.nativePointerTarget?.()
    if (!root) return
    const target = nativeTargetAt(root, payload.x, payload.y)
    nativeCapture = {
      id: payload.id,
      target,
      startX: payload.x,
      startY: payload.y,
    }
    dispatchNativePointer(target, 'pointerdown', payload.x, payload.y)
    return
  }
  if (payload.kind === 'up') {
    if (!nativeCapture || nativeCapture.id !== payload.id) return
    const capture = nativeCapture
    dispatchNativePointer(capture.target, 'pointerup', payload.x, payload.y)
    // 合成的 pointerdown/up 不会让浏览器自动再合成 click；短按时显式补发，
    // 才能保持工具栏 button 的 onClick 语义。拖动则绝不能误触按钮。
    if (
      Math.hypot(payload.x - capture.startX, payload.y - capture.startY) < 6 * scale &&
      !(capture.target instanceof HTMLButtonElement && capture.target.disabled)
    ) {
      const point = toClientPoint(payload.x, payload.y)
      capture.target.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
        }),
      )
    }
    nativeCapture = null
    syncNativePointerRegions()
    return
  }
  const root = regions.get(payload.id)?.nativePointerTarget?.()
  if (!root) return
  const target = nativeTargetAt(root, payload.x, payload.y)
  const point = toClientPoint(payload.x, payload.y)
  target.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      deltaY: payload.deltaY,
    }),
  )
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
    // 屏幕原点或 DPI 改变后，同一个 DOMRect 对应的物理坐标已经不同。
    nativeRegionSnapshot = ''
    syncNativePointerRegions()
  }
  void win.onMoved(() => void recomputeOrigin())
  void win.onScaleChanged(() => void recomputeOrigin())

  if (nativePointerEnabled) {
    await listen<NativePointerPayload>('native-pointer', (e) => onNativePointer(e.payload))
    syncNativePointerRegions()
  }

  await listen<[number, number]>('cursor-pos', (e) => {
    if (captureMode) return // 框选期间整窗可交互,不做穿透切换
    const [px, py] = e.payload
    if (nativeCapture) dispatchNativePointer(nativeCapture.target, 'pointermove', px, py)
    syncNativePointerRegions()
    const id = hitTest(px, py)
    if (id !== hovered) {
      // 角色/按钮/面板外点击都不应抢走底层视频焦点；只有输入面板本体允许激活。
      setWindowNoActivate(!(id && regions.get(id)?.activatesWindow))
      hovered = id
      subs.forEach((fn) => fn(id))
    }
    const nativeHit = Boolean(id && nativePointerEnabled && regions.get(id)?.nativePointerTarget)
    // 原生热区由系统钩子拦截时，透明 WebView 始终保持整窗穿透，避免底层视频合成停顿。
    void setInteractive(id !== null && !nativeHit)
  })
}
