// Storage failure/status UI (review follow-up to plan 06): read-only banner,
// a surfaced course-save error, and the app-level quarantine notice — all
// through the real App with injected MemoryStorage variants.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import App from '../App.svelte'
import type { CapabilityReport } from '../../core/capabilities/capabilities'
import type { QuarantineEvent } from '../../core/storage/opfs-storage'
import { MemoryStorage } from '../../core/storage/memory-storage'
import { makeCourse, makeSession } from '../../core/storage/storage-contract'
import { StorageError, type Storage } from '../../core/storage/storage'

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

function mountApp(createStorage: (onQuarantine: (event: QuarantineEvent) => void) => Storage) {
  instance = mount(App, {
    target: container,
    props: {
      check: () => Promise.resolve(passingReport),
      createStorage,
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
})

describe('storage status and failure UI (App + MemoryStorage variants)', () => {
  it('renders the read-only banner for a storage reporting readOnly', async () => {
    class ReadOnlyMemoryStorage extends MemoryStorage {
      readonly readOnly = true
    }
    mountApp(() => new ReadOnlyMemoryStorage())

    await waitForText('Read-only: another tab is active')
  })

  it('surfaces a failed course save on the form', async () => {
    const storage = new MemoryStorage()
    vi.spyOn(storage, 'saveCourses').mockRejectedValue(
      new StorageError('quota-exceeded', 'quota exceeded'),
    )
    mountApp(() => storage)

    await waitForText('create your first course')
    location.hash = '#/course/new'
    await waitForText('Minimum lap time')

    const nameInput = container.querySelector<HTMLInputElement>('input[type="text"]')
    if (!nameInput) throw new Error('no name input')
    nameInput.value = 'Basement'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(buttonByText('Create course').disabled).toBe(false))
    buttonByText('Create course').click()

    await waitForText('Storage error: quota exceeded')
    // The failed save must not navigate away from the form.
    expect(location.hash).toBe('#/course/new')
  })

  it('shows a dismissable quarantine notice when the storage reports one', async () => {
    let reportQuarantine: ((event: QuarantineEvent) => void) | undefined
    mountApp((onQuarantine) => {
      reportQuarantine = onQuarantine
      return new MemoryStorage()
    })

    await waitForText('Courses')
    if (!reportQuarantine) throw new Error('createStorage did not receive onQuarantine')
    reportQuarantine({
      fileName: 'session-abc.json',
      quarantinedTo: 'session-abc.json.corrupt.2026-07-13T00-00-00Z',
      reason: 'invalid JSON',
    })

    await waitForText('A stored file was corrupt and set aside')
    await waitForText('session-abc.json')

    buttonByText('Dismiss').click()
    await vi.waitFor(() => expect(text()).not.toContain('A stored file was corrupt'))
  })

  // Startup resume (plan 09 item 10). Mounted on #/diag, the route the app
  // happens to have restored: the notice belongs to App, not Home, precisely
  // because a relaunch after a crashed delete may never land on Home.
  it('finishes an interrupted deletion at startup and shows a dismissable notice', async () => {
    const storage = new MemoryStorage()
    await storage.saveCourses({
      courses: [makeCourse({ id: 'c-1', name: 'Basement 3-gate' })],
      settings: {
        speechEnabled: true,
        pendingCourseDeletions: [
          { courseId: 'c-1', courseName: 'Basement 3-gate', sessionIds: ['s-1'] },
        ],
      },
    })
    await storage.saveSession(makeSession({ id: 's-1', courseId: 'c-1' }))
    location.hash = '#/diag'
    mountApp(() => storage)

    await waitForText('Finished deleting "Basement 3-gate" — an earlier deletion was interrupted.')
    const { courses, settings } = await storage.loadCourses()
    expect(courses).toEqual([])
    expect(settings.pendingCourseDeletions).toBeUndefined()
    expect(await storage.listSessions()).toEqual([])

    buttonByText('Dismiss').click()
    await vi.waitFor(() => expect(text()).not.toContain('Finished deleting'))
  })

  // Flown since the interrupted delete: the marker's bounded work list no
  // longer covers what is there, so the deletion is abandoned, not completed.
  it('reports an abandoned deletion and leaves the course intact', async () => {
    const storage = new MemoryStorage()
    await storage.saveCourses({
      courses: [makeCourse({ id: 'c-1', name: 'Basement 3-gate' })],
      settings: {
        speechEnabled: true,
        pendingCourseDeletions: [
          { courseId: 'c-1', courseName: 'Basement 3-gate', sessionIds: ['s-1'] },
        ],
      },
    })
    await storage.saveSession(makeSession({ id: 's-1', courseId: 'c-1' }))
    await storage.saveSession(makeSession({ id: 's-flown-since', courseId: 'c-1' }))
    mountApp(() => storage)

    await waitForText(
      'An interrupted deletion of "Basement 3-gate" was abandoned — you have flown on it since.',
    )
    const { courses, settings } = await storage.loadCourses()
    expect(courses.map((course) => course.id)).toEqual(['c-1'])
    expect(settings.pendingCourseDeletions).toBeUndefined()
    expect((await storage.listSessions()).map((summary) => summary.id).sort()).toEqual([
      's-1',
      's-flown-since',
    ])
    // The course survives on Home, with both sessions.
    await waitForText('Basement 3-gate')
  })
})
