import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

const browserTests = ['src/**/*.browser.test.ts']
const webgpuTests = ['src/**/*.webgpu.test.ts']

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
      {
        test: {
          name: 'browser',
          include: browserTests,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        test: {
          name: 'browser-webkit',
          include: browserTests,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'webkit' }],
          },
        },
      },
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
