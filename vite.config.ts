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
  },
})
