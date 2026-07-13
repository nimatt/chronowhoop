// Review screens (plan 06 item 10) against MemoryStorage through the real
// App routing: course view all-time records + session list, session view
// header/records/lap table/note editing, and not-found handling.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import App from '../App.svelte'
import type { CapabilityReport } from '../../core/capabilities/capabilities'
import { MemoryStorage } from '../../core/storage/memory-storage'
import { makeCourse, makeLap, makeSession } from '../../core/storage/storage-contract'

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

function linkByText(label: string): HTMLAnchorElement {
  const link = Array.from(container.querySelectorAll('a')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!link) throw new Error(`no link labelled ${JSON.stringify(label)}`)
  return link
}

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`)
  return button
}

async function seededStorage() {
  const storage = new MemoryStorage()
  const course = makeCourse({ id: 'c-1', name: 'Garage loop', direction: 'ltr', minLapTimeMs: 3000 })
  await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })

  // Older session: two valid laps (no 3-window).
  await storage.saveSession(
    makeSession({
      id: 's-old',
      courseId: 'c-1',
      startedAt: '2026-07-10T12:00:00.000Z',
      laps: [
        makeLap({ n: 1, durationMs: 20000 }),
        makeLap({ n: 2, durationMs: 14320, completedAt: '2026-07-10T12:01:00.000Z' }),
      ],
    }),
  )
  // Newer session: holds the all-time best lap (13.33) and the only valid
  // 3-window (13.90 + 13.33 + 14.07 = 41.30); a trailing discarded lap.
  await storage.saveSession(
    makeSession({
      id: 's-new',
      courseId: 'c-1',
      startedAt: '2026-07-11T12:00:00.000Z',
      note: 'evening pass',
      laps: [
        makeLap({ n: 1, durationMs: 13900 }),
        makeLap({ n: 2, durationMs: 13330, completedAt: '2026-07-11T12:01:00.000Z' }),
        makeLap({ n: 3, durationMs: 14070, completedAt: '2026-07-11T12:02:00.000Z' }),
        makeLap({ n: 4, durationMs: 30000, completedAt: '2026-07-11T12:03:00.000Z', status: 'discarded' }),
      ],
    }),
  )
  return storage
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

describe('course view (App + MemoryStorage)', () => {
  it('shows all-time records across sessions and the session list newest first', async () => {
    mountApp(await seededStorage())
    location.hash = '#/course/c-1'

    await waitForText('All-time records')
    await waitForText('13.33') // best lap, from the newer session
    await waitForText('41.30') // best three, within the newer session only

    const items = Array.from(container.querySelectorAll('.sessions li'))
    expect(items.length).toBe(2)
    // Newest first: the discarded lap is excluded from the valid count.
    expect(items[0].textContent).toContain('3 laps')
    expect(items[0].textContent).toContain('(1 discarded)')
    expect(items[0].textContent).toContain('best 13.33')
    expect(items[1].textContent).toContain('2 laps')
    expect(items[1].textContent).toContain('best 14.32')
    expect(items[0].querySelector('a')?.getAttribute('href')).toBe('#/session/s-new')
  })

  it('shows a session written behind the repo (a flight) on the next visit', async () => {
    const storage = await seededStorage()
    mountApp(storage)
    location.hash = '#/course/c-1'
    await waitForText('All-time records')
    await vi.waitFor(() => expect(container.querySelectorAll('.sessions li').length).toBe(2))

    // A flight persists straight through storage (the session persister),
    // bypassing SessionsRepo — the next mount must refresh, not trust the
    // cached list.
    await storage.saveSession(
      makeSession({
        id: 's-flown',
        courseId: 'c-1',
        startedAt: '2026-07-12T12:00:00.000Z',
        laps: [makeLap({ n: 1, durationMs: 12000 })],
      }),
    )

    location.hash = '#/'
    await waitForText('Tiny-whoop lap timer')
    location.hash = '#/course/c-1'
    await vi.waitFor(() => expect(container.querySelectorAll('.sessions li').length).toBe(3))
    expect(text()).toContain('best 12.00')
  })

  it('remounts on a direct course-A → course-B hash edit (no stale records)', async () => {
    const storage = await seededStorage()
    const { courses, settings } = await storage.loadCourses()
    await storage.saveCourses({
      courses: [...courses, makeCourse({ id: 'c-2', name: 'Attic sprint' })],
      settings,
    })
    mountApp(storage)

    location.hash = '#/course/c-1'
    await waitForText('13.33')

    location.hash = '#/course/c-2'
    await waitForText('Attic sprint')
    await waitForText('No sessions yet')
    expect(text()).not.toContain('13.33')
  })

  it('shows the empty state for a course without sessions', async () => {
    const storage = new MemoryStorage()
    await storage.saveCourses({
      courses: [makeCourse({ id: 'c-empty', name: 'Fresh course' })],
      settings: { speechEnabled: true },
    })
    mountApp(storage)
    location.hash = '#/course/c-empty'

    await waitForText('No sessions yet')
    await waitForText('All-time records')
    expect(text()).toContain('—')
  })
})

describe('session view (App + MemoryStorage)', () => {
  it('renders header, records, and the lap table with highlights and strikethrough', async () => {
    mountApp(await seededStorage())
    location.hash = '#/session/s-new'

    await waitForText('Garage loop')
    await waitForText('2026-07-11')
    await waitForText('best 3 consecutive')
    await waitForText('41.30')

    const rows = Array.from(container.querySelectorAll('tbody tr'))
    expect(rows.length).toBe(4)
    expect(rows[1].classList.contains('best')).toBe(true) // 13.33
    expect(rows[3].classList.contains('discarded')).toBe(true)
    expect(rows.map((row) => row.classList.contains('best-three'))).toEqual([
      true,
      true,
      true,
      false,
    ])

    // The stored note seeds the editor.
    expect(container.querySelector('textarea')?.value).toBe('evening pass')

    // The header links back to the course view.
    linkByText('Garage loop').click()
    await waitForText('All-time records')
  })

  it('edits the note and persists it through the storage seam', async () => {
    const storage = await seededStorage()
    mountApp(storage)
    location.hash = '#/session/s-new'
    await waitForText('Garage loop')

    const noteArea = container.querySelector('textarea')
    if (!noteArea) throw new Error('no note field')
    noteArea.value = 'rewritten note'
    noteArea.dispatchEvent(new Event('input', { bubbles: true }))

    await waitForText('Save note')
    buttonByText('Save note').click()

    await vi.waitFor(async () => {
      expect((await storage.loadSession('s-new')).note).toBe('rewritten note')
    })
    // The save button retracts once the edit is persisted (no longer dirty).
    await vi.waitFor(() => expect(text()).not.toContain('Save note'))
  })

  it('handles an unknown (or quarantined) session id gracefully', async () => {
    mountApp(await seededStorage())
    location.hash = '#/session/never-existed'
    await waitForText('This session does not exist')
    linkByText('Back to courses')
  })
})
