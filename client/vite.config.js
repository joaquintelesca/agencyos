import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBase = env.VITE_API_URL || 'http://localhost:3001'

  return {
    plugins: [react()],
    server: {
      port: 3000,
      host: true,
      allowedHosts: 'all',
      proxy: {
        '/api': { target: apiBase, changeOrigin: true },
        '/uploads': { target: apiBase, changeOrigin: true },
        '/socket.io': { target: apiBase, ws: true, changeOrigin: true }
      }
    }
  }
})
