import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/talk/',
  optimizeDeps: {
    exclude: ['@ricky0123/vad-web'],
  },
})
