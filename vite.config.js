import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  // host 必须写死 127.0.0.1：默认的 localhost 在 Node 17+ 上可能只解析到 ::1，
  // Vite 就只绑 IPv6，而 plugin.json 的 development.main 是 http://127.0.0.1:5180，
  // uTools 按 IPv4 拉页面会直接被拒 → 界面全白。改端口/地址时两处要一起改。
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome132',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2048
  }
})
