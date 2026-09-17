// 桌面浮层面板的尺寸记忆:localStorage 键 vc-panel-size-{key}。拖拽右下角手柄调整
// 宽高,松手落盘,下次打开保持。clamp 最小 320×220,最大视口 92%×86%(拖拽时实时算,
// 跨显示器拖动也不会跑出屏)。
import { useCallback, useState } from 'react'

export interface PanelSize {
  w: number
  h: number
}

const PREFIX = 'vc-panel-size-'
export const PANEL_MIN: PanelSize = { w: 320, h: 220 }

function clampSize(s: PanelSize): PanelSize {
  const maxW = Math.max(PANEL_MIN.w, Math.round(window.innerWidth * 0.92))
  const maxH = Math.max(PANEL_MIN.h, Math.round(window.innerHeight * 0.86))
  return {
    w: Math.min(Math.max(Math.round(s.w), PANEL_MIN.w), maxW),
    h: Math.min(Math.max(Math.round(s.h), PANEL_MIN.h), maxH),
  }
}

export function loadPanelSize(key: string): PanelSize | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return null
    const p = JSON.parse(raw) as PanelSize
    if (typeof p?.w !== 'number' || typeof p?.h !== 'number' || !Number.isFinite(p.w) || !Number.isFinite(p.h)) return null
    return clampSize(p)
  } catch {
    return null
  }
}

function persist(key: string, s: PanelSize): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(clampSize(s)))
  } catch {
    /* ignore */
  }
}

/** 面板尺寸 + 右下角拖拽手柄逻辑:pointer capture 全程跟手,松手落盘。
 *  size 为 null = 从未调整过,面板吃 CSS 默认尺寸(宽度/max-height) */
export function usePanelSize(key: string, def: PanelSize): {
  size: PanelSize | null
  gripDown: (e: React.PointerEvent) => void
  resizing: boolean
} {
  const [size, setSize] = useState<PanelSize | null>(() => loadPanelSize(key))
  const [resizing, setResizing] = useState(false)
  // 拖拽中途 size 通过 setState 实时更新;startRef 锚定拖拽起点,避免闭包读旧值
  const gripDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const el = e.currentTarget as HTMLElement
      el.setPointerCapture(e.pointerId)
      const base = size ?? def
      const startX = e.clientX
      const startY = e.clientY
      setResizing(true)
      const onMove = (ev: PointerEvent) => {
        setSize(clampSize({ w: base.w + (ev.clientX - startX), h: base.h + (ev.clientY - startY) }))
      }
      const onUp = (ev: PointerEvent) => {
        try {
          el.releasePointerCapture(ev.pointerId)
        } catch {
          /* capture 已随元素释放 */
        }
        window.removeEventListener('pointermove', onMove)
        setResizing(false)
        setSize((final) => {
          if (final) persist(key, final)
          return final
        })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, { once: true })
    },
    [key, size, def],
  )
  return { size, gripDown, resizing }
}
