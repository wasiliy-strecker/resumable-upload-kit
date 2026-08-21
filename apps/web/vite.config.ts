import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), '')
  const proxyTarget = environment.API_PROXY_TARGET ?? 'http://127.0.0.1:3000'

  return {
    build: { target: 'es2022' },
    plugins: [react()],
    server: {
      proxy: {
        '/health': { target: proxyTarget },
        '/uploads': { target: proxyTarget },
      },
    },
  }
})
