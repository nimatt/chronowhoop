import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Precache-completeness check (plan 07 item 4, automated half): the app must
// work fully offline after first load, so the built service worker's precache
// manifest has to cover the entire shell — a missing entry only surfaces in
// the field as an installed PWA that breaks in airplane mode.
//
// Runs against build output and therefore SKIPS when dist/sw.js is absent
// (`bun run test` normally runs before `build`). CI runs it explicitly after
// the build via `bun run test:precache` (ci.yml check job) with
// PRECACHE_REQUIRED=1, which turns a missing build into a FAILURE — a skip
// there would read as green while gating nothing. Locally:
// `bun run build && bun run test:precache`.

const swPath = fileURLToPath(new URL('../../dist/sw.js', import.meta.url))
const hasBuild = existsSync(swPath)
const buildRequired = process.env.PRECACHE_REQUIRED === '1'

// The generated sw.js inlines the Workbox manifest as a JS literal:
// precacheAndRoute([{url:"…",revision:…}, …], …). Keys are unquoted, so the
// entries are harvested with a scoped regex instead of JSON.parse.
function precachedUrls(): string[] {
  const source = readFileSync(swPath, 'utf8')
  const manifest = /precacheAndRoute\(\[(.*?)\]\s*,/s.exec(source)
  if (!manifest) throw new Error('dist/sw.js contains no precacheAndRoute manifest')
  return Array.from(manifest[1].matchAll(/url\s*:\s*"([^"]+)"/g), (match) => match[1])
}

describe.skipIf(!hasBuild && !buildRequired)('service worker precache manifest (dist/sw.js)', () => {
  it('covers the app shell, bundles, fixture clip, web manifest, and icons', () => {
    if (!hasBuild) {
      throw new Error(
        'PRECACHE_REQUIRED=1 but dist/sw.js is missing — run `bun run build` before `bun run test:precache`',
      )
    }
    const urls = precachedUrls()

    // The shell: SPA fallback route target + the built JS/CSS bundles.
    expect(urls).toContain('index.html')
    expect(urls.filter((url) => url.endsWith('.js')).length).toBeGreaterThanOrEqual(1)
    expect(urls.filter((url) => url.endsWith('.css')).length).toBeGreaterThanOrEqual(1)

    // The bundled fixture clip the /lab self-test replays — it must work in
    // the installed PWA offline (vite.config.ts globPatterns).
    expect(urls.filter((url) => url.endsWith('.cwclip')).length).toBeGreaterThanOrEqual(1)

    // Installability: manifest + every icon it declares.
    expect(urls).toContain('manifest.webmanifest')
    for (const icon of [
      'icons/icon-192.png',
      'icons/icon-512.png',
      'icons/icon-maskable-512.png',
    ]) {
      expect(urls).toContain(icon)
    }
  })
})
