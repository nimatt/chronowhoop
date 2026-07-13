// Backup-nudge UI (plan 07 item 3): FlyStoppedPanel mounted directly with a
// stopped fake session over a real storage context — the predicate itself is
// unit-tested in core/storage/backup-nudge.test.ts; this pins visibility and
// the Export-now flow.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import FlyStoppedPanel from './FlyStoppedPanel.svelte'
import type { FlySession } from './fly-session'
import { MemoryStorage } from '../../core/storage/memory-storage'
import type { AppSettings } from '../../core/storage/schema'
import { makeCourse, makeSession } from '../../core/storage/storage-contract'
import { createStorageContext } from '../data/storage-context.svelte'
import type { StorageContext } from '../data/storage-context'

const NUDGE_TEXT = 'aren’t backed up yet'

let container: HTMLElement
let instance: ReturnType<typeof mount> | undefined
const contexts: StorageContext[] = []

const text = () => container.textContent ?? ''
const waitForText = (needle: string) => vi.waitFor(() => expect(text()).toContain(needle))

function fakeStoppedSession(): FlySession {
  return {
    phase: 'stopped',
    stopCause: 'manual',
    interruptionNotice: false,
    course: makeCourse({ id: 'c-1' }),
    sessionStartedAt: null,
    laps: [],
    note: '',
    persisterState: { pending: false },
    setNote: () => {},
    newSession: () => {},
    dismissInterruption: () => {},
  } as unknown as FlySession
}

async function seededContext(settings: AppSettings): Promise<StorageContext> {
  const storage = new MemoryStorage()
  await storage.saveCourses({ courses: [makeCourse({ id: 'c-1' })], settings })
  await storage.saveSession(
    makeSession({ id: 's-1', courseId: 'c-1', startedAt: new Date().toISOString() }),
  )
  const context = createStorageContext({ createStorage: () => storage })
  contexts.push(context)
  return context
}

function mountPanel(context: StorageContext): void {
  instance = mount(FlyStoppedPanel, {
    target: container,
    props: { session: fakeStoppedSession(), context },
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (instance) {
    void unmount(instance)
    instance = undefined
  }
  for (const context of contexts.splice(0)) context.destroy()
  container.remove()
})

describe('backup nudge (FlyStoppedPanel)', () => {
  it('nudges when a session was never followed by an export', async () => {
    mountPanel(await seededContext({ speechEnabled: true }))

    await waitForText(NUDGE_TEXT)
    expect(text()).toContain('Export now')
  })

  it('stays quiet right after a fresh export', async () => {
    const context = await seededContext({
      speechEnabled: true,
      lastExportAt: new Date().toISOString(),
    })
    mountPanel(context)

    await waitForText('Session over')
    await vi.waitFor(() => expect(context.sessionsRepo.loaded).toBe(true))
    expect(text()).not.toContain(NUDGE_TEXT)
  })

  it('Export now delivers, records lastExportAt, and retracts the nudge', async () => {
    const context = await seededContext({ speechEnabled: true })
    mountPanel(context)
    await waitForText('Export now')

    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Export now',
    )
    if (!button) throw new Error('no Export now button')
    button.click()

    await waitForText('Exported chronowhoop-export-')
    await vi.waitFor(async () => {
      const { settings } = await context.storage.loadCourses()
      expect(settings.lastExportAt).toBeDefined()
    })
    await vi.waitFor(() => expect(text()).not.toContain(NUDGE_TEXT))
  })
})
