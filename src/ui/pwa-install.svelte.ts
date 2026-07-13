// Install-flow UI state (plan 07 item 5): captures `beforeinstallprompt`
// (Android / desktop Chromium). The event fires once, early, so the listener
// must be registered at app startup — App.svelte calls initPwaInstall() at
// mount, declaring the registration where startup lives instead of relying
// on Home's import graph (fragile under future code splitting). iOS never
// fires the event; while the capability gate blocks iOS anyway (no
// MediaStreamTrackProcessor), the app simply shows nothing there — no UA
// sniffing (Phase 1 convention).
//
// An installed app must not offer installation: the browser already withholds
// the event in standalone display, and `installedDisplay` belts-and-braces
// that via detectDisplayMode (standalone/fullscreen/minimal-ui all mean the
// app is running installed).

import { detectDisplayMode } from '../core/display-mode'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>
}

function isBeforeInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
  return typeof (event as { prompt?: unknown }).prompt === 'function'
}

let pending = $state<BeforeInstallPromptEvent | null>(null)

const installedDisplay =
  typeof window !== 'undefined' &&
  ['standalone', 'fullscreen', 'minimal-ui'].includes(detectDisplayMode())

let initialized = false

// Idempotent: App mounts more than once across a browser-test file, but the
// window listeners (module state) must register exactly once.
export function initPwaInstall(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    if (isBeforeInstallPromptEvent(event)) pending = event
  })
  window.addEventListener('appinstalled', () => {
    pending = null
  })
}

export const pwaInstall = {
  get available(): boolean {
    return pending !== null && !installedDisplay
  },
  // A BeforeInstallPromptEvent is single-use, so the button hides as soon as
  // the prompt is shown, whatever the user chooses; on acceptance the browser
  // handles installation, on dismissal a fresh event may arrive later.
  async prompt(): Promise<void> {
    const event = pending
    if (event === null) return
    pending = null
    try {
      await event.prompt()
    } catch {
      // A stale or gesture-less prompt() rejects; there is nothing to recover.
    }
  },
}
