import { defineConfig, type PluginOption } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'

export default defineConfig(({ command }) => {
  const plugins: PluginOption[] = [tailwindcss(), tsConfigPaths(), tanstackStart()]

  // Only load nitro for production builds (Railway) — dev uses standard Vite dev server
  if (command === 'build') {
    plugins.push(nitro())
  }

  return {
    plugins,
    server: {
      allowedHosts: true,
    },
  }
})
