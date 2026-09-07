import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// 不用 StrictMode：避免开发模式下 effect 双执行导致原生窗口 API 重复初始化
createRoot(document.getElementById('root')!).render(<App />)
