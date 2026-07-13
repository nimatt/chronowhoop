// Phase 7 Wave C (plan 07 item 8, adapted per the notes): the complete
// product loop as one continuous E2E through the REAL App — create a course
// via the UI, fly a session (fake camera, deterministic injected crossings),
// discard a lap, stop, review the course, export — then a FRESH App over a
// FRESH MemoryStorage (simulating another device) imports the captured file
// and renders the same course/session/records. The vitest browser rig IS the
// E2E harness (ADR 0009 amendment; Playwright proper deliberately not
// introduced): camera via canvas.captureStream behind the mediaDevices seam,
// laps via the injectCrossing seam (exact durations), and the Web Share API
// patched so the exported blob can be captured and re-imported.
//
// Chromium-gated as a whole: the fly leg needs MediaStreamTrackProcessor.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import App from './App.svelte'
import type { CameraMediaDevicesLike } from '../core/camera/camera-service'
import type { CapabilityReport } from '../core/capabilities/capabilities'
import { defaultMediaStreamTrackProcessor } from '../core/detection/capture-support'
import { MemoryStorage } from '../core/storage/memory-storage'
import { SCHEMA_VERSION, type ExportEnvelope } from '../core/storage/schema'
import type { FlySession } from './fly/fly-session'

const passingReport: CapabilityReport = {
  ok: true,
  capabilities: [
    { name: 'webcodecs', label: 'WebCodecs capture (MediaStreamTrackProcessor)', ok: true },
    { name: 'camera', label: 'Camera (getUserMedia)', ok: true },
    { name: 'opfs', label: 'Local storage (OPFS)', ok: true },
    { name: 'speech', label: 'Speech synthesis', ok: true },
  ],
}

let container: HTMLElement
let instance: ReturnType<typeof mount> | undefined
let disposeScene: (() => void) | undefined

