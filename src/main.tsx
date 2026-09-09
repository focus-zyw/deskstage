import { createRoot } from 'react-dom/client'
import './index.css'

// 框选覆盖窗与主应用共用 index.html,按 query 分流:
// index.html?capture=1&p=<冻结图路径> → 截屏框选覆盖窗;否则主应用。
// 不用 StrictMode:避免开发模式下 effect 双执行导致原生窗口 API 重复初始化
const root = createRoot(document.getElementById('root')!)

if (new URLSearchParams(window.location.search).has('capture')) {
  void import('./CaptureOverlay').then(({ CaptureOverlay }) => {
    root.render(<CaptureOverlay />)
  })
} else {
  void import('./App').then(({ default: App }) => {
    root.render(<App />)
  })
}
