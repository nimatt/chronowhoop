import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { playwright } from '@vitest/browser-playwright'

const browserTests = ['src/**/*.browser.test.ts']

// Component browser tests mount the real App.svelte, which reaches UpdateBanner
// → src/ui/pwa.svelte.ts → `virtual:pwa-register`. That virtual module only
// exists when VitePWA is loaded, and the browser projects deliberately don't
// load it (no service worker in the test server). Stub it with a no-op
// registration so the component tree mounts without pulling in the PWA plugin.
function stubPwaRegister(): Plugin {
  const virtualId = 'virtual:pwa-register'
  const resolvedId = '\0virtual:pwa-register'
  return {
    name: 'chronowhoop:stub-pwa-register',
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined
    },
    load(id) {
      return id === resolvedId ? 'export function registerSW() { return () => Promise.resolve() }' : undefined
    },
  }
}

// Browser-mode projects run against real .svelte components, so they need the
// svelte compiler and the build-time `__BUILD_ID__` define that the app build
// injects. The unit project is plain TS and doesn't.
function browserProject(name: string, browser: 'chromium' | 'webkit') {
  return {
    plugins: [stubPwaRegister(), svelte()],
    define: { __BUILD_ID__: JSON.stringify('test') },
    test: {
      name,
      include: browserTests,
      browser: {
        enabled: true,
        provider: playwright(),
        headless: true,
        instances: [{ browser }],
      },
    },
  }
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: browserTests,
        },
      },
      browserProject('browser', 'chromium'),
      browserProject('browser-webkit', 'webkit'),
    ],
  },
})