const text = () => container.textContent ?? ''
const waitForText = (needle: string) => vi.waitFor(() => expect(text()).toContain(needle))
const normalized = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`)
  return button
}

function linkByText(label: string): HTMLAnchorElement {
  const link = Array.from(container.querySelectorAll('a')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!link) throw new Error(`no link labelled ${JSON.stringify(label)}`)
  return link
}

function query<T extends Element>(selector: string): T {
  const element = container.querySelector<T>(selector)
  if (!element) throw new Error(`no element matching ${selector}`)
  return element
}

// The fly.browser.test.ts quiet scene: frames keep flowing (a single toggling
// pixel keeps the canvas dirty) but no strip ever gets hot, so the real
// detector produces no crossings — laps come only from injectCrossing.
function startQuietScene(): CameraMediaDevicesLike {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')!
  let flip = false
  const draw = () => {
    ctx.fillStyle = '#202020'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = flip ? '#242424' : '#1c1c1c'
    flip = !flip
    ctx.fillRect(0, 0, 1, 1)
  }
  draw()
  const timer = setInterval(draw, 33)
  const stream = canvas.captureStream(30)
  disposeScene = () => {
    clearInterval(timer)
    for (const track of stream.getTracks()) track.stop()
    canvas.remove()
  }
  return { getUserMedia: async () => stream }
}

interface MountAppOptions {
  mediaDevices?: CameraMediaDevicesLike
  onsession?: (session: FlySession) => void
}

// Fresh container per mount so the two "devices" cannot share stray DOM.
async function mountApp(storage: MemoryStorage, options: MountAppOptions = {}): Promise<void> {
  if (instance) await unmount(instance)
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  instance = mount(App, {
    target: container,
    props: {
      check: () => Promise.resolve(passingReport),
      createStorage: () => storage,
      ...options,
    },
  })
}

function importFile(content: string): void {
  const input = query<HTMLInputElement>('input[type="file"]')
  const transfer = new DataTransfer()
  transfer.items.add(new File([content], 'export.json', { type: 'application/json' }))
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeEach(() => {
  history.replaceState(null, '', location.pathname + location.search)
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  if (instance) {
    await unmount(instance)
    instance = undefined
  }
  disposeScene?.()
  disposeScene = undefined
  container.remove()
  Reflect.deleteProperty(navigator, 'canShare')
  Reflect.deleteProperty(navigator, 'share')
  vi.restoreAllMocks()
})

describe.runIf(typeof defaultMediaStreamTrackProcessor() === 'function')(
  'full product loop (real App, MemoryStorage per device, fake camera)',
  () => {
    it(
      'create course → fly → discard → review → export, then import on a fresh device renders identically',
      async () => {
        // ---- Phone leg -------------------------------------------------
        const phoneStorage = new MemoryStorage()
        let session: FlySession | undefined
        await mountApp(phoneStorage, {
          mediaDevices: startQuietScene(),
          onsession: (created) => (session = created),
        })

        // Create the course through the form (defaults: ltr, min lap 3 s).
        await waitForText('create your first course')
        linkByText('New course').click()
        await waitForText('Minimum lap time')
        const nameInput = query<HTMLInputElement>('input[type="text"]')
        nameInput.value = 'Basement 3-gate'
        nameInput.dispatchEvent(new Event('input', { bubbles: true }))
        await vi.waitFor(() => expect(buttonByText('Save').disabled).toBe(false))
        buttonByText('Save').click()

        // Save lands on the (empty) course view.
        await waitForText('All-time records')
        await waitForText('No sessions yet')
        const courseId = /^#\/course\/(.+)$/.exec(location.hash)?.[1]
        if (courseId === undefined) throw new Error(`not on a course view: ${location.hash}`)

        // Fly: start the camera, arm, inject 3 crossings = clock start + 2
        // exact laps (capture-domain timestamps; min lap 3 s never trips).
        linkByText('Fly').click()
        await vi.waitFor(() => expect(session).toBeDefined())
        await waitForText('start the camera')
        buttonByText('Start camera').click()
        await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false), {
          timeout: 15000,
        })
        buttonByText('Arm').click()
        await waitForText('ARMED')

        session!.injectCrossing({ timestampMs: 1000, direction: 'ltr' }) // starts the clock
        await vi.waitFor(() => expect(text()).not.toContain('first crossing starts the clock'))
        session!.injectCrossing({ timestampMs: 15320, direction: 'ltr' }) // lap 1: 14.32
        await waitForText('14.32')
        session!.injectCrossing({ timestampMs: 28650, direction: 'ltr' }) // lap 2: 13.33
        await waitForText('13.33')

        // Discard the most recent lap (13.33), then stop.
        buttonByText('Discard last lap').click()
        await vi.waitFor(() => expect(session!.laps[1]?.status).toBe('discarded'))
        buttonByText('Stop').click()
        await waitForText('Session over')
        await waitForText('Session saved.')

        // Stopped-session table: both laps listed, exact durations, the
        // discarded one struck through; best lap is the surviving 14.32 and
        // no 3-lap window exists.
        const stoppedRows = Array.from(container.querySelectorAll('tbody tr'))
        expect(stoppedRows.length).toBe(2)
        expect(stoppedRows[0].textContent).toContain('14.32')
        expect(stoppedRows[0].textContent).toContain('valid')
        expect(stoppedRows[0].classList.contains('best')).toBe(true)
        expect(stoppedRows[1].textContent).toContain('13.33')
        expect(stoppedRows[1].classList.contains('discarded')).toBe(true)
        expect(query('.records').textContent).toContain('best lap')
        expect(text()).not.toContain('best three consecutive —')
        // Nothing exported yet → the backup nudge fires after the session.
        await waitForText('backed up yet')

        // Review on the course view: the flown session (minus the discarded
        // lap) drives the all-time records and the session list.
        linkByText('Course').click()
        await waitForText('All-time records')
        await waitForText('best 14.32')
        const phoneRecords = normalized(query('.review-columns .records').textContent)
        expect(phoneRecords).toContain('best lap 14.32')
        expect(phoneRecords).toContain('best 3 consecutive —') // discard breaks the window
        const phoneSessionItem = normalized(query('.sessions li').textContent)
        expect(phoneSessionItem).toContain('1 lap')
        expect(phoneSessionItem).toContain('(1 discarded)')
        expect(phoneSessionItem).toContain('best 14.32')

        // Export from Home, capturing the delivered file through the Web
        // Share seam (the share sheet is the product path on phones).
        linkByText('Courses').click()
        await waitForText('Tiny-whoop lap timer')
        await waitForText('Basement 3-gate')
        let sharedFile: File | undefined
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: (data: { files: File[] }) => {
            sharedFile = data.files[0]
            return Promise.resolve()
          },
        })
        buttonByText('Export data').click()
        await waitForText('Exported chronowhoop-export-')
        expect(sharedFile).toBeDefined()
        const exportedText = await sharedFile!.text()

        // A delivered export records lastExportAt (retracting future nudges).
        await vi.waitFor(async () => {
          expect((await phoneStorage.loadCourses()).settings.lastExportAt).toBeDefined()
        })

        // The captured file is the cross-device contract — assert it exactly.
        const envelope = JSON.parse(exportedText) as ExportEnvelope
        expect(envelope.schemaVersion).toBe(SCHEMA_VERSION)
        expect(envelope.courses.map(({ name, direction, minLapTimeMs }) => ({ name, direction, minLapTimeMs }))).toEqual([
          { name: 'Basement 3-gate', direction: 'ltr', minLapTimeMs: 3000 },
        ])
        expect(envelope.courses[0].id).toBe(courseId)
        expect(envelope.sessions.length).toBe(1)
        expect(envelope.sessions[0].courseId).toBe(courseId)
        expect(envelope.sessions[0].laps.map((lap) => [lap.durationMs, lap.status])).toEqual([
          [14320, 'valid'],
          [13330, 'discarded'],
        ])

        // ---- Desktop leg (fresh App over fresh storage) ------------------
        location.hash = '#/'
        const desktopStorage = new MemoryStorage()
        await mountApp(desktopStorage)
        await waitForText('create your first course')

        importFile(exportedText)
        await waitForText('Added 1 course and 1 session; skipped 0 courses and 0 sessions')
        await waitForText('Basement 3-gate')

        // The imported course view renders the same records and session row
        // the phone showed.
        query<HTMLAnchorElement>('.course-link').click()
        await waitForText('All-time records')
        await waitForText('best 14.32')
        expect(normalized(query('.review-columns .records').textContent)).toBe(phoneRecords)
        expect(normalized(query('.sessions li').textContent)).toBe(phoneSessionItem)

        // …and the session view shows the identical lap table.
        query<HTMLAnchorElement>('.sessions li a').click()
        await vi.waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2))
        expect(text()).toContain('Basement 3-gate')
        const importedRows = Array.from(container.querySelectorAll('tbody tr'))
        expect(importedRows[0].textContent).toContain('14.32')
        expect(importedRows[0].classList.contains('best')).toBe(true)
        expect(importedRows[1].textContent).toContain('13.33')
        expect(importedRows[1].classList.contains('discarded')).toBe(true)

        // Re-import on the same device is a clean no-op (idempotent merge).
        location.hash = '#/'
        await waitForText('Export data')
        importFile(exportedText)
        await waitForText('Added 0 courses and 0 sessions; skipped 1 course and 1 session')
      },
      90000,
    )
  },
)
