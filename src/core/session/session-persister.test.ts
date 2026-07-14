import { describe, expect, test } from 'vitest'
import type { Session } from '../domain/types'
import { MemoryStorage } from '../storage/memory-storage'
import { StorageError, type Storage } from '../storage/storage'
import {
  createSessionPersister,
  DEFAULT_RETRY_DELAYS_MS,
  type PersisterState,
} from './session-persister'

const DETECTION_CONFIG = {
  tunables: {
    roi: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
    stripCount: 12,
    triggerLevel: 0.4,
    emaTimeConstantMs: 325,
    threshold: 25,
  },
  detector: {
    triggerLevel: 0.4,
    hysteresisRatio: 0.5,
    entryZoneStrips: 2,
    maxBackstepStrips: 1,
    minTraversalMs: 0,
    maxTraversalMs: 1500,
    minParticipatingStrips: 3,
    transientStripFraction: 0.7,
    transientHoldoffMs: 300,
    maxPauseMs: 2000,
  },
}

function sessionFixture(lapCount = 0): Session {
  return {
    id: 'session-1',
    courseId: 'course-1',
    startedAt: '2026-07-13T10:00:00.000Z',
    note: '',
    detectionConfig: structuredClone(DETECTION_CONFIG),
    laps: Array.from({ length: lapCount }, (_, i) => ({
      n: i + 1,
      durationMs: 14000 + i,
      completedAt: '2026-07-13T10:01:00.000Z',
      status: 'valid' as const,
    })),
  }
}

// Storage fake whose saveSession promises the test settles by hand: each call
// records its snapshot and stays unsettled until resolveSave/rejectSave.
class ControlledStorage extends MemoryStorage {
  readonly saves: Session[] = []
  readonly #settlers: { resolve: () => void; reject: (error: unknown) => void }[] = []

  override saveSession(session: Session): Promise<void> {
    this.saves.push(structuredClone(session))
    return new Promise((resolve, reject) => {
      this.#settlers.push({ resolve, reject })
    })
  }

  get unsettledCount(): number {
    return this.#settlers.length
  }

  async resolveSave(): Promise<void> {
    const settler = this.#settlers.shift()
    if (!settler) throw new Error('no save in flight')
    settler.resolve()
    await drainMicrotasks()
  }

