// 截屏框选层(渲染在主窗内,主窗临时切到可交互模式):
// 冻结的主屏画面铺满全屏 + 变暗遮罩,鼠标拖出选区(边框+尺寸提示)。
// 松手不出结果,停在原地弹出工具条(保存/提取文字/翻译/复制✓/取消✕):
// - 复制/提取文字/翻译 → Rust 裁剪写入剪贴板(识字与翻译的 OCR 链路读剪贴板)→ onDone 带动作
// - 保存 → 系统"另存为"对话框选路径 → Rust 写 PNG;对话框点取消留在工具条,可改选其他动作
// - ✕/Esc 取消并清理冻结临时文件;工具条出现后再拖拽 = 重新框选
// 坐标换算:窗口 CSS 像素 × (图像宽 / 窗口宽) = 图像物理像素,裁剪在 Rust 侧完成。

import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { join, pictureDir } from '@tauri-apps/api/path'
import { save } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import { ExtractTextIcon, SaveIcon, TranslateIcon } from './stage/icons'

const MIN_SELECT_PX = 8 // CSS 像素:小于此视为误点,取消
const BORDER_PX = 2

/** 工具条动作;copy = 只进剪贴板(原"松手即复制"的能力) */
export type CaptureAction = 'copy' | 'save' | 'ocr' | 'translate'

/** 另存对话框默认文件名:截图-YYYYMMDD-HHMMSS.png(本地时间) */
function shotFileName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `截图-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`
}

export function CaptureOverlay({
  path,
  onDone,
}: {
  path: string
  onDone: (ok: boolean, action?: CaptureAction, savedPath?: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  // 松手定型的选区:rect(CSS 像素)供工具条定位,crop(物理像素)供 Rust 裁剪;null = 还在框选
  const [picked, setPicked] = useState<{
    rect: { x: number; y: number; w: number; h: number }
    crop: { x: number; y: number; width: number; height: number }
  } | null>(null)
  const actingRef = useRef(false) // 动作已发出,防重复点击

  /** 工具条动作落定:复制/识字/翻译先裁剪进剪贴板,保存走另存对话框 */
  async function act(action: CaptureAction) {
    if (!picked || actingRef.current) return
    actingRef.current = true
    try {
      if (action === 'save') {
        let dir: string | null = null
        try {
          dir = await pictureDir()
        } catch {
          // 拿不到图片目录就让对话框落到它自己的默认位置
        }
        const target = await save({
          title: '保存截图',
          defaultPath: dir ? await join(dir, shotFileName()) : shotFileName(),
          filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        })
        if (!target) {
          actingRef.current = false // 取消对话框:留在工具条,可改选其他动作
          return
        }
        await invoke('capture_save', { ...picked.crop, path: target })
        doneRef.current(true, 'save', target)
      } else {
        await invoke('capture_finish', picked.crop)
        doneRef.current(true, action)
      }
    } catch (e) {
      console.warn('[capture] 工具条动作失败', action, e)
      if (action === 'save') {
        actingRef.current = false // 保存失败留在工具条,可重试或取消
      } else {
        doneRef.current(false)
      }
    }
  }

  /** 取消框选:丢弃冻结临时图,恢复底下状态 */
  function cancel() {
    if (actingRef.current) return
    void invoke('capture_cleanup').catch(() => {})
    doneRef.current(false)
  }

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
      if (e.button !== 0 || e.target !== canvas) return // 工具条上的按下不算重新框选
      e.preventDefault()
      setPicked(null) // 出过工具条后再拖 = 重新框选
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
    const onMouseUp = () => {
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
      // 停在工具条态:等用户选动作,不在松手时写剪贴板
      setPicked({
        rect: { x: Math.min(sel.ax, sel.bx), y: Math.min(sel.ay, sel.by), w, h },
        crop: { x, y, width, height },
      })
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        void invoke('capture_cleanup').catch(() => {})
        finish(false)
      }
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
        void invoke('capture_cleanup').catch(() => {})
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

  // 工具条贴选区右下;贴边自动上翻/收进(尺寸与下方样式里的按钮布局保持一致)
  const TB_W = 5 * 32 + 4 * 6 + 6 * 2 + 9 // 按钮 + 间距 + 内边距 + 分隔线
  const TB_H = 32 + 6 * 2
  let tx = 8
  let ty = 8
  if (picked) {
    tx = picked.rect.x + picked.rect.w - TB_W
    if (tx < 8) tx = 8
    ty = picked.rect.y + picked.rect.h + 8
    if (ty + TB_H > window.innerHeight - 8) ty = picked.rect.y - TB_H - 8
    if (ty < 8) ty = 8
  }

  return (
    <>
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
      {picked && (
        <div
          style={{
            position: 'fixed',
            left: tx,
            top: ty,
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: 6,
            background: 'rgba(20,20,28,0.92)',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
          }}
        >
          <button className="cap-tool" title="保存到文件夹…" onClick={() => void act('save')}>
            <SaveIcon />
          </button>
          <button className="cap-tool" title="提取文字" onClick={() => void act('ocr')}>
            <ExtractTextIcon />
          </button>
          <button className="cap-tool" title="翻译" onClick={() => void act('translate')}>
            <TranslateIcon />
          </button>
          <button className="cap-tool" title="复制到剪贴板" onClick={() => void act('copy')}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>✓</span>
          </button>
          <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.18)' }} />
          <button className="cap-tool" title="取消 (Esc)" onClick={cancel}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>✕</span>
          </button>
        </div>
      )}
    </>
  )
}
