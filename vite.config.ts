import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'

function buildId(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'prompt',
      devOptions: { enabled: false },
      workbox: {
        // .cwclip: the bundled fixture clip the /lab self-test fetches — it
        // must be precached so the self-test works in the installed PWA
        // offline.
        globPatterns: ['**/*.{js,css,html,svg,ico,cwclip}'],
      },
      manifest: {
        name: 'ChronoWhoop',
        short_name: 'ChronoWhoop',
        description: 'Camera-based tiny-whoop lap timer',
        display: 'standalone',
        theme_color: '#0a0e13',
        background_color: '#0a0e13',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
})
