// Phase 7 portability UI (plan 07 items 1, 2, 5) through the real App with
// injected MemoryStorage: import flow (counts, corrupt file, newer-version
// refusal, orphan session placeholder), share-sheet export delivery with
// lastExportAt recording, and the beforeinstallprompt-driven install button.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import App from '../App.svelte'
import type { CapabilityReport } from '../../core/capabilities/capabilities'
import { MemoryStorage } from '../../core/storage/memory-storage'
import { SCHEMA_VERSION, type ExportEnvelope } from '../../core/storage/schema'
import { makeCourse, makeSession } from '../../core/storage/storage-contract'

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

const text = () => container.textContent ?? ''
const waitForText = (needle: string) => vi.waitFor(() => expect(text()).toContain(needle))

function mountApp(storage: MemoryStorage) {
  instance = mount(App, {
    target: container,
    props: {
      check: () => Promise.resolve(passingReport),
      createStorage: () => storage,
    },
  })
}

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`)
  return button
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!button) throw new Error(`no button with aria-label ${JSON.stringify(label)}`)
  return button
}

function importFile(content: string, name = 'export.json'): void {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no import file input')
  const transfer = new DataTransfer()
  transfer.items.add(new File([content], name, { type: 'application/json' }))
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function makeEnvelope(overrides: Partial<ExportEnvelope> = {}): ExportEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: '2026-07-12T18:00:00.000Z',
    courses: [],
    settings: { speechEnabled: true },
    sessions: [],
    ...overrides,
  }
}

beforeEach(() => {
  history.replaceState(null, '', location.pathname + location.search)
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (instance) {
    void unmount(instance)
    instance = undefined
  }
  container.remove()
  Reflect.deleteProperty(navigator, 'canShare')
  Reflect.deleteProperty(navigator, 'share')
  vi.restoreAllMocks()
})

describe('import flow (Home + MemoryStorage)', () => {
  it('merges a valid export, reports counts, and shows the imported course', async () => {
    const storage = new MemoryStorage()
    mountApp(storage)
    await waitForText('Courses')

    const envelope = makeEnvelope({
      courses: [makeCourse({ id: 'c-imp', name: 'Imported loop' })],
      sessions: [
        makeSession({ id: 's-imp', courseId: 'c-imp' }),
        // Orphan: courseId matches nothing even after the merge.
        makeSession({ id: 's-orph', courseId: 'ghost-course' }),
      ],
    })
    importFile(JSON.stringify(envelope, null, 2))

    await waitForText('Added 1 course and 2 sessions; skipped 0 courses and 0 sessions')
    // The refreshed CoursesRepo shows the imported course without a reload.
    await waitForText('Imported loop')

    // The orphan session renders with the "unknown course" placeholder.
    location.hash = '#/session/s-orph'
    await waitForText('Unknown course')
  })

  it('reports skip counts on re-import (idempotent merge)', async () => {
    const storage = new MemoryStorage()
    await storage.saveCourses({
      courses: [makeCourse({ id: 'c-imp', name: 'Imported loop' })],
      settings: { speechEnabled: true },
    })
    mountApp(storage)
    await waitForText('Imported loop')

    const envelope = makeEnvelope({
      courses: [makeCourse({ id: 'c-imp', name: 'Imported loop' })],
      sessions: [makeSession({ id: 's-new', courseId: 'c-imp' })],
    })
    importFile(JSON.stringify(envelope))

    await waitForText('Added 0 courses and 1 session; skipped 1 course and 0 sessions')
  })

  it('shows a friendly error for a file that is not a valid export', async () => {
    mountApp(new MemoryStorage())
    await waitForText('Courses')

    importFile('this is { not json')

    await waitForText('Not a valid export file')
  })

  it('refuses a newer-version export with the update-the-app message', async () => {
    mountApp(new MemoryStorage())
    await waitForText('Courses')

    importFile(JSON.stringify({ ...makeEnvelope(), schemaVersion: SCHEMA_VERSION + 1 }))

    await waitForText('update the app')
  })
})

describe('export delivery (Home + patched Web Share API)', () => {
  function patchShare(share: (data: { files: File[] }) => Promise<void>): void {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
  }

  it('delivers via the share sheet and records lastExportAt', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    patchShare(share)
    const storage = new MemoryStorage()
    await storage.saveCourses({
      courses: [makeCourse({ id: 'c-1', name: 'Garage loop' })],
      settings: { speechEnabled: true },
    })
    mountApp(storage)
    await waitForText('Garage loop')

    buttonByLabel('Export').click()

    await waitForText('Exported chronowhoop-export-')
    expect(share).toHaveBeenCalledTimes(1)
    await vi.waitFor(async () => {
      const { settings } = await storage.loadCourses()
      expect(settings.lastExportAt).toBeDefined()
    })
  })

  it('skips the lastExportAt recording in a read-only tab (the write would only pollute lastError)', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    patchShare(share)
    // Structural read-only marker — the same shape OpfsStorage exposes when
    // another tab holds the writer lock.
    const storage = Object.assign(new MemoryStorage(), { readOnly: true })
    await storage.saveCourses({
      courses: [makeCourse({ id: 'c-1', name: 'Garage loop' })],
      settings: { speechEnabled: true },
    })
    mountApp(storage)
    await waitForText('Garage loop')

    buttonByLabel('Export').click()

    await waitForText('Exported chronowhoop-export-')
    expect(text()).not.toContain('Storage error')
    const { settings } = await storage.loadCourses()
    expect(settings.lastExportAt).toBeUndefined()
  })

  it('records nothing when the user cancels the share sheet', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('canceled', 'AbortError'))
    patchShare(share)
    const storage = new MemoryStorage()
    await storage.saveCourses({
      courses: [makeCourse({ id: 'c-1', name: 'Garage loop' })],
      settings: { speechEnabled: true },
    })
    mountApp(storage)
    await waitForText('Garage loop')

    buttonByLabel('Export').click()

    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(text()).not.toContain('Exported chronowhoop-export-')
    const { settings } = await storage.loadCourses()
    expect(settings.lastExportAt).toBeUndefined()
  })
})

describe('install button (beforeinstallprompt)', () => {
  it('appears when the event fires, prompts on click, then hides', async () => {
    mountApp(new MemoryStorage())
    await waitForText('Courses')
    expect(text()).not.toContain('Install app')

    const prompt = vi.fn().mockResolvedValue(undefined)
    window.dispatchEvent(
      Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt }),
    )

    await waitForText('Install app')
    buttonByText('Install app').click()

    expect(prompt).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(text()).not.toContain('Install app'))
  })
})
