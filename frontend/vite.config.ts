import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

function frontendChunkName(moduleId: string): string | undefined {
  const normalized = moduleId.replaceAll('\\', '/')
  if (!normalized.includes('/node_modules/')) return undefined
  if (
    normalized.includes('/recharts/')
    || normalized.includes('/d3-')
    || normalized.includes('/victory-vendor/')
    || normalized.includes('/react-smooth/')
  ) return 'charts'
  if (normalized.includes('/lucide-react/')) return 'icons'
  return undefined
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(projectRoot, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: frontendChunkName,
      },
    },
  },
})
