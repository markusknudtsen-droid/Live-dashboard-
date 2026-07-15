import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.DASHBOARD_API_PROXY_TARGET || 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
