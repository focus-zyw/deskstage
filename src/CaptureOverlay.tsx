// 截屏框选层(渲染在主窗内,主窗临时切到可交互模式):
// 冻结的主屏画面铺满全屏 + 变暗遮罩,鼠标拖出选区(边框+尺寸提示),
// 松开确认 → Rust 裁剪写入剪贴板 → onDone(true);Esc 取消 → onDone(false)。
// 坐标换算:窗口 CSS 像素 × (图像宽 / 窗口宽) = 图像物理像素,裁剪在 Rust 侧完成。

import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { readFile } from '@tauri-apps/plugin-fs'

const MIN_SELECT_PX = 8 // CSS 像素:小于此视为误点,取消
const BORDER_PX = 2

export function CaptureOverlay({
  path,
  onDone,
}: {
  path: string
  onDone: (ok: boolean) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let bmp: ImageBitmap | null = null
    // 选区:CSS 像素(anchor 起点 + 当前点)
    let sel: { ax: number; ay: number; bx: number; by: number } | null = null
    let dragging = false
    let closed = false

    const finish = (ok: boolean) => {
      if (closed) return
      closed = true
      doneRef.current(ok)
    }

    const draw = () => {
      if (!bmp) return
      ctx.drawImage(bmp, 0, 0)
      if (!sel) return
      const x = Math.min(sel.ax, sel.bx)
      const y = Math.min(sel.ay, sel.by)
      const w = Math.abs(sel.bx - sel.ax)
      const h = Math.abs(sel.by - sel.ay)
      // 选区内恢复原亮度,其余压暗
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y, w, h)
      ctx.clip()
      ctx.drawImage(bmp, 0, 0)
      ctx.restore()
      // 边框 + 尺寸提示
      ctx.strokeStyle = '#4da3ff'
      ctx.lineWidth = BORDER_PX
      ctx.strokeRect(x, y, w, h)
      const label = `${Math.round(w)} × ${Math.round(h)}`
      ctx.font = '13px system-ui, sans-serif'
      const tw = ctx.measureText(label).width + 12
      const lx = x + w - tw > 0 ? x + w - tw : x
      const ly = y > 24 ? y - 24 : y + h + 4
      ctx.fillStyle = 'rgba(20,20,28,0.85)'
      ctx.fillRect(lx, ly, tw, 20)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, lx + 6, ly + 14)
    }

    const toCanvas = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const { x, y } = toCanvas(e)
      sel = { ax: x, ay: y, bx: x, by: y }
      dragging = true
      draw()
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging || !sel) return
      const { x, y } = toCanvas(e)
      sel.bx = x
      sel.by = y
      draw()
    }
    const onMouseUp = async () => {
      if (!dragging || !sel) return
      dragging = false
      const w = Math.abs(sel.bx - sel.ax)
      const h = Math.abs(sel.by - sel.ay)
      if (w < MIN_SELECT_PX || h < MIN_SELECT_PX || !bmp) {
        finish(false) // 误点取消
        return
      }
      const scale = bmp.width / window.innerWidth
      const x = Math.max(0, Math.round(Math.min(sel.ax, sel.bx) * scale))
      const y = Math.max(0, Math.round(Math.min(sel.ay, sel.by) * scale))
      const width = Math.min(bmp.width - x, Math.round(w * scale))
      const height = Math.min(bmp.height - y, Math.round(h * scale))
      try {
        await invoke('capture_finish', { x, y, width, height })
        finish(true)
      } catch (e) {
        console.warn('[capture] 写入剪贴板失败', e)
        finish(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false)
    }
    const onContextMenu = (e: MouseEvent) => e.preventDefault()

    void (async () => {
      try {
        const bytes = await readFile(path)
        bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        canvas.width = bmp.width
        canvas.height = bmp.height
        draw()
      } catch (e) {
        console.warn('[capture] 冻结图加载失败,退出框选', e)
        finish(false)
      }
    })()

    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('contextmenu', onContextMenu)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('contextmenu', onContextMenu)
    }
  }, [path])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 9999,
        display: 'block',
        cursor: 'crosshair',
        background: '#111',
      }}
    />
  )
}
