import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // mem0ai OSS 顶层静态 import better-sqlite3(Node 原生模块,webview 无法执行):
      // 桩替换只求"可解析"——运行时我们 disableHistory + 注入自定义 VectorStore,
      // Database 永不被构造(见 src/cold/mem0Memory.ts 顶部注释)
      { find: 'better-sqlite3', replacement: resolve(__dirname, 'src/shims/better-sqlite3.ts') },
    ],
  },
  // 多页构建:主舞台 index.html + 设置窗口 settings.html(tauri.conf 预建的第二 WebView)
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        settings: 'settings.html',
      },
    },
  },
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
