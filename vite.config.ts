import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri 集成：保留终端输出、固定端口（与 tauri.conf.json 的 devUrl 对应）
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // 忽略 src-tauri,否则 Windows 下 Vite 会 watch Rust 构建产物(被锁的 dll)导致 EBUSY。
    // 用函数而非 glob:chokidar v4(vite 8)已不再支持 glob 字符串
    watch: {
      ignored: (path: string) => path.includes('src-tauri'),
    },
  },
})
