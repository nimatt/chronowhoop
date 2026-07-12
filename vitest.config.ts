import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { playwright } from '@vitest/browser-playwright'

const browserTests = ['src/**/*.browser.test.ts']
const webgpuTests = ['src/**/*.webgpu.test.ts']

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
// injects. The unit and webgpu projects are plain TS and don't.
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

// Chromium flags that make WebGPU work in TRUE headless mode with the
// software (SwiftShader) backend — i.e. on machines and CI runners with no
// real GPU. The Vulkan-on-SwiftShader trio is what actually yields a software
// adapter; `--enable-unsafe-swiftshader` is the documented CI guard that keeps
// the software adapter available across Chromium versions. Verified locally in
// true headless Playwright Chromium; findings recorded in
// docs/plans/01-foundation.notes.md.
const swiftshaderWebGpuArgs = [
  '--enable-unsafe-swiftshader',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
]

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: [...browserTests, ...webgpuTests],
        },
      },
      browserProject('browser', 'chromium'),
      browserProject('browser-webkit', 'webkit'),
      {
        test: {
          name: 'webgpu',
          include: webgpuTests,
          browser: {
            enabled: true,
            provider: playwright({ launchOptions: { args: swiftshaderWebGpuArgs } }),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
