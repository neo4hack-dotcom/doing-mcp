import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      // 127.0.0.1 (not "localhost") so the Node proxy never depends on DNS
      // resolution of the hostname — avoids `getaddrinfo ENOTFOUND localhost`.
      '/api': 'http://127.0.0.1:3001',
    },
  },
})
