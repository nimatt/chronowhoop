// The delete confirmation screens (plan 09 item 8) against MemoryStorage
// through the real App routing.
//
// The test that carries this file: THE COLD MOUNT. A deep link straight to
// #/course/<id>/delete lands on a sessions repo that has never loaded — empty
// summaries, null lastError — and revision 1 of the plan would have rendered
// "Nothing has been flown on this course yet", suppressed the not-backed-up
// warning, and then destroyed every session on the course.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import App from '../App.svelte'
import type { CapabilityReport } from '../../core/capabilities/capabilities'
import { MemoryStorage } from '../../core/storage/memory-storage'
import { StorageError } from '../../core/storage/storage'
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

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`)
  return button
}

// The one button wearing the filled danger variant on these screens — found by
// class rather than label, because its label carries the blast radius.
function confirmButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button.btn-danger')
  if (!button) throw new Error('no confirm (.btn-danger) button')
  return button
}

type HeldRead = 'listSessions' | 'loadCourses'

function gate(): { held: Promise<void>; open: () => void } {
  let open = (): void => {}
  const held = new Promise<void>((resolve) => {
    open = resolve
  })
  return { held, open }
}

// A storage whose reads can be HELD OPEN — the only way to see the window both
// screens' load gates exist for.
//
// Nothing that polls can see it. Every other assertion in this file sits behind
// waitForText / vi.waitFor, which keep retrying until the repos have answered —
// by which time a screen with no load gate at all looks exactly like one with a
// working gate. That is precisely how a deleted gate ships: the guard is real,
// the bug it prevents is real, and every test still passes. So these tests hold
// the read open and assert SYNCHRONOUSLY, in the unsettled window.
class GatedStorage extends MemoryStorage {
  private readonly gates: Record<HeldRead, ReturnType<typeof gate>> = {
    listSessions: gate(),
    loadCourses: gate(),
  }

  constructor(...heldReads: HeldRead[]) {
    super()
    for (const read of ['listSessions', 'loadCourses'] as const) {
      if (!heldReads.includes(read)) this.gates[read].open()
    }
  }

  release(read: HeldRead): void {
    this.gates[read].open()
  }

  override async listSessions() {
    await this.gates.listSessions.held
    return super.listSessions()
  }

  override async loadCourses() {
    await this.gates.loadCourses.held
    return super.loadCourses()
  }
}

// Two sessions on c-1 (5 laps total, one of them discarded — the blast radius
// counts ALL laps), one on c-2 that the cascade must not touch.
async function seededStorage(settings: { lastExportAt?: string } = {}) {
  return seed(new MemoryStorage(), settings)
}

async function seed<T extends MemoryStorage>(storage: T, settings: { lastExportAt?: string } = {}) {
  await storage.saveCourses({
    courses: [
      makeCourse({ id: 'c-1', name: 'Basement 3-gate' }),
      makeCourse({ id: 'c-2', name: 'Attic sprint' }),
    ],
    settings: { speechEnabled: true, ...settings },
  })
  await storage.saveSession(
    makeSession({
      id: 's-old',
      courseId: 'c-1',
      startedAt: '2026-07-10T12:00:00.000Z',
      laps: [makeLap({ n: 1, durationMs: 20000 }), makeLap({ n: 2, durationMs: 14320 })],
    }),
  )
  await storage.saveSession(
    makeSession({
      id: 's-new',
      courseId: 'c-1',
      startedAt: '2026-07-11T12:00:00.000Z',
      laps: [
        makeLap({ n: 1, durationMs: 13900 }),
        makeLap({ n: 2, durationMs: 13330 }),
        makeLap({ n: 3, durationMs: 30000, status: 'discarded' }),
      ],
    }),
  )
  await storage.saveSession(
    makeSession({
      id: 's-other',
      courseId: 'c-2',
      startedAt: '2026-07-11T12:00:00.000Z',
      laps: [makeLap({ n: 1, durationMs: 15000 })],
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

describe('delete course (App + MemoryStorage)', () => {
  it('states the real blast radius on a cold mount, and arms the button only once counted', async () => {
    // A deep link: nothing ever loaded the sessions repo, so its summaries are
    // empty and its lastError is null — the exact state that must NOT be read as
    // "no sessions".
    location.hash = '#/course/c-1/delete'
    mountApp(await seededStorage())

    await waitForText('Delete "Basement 3-gate"?')
    await waitForText('This also deletes 2 sessions and 5 laps flown on this course.')
    expect(text()).not.toContain('Nothing has been flown')
    // ALL laps, valid and discarded: 2 + 3, not 2 + 2.
    expect(text()).not.toContain('4 laps')

    // The button only promises what it has counted, and only once it has.
    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
    expect(confirmButton().textContent?.trim()).toBe('Delete course and 2 sessions')
    // Never exported, so the doomed sessions are not backed up.
    expect(text()).toContain('you have never exported')
    expect(text()).toContain('Export backup first')
  })

  // THE COLD MOUNT, held open. The test above proves the counts are RIGHT once
  // the repo answers; this one is the only test in the file that can see what
  // the screen says BEFORE it answers — the window in which an ungated screen
  // renders "Nothing has been flown on this course yet", suppresses the
  // not-backed-up warning, offers an armed Delete, and destroys two sessions
  // the user was just told did not exist.
  it('refuses to state a count, or arm Delete, while the sessions repo has not answered', async () => {
    const storage = new GatedStorage('listSessions')
    await seed(storage)
    location.hash = '#/course/c-1/delete'
    mountApp(storage)

    // The courses repo has answered (the title is on screen); the sessions repo
    // has NOT and will not until this test lets it. Everything below is a
    // synchronous read of that state — no waiting, or the window closes.
    await waitForText('Delete "Basement 3-gate"?')

    expect(confirmButton().disabled).toBe(true)
    expect(text()).toContain('This also deletes every session and lap flown on this course.')
    expect(text()).not.toContain('Nothing has been flown')
    // The button promises nothing it has not counted.
    expect(confirmButton().textContent?.trim()).toBe('Delete course')

    storage.release('listSessions')

    // And the moment it answers, the truth lands and the button arms.
    await waitForText('This also deletes 2 sessions and 5 laps flown on this course.')
    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
    expect(confirmButton().textContent?.trim()).toBe('Delete course and 2 sessions')
    expect(text()).toContain('you have never exported')
  })

  it('deletes the course, lands on home, and takes only its own sessions', async () => {
    const storage = await seededStorage()
    location.hash = '#/course/c-1/delete'
    mountApp(storage)

    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
    confirmButton().click()

    await vi.waitFor(() => expect(location.hash).toBe('#/'))
    await waitForText('Courses')
    expect(text()).not.toContain('Basement 3-gate')
    expect(text()).toContain('Attic sprint')

    const { courses } = await storage.loadCourses()
    expect(courses.map((course) => course.id)).toEqual(['c-2'])
    const remaining = await storage.listSessions()
    expect(remaining.map((summary) => summary.id)).toEqual(['s-other'])
  })

  it('holds the screen open on a failing delete and says how far it got', async () => {
    const storage = await seededStorage()
    // The cascade dies mid-sweep: newest first (the listSessions contract), so
    // s-new is gone and s-old survives — the partial state the intent marker
    // exists to describe, and the one the confirmation screen has to contradict.
    const deleteSession = storage.deleteSession.bind(storage)
    storage.deleteSession = (id: string) =>
      id === 's-old'
        ? Promise.reject(new StorageError('write-failed', 'disk went away'))
        : deleteSession(id)

    location.hash = '#/course/c-1/delete'
    mountApp(storage)

    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
    confirmButton().click()

    await waitForText('Deleted 1 of 2 sessions — the course is still here. Try again.')
    // It HELD: no navigation, and the retry (idempotent at the seam) is armed.
    expect(location.hash).toBe('#/course/c-1/delete')
    expect(text()).toContain('Delete "Basement 3-gate"?')
    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
  })

  // A SICK STORE FAILS MORE THAN ONE READ. The cascade dies, and the reads that
  // follow it — CoursesRepo.reload() in deleteCourse's failure arm,
  // SessionsRepo.refresh() in the context's composition — run against the same
  // store that just refused the write, so they are exactly the reads most likely
  // to fail too. Both tests below break the delete AND the read that follows it.
  function failCascadeThen(
    storage: MemoryStorage,
    breakRead: (storage: MemoryStorage, isSick: () => boolean) => void,
  ): void {
    let sick = false
    // Newest first (the listSessions contract): s-new goes, s-old refuses.
    const deleteSession = storage.deleteSession.bind(storage)
    storage.deleteSession = (id: string) => {
      if (id !== 's-old') return deleteSession(id)
      sick = true
      return Promise.reject(new StorageError('write-failed', 'disk went away'))
    }
    breakRead(storage, () => sick)
  }

  // CoursesRepo.reload() INVALIDATES on failure (repos.ts) — so a failed cascade
  // whose reload also fails leaves `loaded` false while the screen is holding
  // open for the retry. With the load gate outside the confirm-time freeze, that
  // swaps the entire confirm body for a bare storage error: the failure notice —
  // the ONLY place the user is told the deletion resumes on next launch, before
  // they can export anything — is computed and never rendered, and the retry the
  // freeze exists to serve is gone with it (ensureLoaded fires once at setup, so
  // the screen cannot recover without navigating away).
  it('keeps the failure notice and the retry when the reload after a failed cascade also fails', async () => {
    const storage = await seededStorage()
    failCascadeThen(storage, (target, isSick) => {
      const loadCourses = target.loadCourses.bind(target)
      target.loadCourses = () =>
        isSick()
          ? Promise.reject(new StorageError('corrupt', 'courses.json unreadable'))
          : loadCourses()
    })

    location.hash = '#/course/c-1/delete'
    mountApp(storage)

    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
    confirmButton().click()

    await waitForText('Deleted 1 of 2 sessions — the course is still here. Try again.')
    expect(text()).toContain(
      'If you leave it, the deletion finishes itself the next time the app opens.',
    )
    // The frozen snapshot still renders — the screen did not fall back to the
    // load gate under it.
    expect(text()).toContain('Delete "Basement 3-gate"?')
    expect(text()).not.toContain('Storage error:')
    expect(text()).not.toContain('Loading course…')
    // And the retry — idempotent at the seam — is armed, on a repo that has gone
    // dark since it answered.
    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
    expect(confirmButton().textContent?.trim()).toBe('Delete course and 2 sessions')
    expect(buttonByText('Cancel').disabled).toBe(false)
  })

  // SessionsRepo.refresh() keeps its STALE list on failure, so the survivor count
  // after a failed refresh is the full pre-delete count — "Deleted 0 of 2",
  // resume sentence dropped — told to someone whose sessions really are gone and
  // whose intent marker really is on disk. A count we could not obtain is not a
  // count of zero, here as anywhere else.
  it('claims no progress it could not count after a failed cascade, and still warns of the resume', async () => {
    const storage = await seededStorage()
    failCascadeThen(storage, (target, isSick) => {
      const listSessions = target.listSessions.bind(target)
      target.listSessions = () =>
        isSick()
          ? Promise.reject(new StorageError('corrupt', 'sessions unreadable'))
          : listSessions()
    })

    location.hash = '#/course/c-1/delete'
    mountApp(storage)

    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
    confirmButton().click()

    await waitForText('we could not check how far the delete got')
    expect(text()).toContain('up to 2 sessions may already be gone')
    expect(text()).toContain(
      'If you leave it, the deletion may finish itself the next time the app opens.',
    )
    expect(text()).not.toContain('Deleted 0 of 2')
    // And no "could not be counted" notice stacked on top of the failure notice
    // that already carries the store's words: the counts are frozen by now.
    expect(text()).not.toContain('could not be counted')
    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
  })

  it('warns when the doomed sessions postdate the last export, and stays quiet when they do not', async () => {
    // Exported Monday, flew Saturday, deleting on Sunday: the backup warning
    // exists for exactly this person, and shouldNudgeBackup's 7-day clause would
    // have stayed silent.
    location.hash = '#/course/c-1/delete'
    mountApp(await seededStorage({ lastExportAt: '2026-07-10T18:00:00.000Z' }))

    await waitForText('some of this was flown after your last export')
    expect(text()).toContain('Export backup first')
  })

  it('says nothing about backups when every doomed session predates the last export', async () => {
    location.hash = '#/course/c-1/delete'
    mountApp(await seededStorage({ lastExportAt: '2026-07-12T18:00:00.000Z' }))

    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
    expect(text()).not.toContain('Not backed up')
    expect(text()).not.toContain('Export backup first')
  })

  it('shows the not-found message, and no delete button, for an already-deleted course', async () => {
    location.hash = '#/course/gone/delete'
    mountApp(await seededStorage())

    await waitForText('This course does not exist — it may have been deleted.')
    expect(container.querySelector('button.btn-danger')).toBeNull()
  })
})

describe('delete session (App + MemoryStorage)', () => {
  it('states the session blast radius and returns to its course after deleting', async () => {
    const storage = await seededStorage()
    location.hash = '#/session/s-new/delete'
    mountApp(storage)

    await waitForText('Delete this session?')
    // All 3 laps (one discarded), best VALID lap 13.33.
    await waitForText('3 laps, best 13.33 s. It cannot be undone.')

    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
    confirmButton().click()

    await vi.waitFor(() => expect(location.hash).toBe('#/course/c-1'))
    await waitForText('Basement 3-gate')
    await vi.waitFor(() => expect(container.querySelectorAll('.sessions li').length).toBe(1))

    const remaining = await storage.listSessions()
    expect(remaining.map((summary) => summary.id).sort()).toEqual(['s-old', 's-other'])
  })

  // The same unsettled window on the other screen, and the same class of bug:
  // the backup warning and the Delete button both depend on the courses repo
  // (it holds lastExportAt), and an unloaded CoursesRepo reports the DEFAULT
  // settings — lastExportAt undefined, lastError null. Read those as answers and
  // the screen arms Delete while silently deciding this session is backed up.
  //
  // Asserted as the INVARIANT rather than as one mechanism, because there are
  // two honest ways to satisfy it and the screen may legitimately switch between
  // them: disable Delete until the repo answers, or warn pessimistically while it
  // has not. What is never allowed is the third state — armed, and silent about
  // backups because nobody asked. (The screen currently takes the second route:
  // it warns without naming a cause it cannot know.)
  it('never arms Delete while the backup warning is silent only because the courses repo has not answered', async () => {
    const storage = new GatedStorage('loadCourses')
    await seed(storage)
    location.hash = '#/session/s-new/delete'
    mountApp(storage)

    // The session file has been read (its blast radius is on screen); the
    // courses repo has not answered and will not until this test lets it.
    await waitForText('3 laps, best 13.33 s. It cannot be undone.')

    const armed = !confirmButton().disabled
    const toldTheTruthAboutBackups = text().includes('Export backup first')
    expect(armed && !toldTheTruthAboutBackups).toBe(false)

    storage.release('loadCourses')

    // Once it answers, the warning is the specific one and the button is armed.
    await waitForText('Not backed up — you have never exported.')
    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
    expect(confirmButton().textContent?.trim()).toBe('Delete session')
  })

  it('cancels back to the course without deleting anything', async () => {
    const storage = await seededStorage()
    location.hash = '#/session/s-new/delete'
    mountApp(storage)

    await waitForText('Delete this session?')
    buttonByText('Cancel').click()

    await vi.waitFor(() => expect(location.hash).toBe('#/course/c-1'))
    expect((await storage.listSessions()).length).toBe(3)
  })

  it('holds the screen open on a failing delete', async () => {
    const storage = await seededStorage()
    storage.deleteSession = () =>
      Promise.reject(new StorageError('write-failed', 'another tab holds the writer lock'))
    location.hash = '#/session/s-new/delete'
    mountApp(storage)

    await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
    confirmButton().click()

    await waitForText('another tab holds the writer lock')
    expect(location.hash).toBe('#/session/s-new/delete')
    expect((await storage.listSessions()).length).toBe(3)
  })

  it('shows the not-found message, and no delete button, for an already-deleted session', async () => {
    location.hash = '#/session/gone/delete'
    mountApp(await seededStorage())

    await waitForText('This session does not exist')
    expect(container.querySelector('button.btn-danger')).toBeNull()
  })
})

describe('read-only tab', () => {
  it('cannot arm either delete button', async () => {
    const storage = await seededStorage()
    // The structural read-only flag StorageContext mirrors (storage-context.ts).
    Object.defineProperty(storage, 'readOnly', { value: true })

    location.hash = '#/course/c-1/delete'
    mountApp(storage)
    await waitForText('Delete "Basement 3-gate"?')
    await vi.waitFor(() => expect(text()).toContain('Read-only'))
    expect(confirmButton().disabled).toBe(true)

    location.hash = '#/session/s-new/delete'
    await waitForText('Delete this session?')
    expect(confirmButton().disabled).toBe(true)
  })
})
