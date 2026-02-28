import { defineConfig, type PluginOption } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [tailwindcss(), tsConfigPaths(), tanstackStart(), react()] as PluginOption[],
  server: {
    allowedHosts: true,
  },
})