  async rejectSave(error: unknown): Promise<void> {
    const settler = this.#settlers.shift()
    if (!settler) throw new Error('no save in flight')
    settler.reject(error)
    await drainMicrotasks()
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

interface ScheduledRetry {
  fn: () => void
  delayMs: number
  cancelled: boolean
}

// Injectable scheduler: retries run only when the test fires them.
class FakeScheduler {
  readonly scheduled: ScheduledRetry[] = []

  scheduleFn = (fn: () => void, delayMs: number): unknown => {
    const entry: ScheduledRetry = { fn, delayMs, cancelled: false }
    this.scheduled.push(entry)
    return entry
  }

  cancelFn = (handle: unknown): void => {
    ;(handle as ScheduledRetry).cancelled = true
  }

  get pending(): ScheduledRetry[] {
    return this.scheduled.filter((entry) => !entry.cancelled)
  }

  async fire(entry: ScheduledRetry): Promise<void> {
    if (entry.cancelled) throw new Error('firing a cancelled retry')
    entry.fn()
    await drainMicrotasks()
  }
}

function writeFailed(): StorageError {
  return new StorageError('write-failed', 'disk said no')
}

describe('createSessionPersister', () => {
  test('sessionStarted saves immediately (file exists at arm, before any lap)', async () => {
    const storage = new ControlledStorage()
    const persister = createSessionPersister(storage)

    persister.sessionStarted(sessionFixture())
    expect(storage.saves).toHaveLength(1)
    expect(storage.saves[0].laps).toEqual([])
    expect(persister.state).toEqual({ pending: true })

    await storage.resolveSave()
    expect(persister.state).toEqual({ pending: false, savedLapCount: 0 })
  })

  test('single-flight with latest-wins coalescing under rapid laps', async () => {
    const storage = new ControlledStorage()
    const persister = createSessionPersister(storage)

    persister.sessionStarted(sessionFixture())
    persister.sessionUpdated(sessionFixture(1))
    persister.sessionUpdated(sessionFixture(2))
    persister.sessionUpdated(sessionFixture(3))

    // Only the arm-time save went out; the three updates coalesced to one
    // queued snapshot (the newest).
    expect(storage.saves).toHaveLength(1)

    await storage.resolveSave()
    expect(storage.saves).toHaveLength(2)
    expect(storage.saves[1].laps).toHaveLength(3)

    await storage.resolveSave()
    expect(storage.saves).toHaveLength(2)
    expect(persister.state).toEqual({ pending: false, savedLapCount: 3 })
  })

  test('snapshot isolation: mutating the session after the call changes nothing', async () => {
    const storage = new ControlledStorage()
    const persister = createSessionPersister(storage)
    const session = sessionFixture(1)

    persister.sessionStarted(session)
    session.laps.push({
      n: 2,
      durationMs: 9999,
      completedAt: '2026-07-13T10:02:00.000Z',
      status: 'valid',
    })
    session.note = 'mutated after the call'
    await storage.resolveSave()

    expect(storage.saves[0].laps).toHaveLength(1)
    expect(storage.saves[0].note).toBe('')
  })

  test('write-failed retries with backoff through the delay schedule, then gives up', async () => {
    const storage = new ControlledStorage()
    const scheduler = new FakeScheduler()
    const persister = createSessionPersister(storage, {
      scheduleFn: scheduler.scheduleFn,
      cancelFn: scheduler.cancelFn,
    })

    persister.sessionStarted(sessionFixture(1))
    await storage.rejectSave(writeFailed())

    expect(persister.state).toEqual({
      pending: true,
      lastError: { kind: 'write-failed', message: 'disk said no' },
    })

    for (const [i, expectedDelay] of DEFAULT_RETRY_DELAYS_MS.entries()) {
      const retry = scheduler.pending[i]
      expect(retry.delayMs).toBe(expectedDelay)
      await scheduler.fire(retry)
      expect(storage.saves).toHaveLength(i + 2)
      await storage.rejectSave(writeFailed())
    }

    // Budget spent: quiescent, error surfaced, nothing more scheduled.
    expect(scheduler.pending).toHaveLength(3)
    expect(persister.state).toEqual({
      pending: false,
      lastError: { kind: 'write-failed', message: 'disk said no' },
    })
  })

  test('retry success clears the error and records savedLapCount', async () => {
    const storage = new ControlledStorage()
    const scheduler = new FakeScheduler()
    const persister = createSessionPersister(storage, {
      scheduleFn: scheduler.scheduleFn,
      cancelFn: scheduler.cancelFn,
    })

    persister.sessionStarted(sessionFixture(2))
    await storage.rejectSave(writeFailed())
    await scheduler.fire(scheduler.pending[0])
    await storage.resolveSave()

    expect(persister.state).toEqual({ pending: false, savedLapCount: 2 })
  })

  test('quota-exceeded surfaces immediately without retry', async () => {
    const storage = new ControlledStorage()
    const scheduler = new FakeScheduler()
    const persister = createSessionPersister(storage, {
      scheduleFn: scheduler.scheduleFn,
      cancelFn: scheduler.cancelFn,
    })

    persister.sessionStarted(sessionFixture(1))
    await storage.rejectSave(new StorageError('quota-exceeded', 'origin quota exhausted'))

    expect(scheduler.scheduled).toHaveLength(0)
    expect(persister.state).toEqual({
      pending: false,
      lastError: { kind: 'quota-exceeded', message: 'origin quota exhausted' },
    })
  })

  test('a new snapshot cancels the scheduled retry and saves immediately with a fresh budget', async () => {
    const storage = new ControlledStorage()
    const scheduler = new FakeScheduler()
    const persister = createSessionPersister(storage, {
      scheduleFn: scheduler.scheduleFn,
      cancelFn: scheduler.cancelFn,
    })

    persister.sessionStarted(sessionFixture(1))
    await storage.rejectSave(writeFailed())
    expect(scheduler.pending).toHaveLength(1)

    persister.sessionUpdated(sessionFixture(2))
    expect(scheduler.pending).toHaveLength(0)
    expect(storage.saves).toHaveLength(2)
    expect(storage.saves[1].laps).toHaveLength(2)

    // Fresh budget: the next failure schedules at the FIRST delay again.
    await storage.rejectSave(writeFailed())
    expect(scheduler.pending[0].delayMs).toBe(DEFAULT_RETRY_DELAYS_MS[0])
  })

  test('a snapshot arriving during a failing save supersedes it — no retry of stale data', async () => {
    const storage = new ControlledStorage()
    const scheduler = new FakeScheduler()
    const persister = createSessionPersister(storage, {
      scheduleFn: scheduler.scheduleFn,
      cancelFn: scheduler.cancelFn,
    })

    persister.sessionStarted(sessionFixture(1))
    persister.sessionUpdated(sessionFixture(2))
    await storage.rejectSave(writeFailed())

    // The queued newer snapshot went out instead of a scheduled retry.
    expect(scheduler.scheduled).toHaveLength(0)
    expect(storage.saves).toHaveLength(2)
    expect(storage.saves[1].laps).toHaveLength(2)
  })

  test('flush resolves once in-flight and queued saves settle', async () => {
    const storage = new ControlledStorage()
    const persister = createSessionPersister(storage)

    persister.sessionStarted(sessionFixture())
    persister.sessionUpdated(sessionFixture(1))

    let flushed = false
    const flushPromise = persister.flush().then(() => {
      flushed = true
    })

    await drainMicrotasks()
    expect(flushed).toBe(false)
    await storage.resolveSave()
    expect(flushed).toBe(false)
    await storage.resolveSave()
    await flushPromise
    expect(persister.state).toEqual({ pending: false, savedLapCount: 1 })
  })

  test('flush on a quiescent persister resolves immediately', async () => {
    const persister = createSessionPersister(new ControlledStorage())
    await expect(persister.flush()).resolves.toBeUndefined()
  })

  test('flush runs a scheduled retry immediately and keeps retrying without backoff delays', async () => {
    const storage = new ControlledStorage()
    const scheduler = new FakeScheduler()
    const persister = createSessionPersister(storage, {
      scheduleFn: scheduler.scheduleFn,
      cancelFn: scheduler.cancelFn,
    })

    persister.sessionStarted(sessionFixture(1))
    await storage.rejectSave(writeFailed())
    expect(scheduler.pending).toHaveLength(1)

    let flushed = false
    const flushPromise = persister.flush().then(() => {
      flushed = true
    })

    // The backoff timer was cancelled and the retry went out at once.
    expect(scheduler.pending).toHaveLength(0)
    expect(storage.saves).toHaveLength(2)

    // Remaining attempts run back-to-back (no scheduler involvement), then
    // flush resolves with the error surfaced.
    await storage.rejectSave(writeFailed())
    expect(flushed).toBe(false)
    expect(storage.saves).toHaveLength(3)
    await storage.rejectSave(writeFailed())
    expect(flushed).toBe(false)
    expect(storage.saves).toHaveLength(4)
    await storage.rejectSave(writeFailed())
    await flushPromise
    expect(scheduler.pending).toHaveLength(0)
    expect(persister.state.lastError?.kind).toBe('write-failed')
    expect(persister.state.pending).toBe(false)
  })

  test('a synchronously throwing saveSession never throws into the caller', async () => {
    const storage = new ControlledStorage()
    const throwingStorage: Storage = {
      ...storageAsInterface(storage),
      saveSession: () => {
        throw new Error('sync explosion')
      },
    }
    const scheduler = new FakeScheduler()
    const persister = createSessionPersister(throwingStorage, {
      scheduleFn: scheduler.scheduleFn,
      cancelFn: scheduler.cancelFn,
    })

    expect(() => persister.sessionStarted(sessionFixture())).not.toThrow()
    await drainMicrotasks()
    // Non-StorageError failures are treated as retriable write failures.
    expect(persister.state.lastError).toEqual({ kind: 'write-failed', message: 'sync explosion' })
    expect(persister.state.pending).toBe(true)
    expect(scheduler.pending).toHaveLength(1)
  })

  test('sessionStarted resets lastError and savedLapCount from a previous session', async () => {
    const storage = new ControlledStorage()
    const scheduler = new FakeScheduler()
    const persister = createSessionPersister(storage, {
      scheduleFn: scheduler.scheduleFn,
      cancelFn: scheduler.cancelFn,
    })

    persister.sessionStarted(sessionFixture(1))
    await storage.rejectSave(new StorageError('quota-exceeded', 'full'))
    expect(persister.state.lastError?.kind).toBe('quota-exceeded')

    persister.sessionStarted({ ...sessionFixture(), id: 'session-2' })
    expect(persister.state).toEqual({ pending: true })
    await storage.resolveSave()
    expect(persister.state).toEqual({ pending: false, savedLapCount: 0 })
  })

  test('onStateChange reports each transition with a detached state snapshot', async () => {
    const storage = new ControlledStorage()
    const states: PersisterState[] = []
    const persister = createSessionPersister(storage, {
      onStateChange: (state) => states.push(state),
    })

    persister.sessionStarted(sessionFixture())
    await storage.resolveSave()

    expect(states).toEqual([
      { pending: true },
      { pending: false, savedLapCount: 0 },
    ])
    // Snapshots, not live references.
    expect(states[0]).not.toBe(states[1])
    expect(states[1]).not.toBe(persister.state)
  })
})

// MemoryStorage's methods are prototype-bound; spread copies nothing. Rebind
// explicitly so a test can override a single method.
function storageAsInterface(storage: MemoryStorage): Storage {
  return {
    loadCourses: () => storage.loadCourses(),
    saveCourses: (data) => storage.saveCourses(data),
    listSessions: () => storage.listSessions(),
    loadSession: (id) => storage.loadSession(id),
    saveSession: (session) => storage.saveSession(session),
    latestSessionForCourse: (courseId) => storage.latestSessionForCourse(courseId),
    exportAll: () => storage.exportAll(),
    importAll: (envelope) => storage.importAll(envelope),
    persistenceStatus: () => storage.persistenceStatus(),
    deleteSession: (id) => storage.deleteSession(id),
    deleteCourse: (id) => storage.deleteCourse(id),
    resumePendingDeletions: () => storage.resumePendingDeletions(),
  }
}
