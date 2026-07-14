import { describe, expect, it } from 'vitest'
import type { OpfsDirectoryLike, OpfsFileHandleLike, OpfsStorageLike, OpfsWritableLike } from './opfs-probe'
import {
  COURSES_FILE,
  OpfsStorage,
  RESURRECTION_REMOVAL_ATTEMPTS,
  SESSIONS_DIR,
  type LocksLike,
  type OpfsStorageOptions,
  type QuarantineEvent,
} from './opfs-storage'
import {
  isCorruptError,
  isNotFoundError,
  isQuotaExceededError,
  isUnsupportedVersionError,
  isWriteFailedError,
} from './storage'
import { describeStorageContract, makeCourse, makeSession } from './storage-contract'

function notFoundError(name: string): Error {
  return Object.assign(new Error(`entry "${name}" not found`), { name: 'NotFoundError' })
}

interface FakeOpfsHooks {
  // Called with the file's full path just before a writable commits on
  // close(); throw to make that write fail. May be async — close() awaits it,
  // which lets a test run a whole delete *inside* another write's commit.
  beforeCommit?: (path: string) => void | Promise<void>
  // Called with the file's full path when getFile() is requested; throw to
  // make that read fail like a transient infrastructure error.
  beforeRead?: (path: string) => void
  // Called with the entry's full path before removeEntry(); throw to make the
  // removal fail.
  beforeRemove?: (path: string) => void
}

class FakeDirectory implements OpfsDirectoryLike {
  readonly files = new Map<string, string>()
  readonly directories = new Map<string, FakeDirectory>()

  constructor(
    private readonly hooks: FakeOpfsHooks,
    private readonly path = '',
  ) {}

  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike> {
    if (!this.files.has(name)) {
      if (!options?.create) return Promise.reject(notFoundError(name))
      this.files.set(name, '')
    }
    const fullPath = `${this.path}${name}`
    const handle: OpfsFileHandleLike = {
      createWritable: () => {
        let buffer = ''
        const writable: OpfsWritableLike = {
          write: (data) => {
            buffer += data
            return Promise.resolve()
          },
          close: async () => {
            await this.hooks.beforeCommit?.(fullPath)
            this.files.set(name, buffer)
          },
          abort: () => Promise.resolve(),
        }
        return Promise.resolve(writable)
      },
      getFile: () => {
        try {
          this.hooks.beforeRead?.(fullPath)
        } catch (error) {
          return Promise.reject(error as Error)
        }
        const content = this.files.get(name)
        return content === undefined
          ? Promise.reject(notFoundError(name))
          : Promise.resolve({ text: () => Promise.resolve(content) })
      },
    }
    return Promise.resolve(handle)
  }

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryLike> {
    let directory = this.directories.get(name)
    if (!directory) {
      if (!options?.create) return Promise.reject(notFoundError(name))
      directory = new FakeDirectory(this.hooks, `${this.path}${name}/`)
      this.directories.set(name, directory)
    }
    return Promise.resolve(directory)
  }

  removeEntry(name: string): Promise<void> {
    try {
      this.hooks.beforeRemove?.(`${this.path}${name}`)
    } catch (error) {
      return Promise.reject(error as Error)
    }
    if (this.files.delete(name) || this.directories.delete(name)) return Promise.resolve()
    return Promise.reject(notFoundError(name))
  }

  async *keys(): AsyncGenerator<string> {
    yield* [...this.files.keys(), ...this.directories.keys()]
  }

  // Test convenience: the sessions directory, seeded on demand.
  sessions(): FakeDirectory {
    let directory = this.directories.get(SESSIONS_DIR)
    if (!directory) {
      directory = new FakeDirectory(this.hooks, `${SESSIONS_DIR}/`)
      this.directories.set(SESSIONS_DIR, directory)
    }
    return directory
  }
}

// Grants the lock to one holder at a time, mirroring navigator.locks with
// ifAvailable: a second concurrent request gets null until the first
// holder's callback promise settles.
class FakeLockManager implements LocksLike {
  private held = false
  requestCount = 0

  async request(
    _name: string,
    _options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    this.requestCount++
    if (this.held) return callback(null)
    this.held = true
    try {
      return await callback({})
    } finally {
      this.held = false
    }
  }
}

function makeRig(overrides: Partial<OpfsStorageOptions> & { hooks?: FakeOpfsHooks } = {}) {
  const { hooks, ...options } = overrides
  const root = new FakeDirectory(hooks ?? {})
  let persistCalls = 0
  let persisted = false
  const manager: OpfsStorageLike = {
    persist: () => {
      persistCalls++
      persisted = true
      return Promise.resolve(true)
    },
    persisted: () => Promise.resolve(persisted),
  }
  const quarantines: QuarantineEvent[] = []
  const storage = new OpfsStorage({
    storage: manager,
    rootDirectory: () => Promise.resolve(root),
    locks: undefined,
    onQuarantine: (event) => quarantines.push(event),
    // Immediate by default so denied-lock tests settle synchronously; tests
    // that exercise the retry window inject their own scheduler.
    scheduleLockRetry: (retry) => {
      retry()
    },
    ...options,
  })
  return { storage, root, quarantines, persistCalls: () => persistCalls }
}

describeStorageContract('OpfsStorage (fake OPFS)', () => Promise.resolve(makeRig().storage))

describe('OpfsStorage file envelopes', () => {
  it('saveCourses writes a schemaVersion envelope to courses.json', async () => {
    const { storage, root } = makeRig()
    await storage.saveCourses({ courses: [], settings: { speechEnabled: false } })
    expect(JSON.parse(root.files.get(COURSES_FILE) ?? '')).toEqual({
      schemaVersion: 1,
      courses: [],
      settings: { speechEnabled: false },
    })
  })

  it('saveSession writes sessions/<id>.json with the schemaVersion alongside the session', async () => {
    const { storage, root } = makeRig()
    const session = makeSession()
    await storage.saveSession(session)
    expect(JSON.parse(root.sessions().files.get(`${session.id}.json`) ?? '')).toEqual({
      schemaVersion: 1,
      ...session,
    })
  })
})

describe('OpfsStorage quarantine', () => {
  const clock = () => '2026-07-13T08:15:00.123Z'
  const quarantineName = (name: string) => `${name}.corrupt.2026-07-13T08-15-00.123Z`

  it('quarantines a session file with invalid JSON and reports not-found', async () => {
    const { storage, root, quarantines } = makeRig({ now: clock })
    root.sessions().files.set('bad.json', 'not json {{')

    const error = await storage.loadSession('bad').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isNotFoundError(error)).toBe(true)
    expect(root.sessions().files.has('bad.json')).toBe(false)
    expect(root.sessions().files.get(quarantineName('bad.json'))).toBe('not json {{')
    expect(quarantines).toEqual([
      {
        fileName: 'bad.json',
        quarantinedTo: quarantineName('bad.json'),
        reason: expect.stringContaining('invalid JSON') as string,
      },
    ])
  })

  it('quarantines a schema-invalid session file the same way', async () => {
    const { storage, root, quarantines } = makeRig({ now: clock })
    root.sessions().files.set('bad.json', '{"schemaVersion":1,"id":42}')

    const error = await storage.loadSession('bad').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isNotFoundError(error)).toBe(true)
    expect(root.sessions().files.get(quarantineName('bad.json'))).toBe('{"schemaVersion":1,"id":42}')
    expect(quarantines[0]?.reason).toContain('$')
  })

  it('quarantines a corrupt courses.json and falls back to defaults', async () => {
    const { storage, root, quarantines } = makeRig({ now: clock })
    root.files.set(COURSES_FILE, '<html>definitely not json</html>')

    expect(await storage.loadCourses()).toEqual({
      courses: [],
      settings: { speechEnabled: true },
    })
    expect(root.files.has(COURSES_FILE)).toBe(false)
    expect(root.files.get(quarantineName(COURSES_FILE))).toBe('<html>definitely not json</html>')
    expect(quarantines).toHaveLength(1)
  })

  it('listSessions and exportAll skip a bad file and keep the good ones', async () => {
    const { storage, root, quarantines } = makeRig({ now: clock })
    const good = makeSession()
    await storage.saveSession(good)
    root.sessions().files.set('bad.json', 'garbage')
    root.sessions().files.set('notes.txt', 'not a session')
    root.sessions().files.set('other.json.crswap', 'staging artifact')
    root.sessions().files.set('old.json.corrupt.2026-07-01T00-00-00.000Z', 'previously quarantined')

    const summaries = await storage.listSessions()
    expect(summaries.map((s) => s.id)).toEqual([good.id])

    const envelope = await storage.exportAll()
    expect(envelope.sessions).toEqual([good])

    expect(quarantines.map((q) => q.fileName)).toEqual(['bad.json'])
    expect(root.sessions().files.has('bad.json')).toBe(false)
    expect(root.sessions().files.has(quarantineName('bad.json'))).toBe(true)
    expect(root.sessions().files.has('notes.txt')).toBe(true)
    expect(root.sessions().files.has('other.json.crswap')).toBe(true)
  })

  it('leaves the original in place when the quarantine copy cannot be written', async () => {
    const { storage, root, quarantines } = makeRig({
      now: clock,
      hooks: {
        beforeCommit: (path) => {
          if (path.includes('.corrupt.')) throw new Error('disk full')
        },
      },
    })
    root.sessions().files.set('bad.json', 'garbage')

    const error = await storage.loadSession('bad').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isNotFoundError(error)).toBe(true)
    expect(root.sessions().files.get('bad.json')).toBe('garbage')
    expect(quarantines).toEqual([
      { fileName: 'bad.json', reason: expect.stringContaining('invalid JSON') as string },
    ])
  })
})

describe('OpfsStorage unsupported-version refusal', () => {
  const v2Session = '{"schemaVersion":2,"id":"future","laps":"shaped-differently"}'
  const v2Courses = '{"schemaVersion":2,"courses":"shaped-differently"}'

  it('loadSession rejects with unsupported-version, leaving the file untouched', async () => {
    const { storage, root, quarantines } = makeRig()
    root.sessions().files.set('future.json', v2Session)

    const error = await storage.loadSession('future').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isUnsupportedVersionError(error)).toBe(true)
    expect((error as Error).message).toContain('newer than this app')
    expect(root.sessions().files.get('future.json')).toBe(v2Session)
    expect(quarantines).toEqual([])
  })

  it('loadCourses rejects instead of returning defaults, so the next save cannot entrench an empty file', async () => {
    const { storage, root, quarantines } = makeRig()
    root.files.set(COURSES_FILE, v2Courses)

    const error = await storage.loadCourses().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isUnsupportedVersionError(error)).toBe(true)
    expect(root.files.get(COURSES_FILE)).toBe(v2Courses)
    expect(quarantines).toEqual([])
  })

  it('listSessions skips the unreadable file without quarantining it', async () => {
    const { storage, root, quarantines } = makeRig()
    const good = makeSession()
    await storage.saveSession(good)
    root.sessions().files.set('future.json', v2Session)

    const summaries = await storage.listSessions()
    expect(summaries.map((s) => s.id)).toEqual([good.id])
    expect(root.sessions().files.get('future.json')).toBe(v2Session)
    expect(quarantines).toEqual([])
  })

  it('exportAll rejects rather than silently omitting the session', async () => {
    const { storage, root } = makeRig()
    await storage.saveSession(makeSession())
    root.sessions().files.set('future.json', v2Session)

    const error = await storage.exportAll().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isUnsupportedVersionError(error)).toBe(true)
    expect(root.sessions().files.get('future.json')).toBe(v2Session)
  })
})

describe('OpfsStorage transient read failures', () => {
  function makeFlakyRig(flakyName: string) {
    return makeRig({
      hooks: {
        beforeRead: (path) => {
          if (path === `${SESSIONS_DIR}/${flakyName}`) throw new Error('device busy')
        },
      },
    })
  }

  it('loadSession rejects with corrupt — no quarantine, file bytes untouched', async () => {
    const rig = makeFlakyRig('flaky.json')
    rig.root.sessions().files.set('flaky.json', '{"anything":"unread"}')

    const error = await rig.storage.loadSession('flaky').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isCorruptError(error)).toBe(true)
    expect(rig.root.sessions().files.get('flaky.json')).toBe('{"anything":"unread"}')
    expect(rig.quarantines).toEqual([])
  })

  it('listSessions skips the flaky file without quarantining it', async () => {
    const rig = makeFlakyRig('flaky.json')
    const good = makeSession()
    await rig.storage.saveSession(good)
    rig.root.sessions().files.set('flaky.json', '{"anything":"unread"}')

    const summaries = await rig.storage.listSessions()
    expect(summaries.map((s) => s.id)).toEqual([good.id])
    expect(rig.root.sessions().files.get('flaky.json')).toBe('{"anything":"unread"}')
    expect(rig.quarantines).toEqual([])
  })

  it('exportAll rejects: a backup must not silently omit sessions', async () => {
    const rig = makeFlakyRig('flaky.json')
    await rig.storage.saveSession(makeSession())
    rig.root.sessions().files.set('flaky.json', '{"anything":"unread"}')

    const error = await rig.storage.exportAll().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isCorruptError(error)).toBe(true)
    expect(rig.quarantines).toEqual([])
  })
})

describe('OpfsStorage root retry', () => {
  it('does not cache a failed root open; the next operation retries', async () => {
    let attempts = 0
    const root = new FakeDirectory({})
    const { storage } = makeRig({
      rootDirectory: () => {
        attempts++
        return attempts === 1 ? Promise.reject(new Error('backend not ready')) : Promise.resolve(root)
      },
    })

    const error = await storage.loadCourses().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isWriteFailedError(error)).toBe(true)

    await storage.saveCourses({ courses: [], settings: { speechEnabled: true } })
    expect(attempts).toBe(2)
    expect((await storage.loadCourses()).settings.speechEnabled).toBe(true)
  })
})

describe('OpfsStorage validates before writing', () => {
  it('saveSession rejects an invalid session with write-failed and writes nothing', async () => {
    const { storage, root } = makeRig()
    const error = await storage.saveSession(makeSession({ startedAt: 'yesterday' })).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isWriteFailedError(error)).toBe(true)
    expect((error as Error).message).toContain('startedAt')
    expect(root.directories.has(SESSIONS_DIR)).toBe(false)
  })

  it('saveCourses rejects invalid settings with write-failed and writes nothing', async () => {
    const { storage, root } = makeRig()
    const settings = { speechEnabled: 'yes' } as unknown as { speechEnabled: boolean }
    const error = await storage.saveCourses({ courses: [], settings }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isWriteFailedError(error)).toBe(true)
    expect(root.files.has(COURSES_FILE)).toBe(false)
  })
})

describe('OpfsStorage write-failure mapping', () => {
  it('maps QuotaExceededError to StorageError quota-exceeded', async () => {
    const { storage } = makeRig({
      hooks: {
        beforeCommit: () => {
          throw Object.assign(new Error('quota exhausted'), { name: 'QuotaExceededError' })
        },
      },
    })
    const error = await storage.saveCourses({ courses: [], settings: { speechEnabled: true } }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isQuotaExceededError(error)).toBe(true)
  })

  it('maps other write failures to StorageError write-failed', async () => {
    const { storage } = makeRig({
      hooks: {
        beforeCommit: () => {
          throw new Error('backend exploded')
        },
      },
    })
    const error = await storage.saveSession(makeSession()).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isWriteFailedError(error)).toBe(true)
  })
})

describe('OpfsStorage Web Locks single-writer', () => {
  it('the second instance re-requests once, then settles read-only and rejects writes', async () => {
    const locks = new FakeLockManager()
    const writer = makeRig({ locks }).storage
    await writer.saveCourses({ courses: [], settings: { speechEnabled: false } })
    expect(writer.readOnly).toBe(false)
    expect(locks.requestCount).toBe(1)

    const second = makeRig({ locks }).storage
    const error = await second.saveSession(makeSession()).then(
      () => undefined,
      (e: unknown) => e,
    )
    // Initial request + exactly one retry, both denied while the writer holds.
    expect(locks.requestCount).toBe(3)
    expect(isWriteFailedError(error)).toBe(true)
    expect((error as Error).message).toContain('read-only: another tab holds the lock')
    expect(second.readOnly).toBe(true)
    await expect(
      second.saveCourses({ courses: [], settings: { speechEnabled: true } }),
    ).rejects.toThrow(/read-only/)
  })

  it('a denial followed by release before the retry ends with the retry granted and writes working', async () => {
    const locks = new FakeLockManager()
    const writer = makeRig({ locks }).storage
    await writer.saveCourses({ courses: [], settings: { speechEnabled: true } })

    let retry: (() => void) | undefined
    const reader = makeRig({
      locks,
      scheduleLockRetry: (fn) => {
        retry = fn
      },
    }).storage
    expect(retry).toBeDefined()

    writer.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    retry?.()

    await reader.saveCourses({ courses: [], settings: { speechEnabled: false } })
    expect(reader.readOnly).toBe(false)
  })

  it('a read-only instance reads but does not quarantine', async () => {
    const locks = new FakeLockManager()
    const writer = makeRig({ locks })
    await writer.storage.saveCourses({ courses: [], settings: { speechEnabled: false } })

    const reader = makeRig({ locks })
    reader.root.sessions().files.set('bad.json', 'garbage')
    const error = await reader.storage.loadSession('bad').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isNotFoundError(error)).toBe(true)
    expect(reader.root.sessions().files.get('bad.json')).toBe('garbage')
    expect(reader.quarantines).toEqual([
      { fileName: 'bad.json', reason: expect.stringContaining('invalid JSON') as string },
    ])
  })

  it('dispose releases the lock so a later instance becomes the writer', async () => {
    const locks = new FakeLockManager()
    const first = makeRig({ locks }).storage
    await first.saveCourses({ courses: [], settings: { speechEnabled: true } })

    first.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const next = makeRig({ locks }).storage
    await next.saveCourses({ courses: [], settings: { speechEnabled: false } })
    expect(next.readOnly).toBe(false)
  })

  it('proceeds as the writer when the Web Locks API is absent', async () => {
    const { storage } = makeRig({ locks: undefined })
    await storage.saveCourses({ courses: [], settings: { speechEnabled: true } })
    expect(storage.readOnly).toBe(false)
  })
})

describe('OpfsStorage persistence request', () => {
  it('requests persist() lazily on the first successful save, once per instance', async () => {
    const rig = makeRig()
    await rig.storage.loadCourses()
    await rig.storage.listSessions()
    expect(rig.persistCalls()).toBe(0)
    expect(await rig.storage.persistenceStatus()).toEqual({ persisted: false })

    await rig.storage.saveCourses({ courses: [], settings: { speechEnabled: true } })
    expect(rig.persistCalls()).toBe(1)
    await rig.storage.saveSession(makeSession())
    await rig.storage.saveCourses({ courses: [], settings: { speechEnabled: false } })
    expect(rig.persistCalls()).toBe(1)
    expect(await rig.storage.persistenceStatus()).toEqual({ persisted: true })
  })

  it('does not request persist() after a failed save', async () => {
    const rig = makeRig({
      hooks: {
        beforeCommit: () => {
          throw new Error('backend exploded')
        },
      },
    })
    await rig.storage.saveSession(makeSession()).catch(() => {})
    expect(rig.persistCalls()).toBe(0)
  })

  it('persistenceStatus is false when the StorageManager API is unavailable', async () => {
    const { storage } = makeRig({ storage: {} })
    expect(await storage.persistenceStatus()).toEqual({ persisted: false })
  })
})

describe('OpfsStorage deletion', () => {
  const sessionFile = (id: string) => `${id}.json`

  it('deleteSession removes the file; an unknown id and an empty store both resolve', async () => {
    const { storage, root } = makeRig()
    const session = makeSession()
    await storage.saveSession(session)

    await storage.deleteSession(session.id)
    expect(root.sessions().files.has(sessionFile(session.id))).toBe(false)

    // Idempotent: the double-tap and the retry after a partial cascade.
    await expect(storage.deleteSession(session.id)).resolves.toBeUndefined()
    await expect(makeRig().storage.deleteSession('never-existed')).resolves.toBeUndefined()
  })

  it('the guard rejects a later saveSession for a deleted session, leaving nothing on disk', async () => {
    const { storage, root } = makeRig()
    const session = makeSession()
    await storage.saveSession(session)
    await storage.deleteSession(session.id)

    const error = await storage.saveSession(session).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isNotFoundError(error)).toBe(true)
    expect(root.sessions().files.has(sessionFile(session.id))).toBe(false)
  })

  it('deleteCourse cascades to its sessions, clears the marker and lastCourseId, and spares other courses', async () => {
    const { storage, root } = makeRig()
    const doomed = makeCourse()
    const kept = makeCourse()
    const doomedSession = makeSession({ courseId: doomed.id })
    const keptSession = makeSession({ courseId: kept.id })
    await storage.saveCourses({
      courses: [doomed, kept],
      settings: { speechEnabled: true, lastCourseId: doomed.id },
    })
    await storage.saveSession(doomedSession)
    await storage.saveSession(keptSession)

    expect(await storage.deleteCourse(doomed.id)).toEqual({ sessionsDeleted: 1 })

    const after = await storage.loadCourses()
    expect(after.courses).toEqual([kept])
    expect(after.settings).toEqual({ speechEnabled: true })
    expect(root.sessions().files.has(sessionFile(doomedSession.id))).toBe(false)
    expect(root.sessions().files.has(sessionFile(keptSession.id))).toBe(true)
  })

  it('the guard rejects a saveSession for a deleted course, even for a session that was never on disk', async () => {
    const { storage, root } = makeRig()
    const course = makeCourse()
    await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
    await storage.deleteCourse(course.id)

    // Armed moments before the delete: its first write never reached disk, so
    // the cascade's listSessions() snapshot never saw it. { create: true }
    // would resurrect it as a session whose course is gone.
    const unborn = makeSession({ courseId: course.id })
    const error = await storage.saveSession(unborn).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isNotFoundError(error)).toBe(true)
    expect(root.sessions().files.has(sessionFile(unborn.id))).toBe(false)
  })

  it('compensates a save whose write commits while the delete is in flight', async () => {
    const session = makeSession()
    const rig: { storage?: OpfsStorage } = {}
    const harness = makeRig({
      hooks: {
        beforeCommit: async (path) => {
          // The delete runs to completion INSIDE the save's commit: the save
          // has already passed its pre-check, and close() re-creates the file
          // the delete just removed.
          if (path === `${SESSIONS_DIR}/${sessionFile(session.id)}`) {
            await rig.storage?.deleteSession(session.id)
          }
        },
      },
    })
    rig.storage = harness.storage

    const error = await harness.storage.saveSession(session).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isNotFoundError(error)).toBe(true)
    expect(harness.root.sessions().files.has(sessionFile(session.id))).toBe(false)
  })

  it('raises rather than swallows a compensating removal that fails: the file may now outlive its course', async () => {
    const session = makeSession()
    const rig: { storage?: OpfsStorage } = {}
    const path = `${SESSIONS_DIR}/${sessionFile(session.id)}`
    let removals = 0
    const harness = makeRig({
      hooks: {
        beforeCommit: async (commitPath) => {
          if (commitPath === path) await rig.storage?.deleteSession(session.id)
        },
        // The delete's own removal succeeds (removal 1); every later one — the
        // compensating removals of the file the save just re-created — fails.
        beforeRemove: (removePath) => {
          if (removePath !== path) return
          removals++
          if (removals > 1) throw new Error('backend exploded')
        },
      },
    })
    rig.storage = harness.storage

    const error = await harness.storage.saveSession(session).then(
      () => undefined,
      (e: unknown) => e,
    )

    // The old `.catch(() => {})` here swallowed it: saveSession rejected
    // 'not-found', the persister gave up, and the file it had just re-created
    // stayed on disk — invisible (nothing lists a session whose course is
    // gone), unattributable (the guard that knows it should be gone dies with
    // the page), and riding out in every future export as "Unknown course".
    expect(isWriteFailedError(error)).toBe(true)
    expect((error as Error).message).toContain('outlive its course')
    // Retried before giving up — an OPFS removal can fail transiently, and this
    // one is the last line of defence.
    expect(removals).toBe(1 + RESURRECTION_REMOVAL_ATTEMPTS)
    expect(harness.quarantines).toEqual([])
  })

  it('a FAILED deleteSession un-records the id, so the session stays saveable', async () => {
    let removalsFail = true
    const session = makeSession()
    const { storage, root } = makeRig({
      hooks: {
        beforeRemove: (path) => {
          if (removalsFail && path === `${SESSIONS_DIR}/${sessionFile(session.id)}`) {
            throw new Error('backend exploded')
          }
        },
      },
    })
    await storage.saveSession(session)

    const error = await storage.deleteSession(session.id).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isWriteFailedError(error)).toBe(true)
    expect(root.sessions().files.has(sessionFile(session.id))).toBe(true)

    // The session still exists: poisoning it would silently stop the live
    // persister from saving laps the pilot is still flying.
    await expect(storage.saveSession(session)).resolves.toBeUndefined()
    removalsFail = false
    await expect(storage.deleteSession(session.id)).resolves.toBeUndefined()
  })

  // The post-write compensation is the DESTRUCTIVE half of the guard, and it is
  // keyed on destructions that actually happened — this session id was
  // deleteSession'd, or this course's cascade reached its COMMIT. A course that
  // is merely CONDEMNED must not authorise it: the cascade below dies on its
  // INTENT write having destroyed nothing at all, and the write it raced is a
  // live persister's. Compensate for a condemned-but-uncommitted course and a
  // delete that did nothing has erased the pilot's laps.
  it('does not compensate a write that raced a cascade which then FAILED before destroying anything', async () => {
    const course = makeCourse()
    const inFlight = makeSession({ courseId: course.id, note: 'lap 4' })
    const sessionPath = `${SESSIONS_DIR}/${sessionFile(inFlight.id)}`
    const rig: { save?: Promise<unknown> } = {}
    let armed = false
    let releaseSessionWrite = (): void => {}
    const sessionWriteGate = new Promise<void>((resolve) => {
      releaseSessionWrite = resolve
    })

    const { storage, root } = makeRig({
      hooks: {
        beforeCommit: async (path) => {
          if (!armed) return
          // The persister's write parks INSIDE writeTextFile, having already
          // passed its pre-check — the course was not condemned when it started.
          if (path === sessionPath) return sessionWriteGate
          if (path !== COURSES_FILE) return
          // The cascade has read, condemned, and is now making its INTENT write.
          // Let the parked write commit and run its post-write check HERE, while
          // the course is condemned but nothing has been destroyed…
          releaseSessionWrite()
          await rig.save
          // …and then fail the INTENT write, so the cascade destroys nothing.
          throw Object.assign(new Error('no room'), { name: 'QuotaExceededError' })
        },
      },
    })
    await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
    await storage.saveSession(inFlight)

    armed = true
    rig.save = storage.saveSession({ ...inFlight, note: 'lap 5' }).then(
      () => undefined,
      (e: unknown) => e,
    )
    const deleteError = await storage.deleteCourse(course.id).then(
      () => undefined,
      (e: unknown) => e,
    )

    expect(isQuotaExceededError(deleteError)).toBe(true)
    // The write landed and KEPT ITS BYTES: the cascade never committed, so it
    // had no authority to take them back.
    expect(await rig.save).toBeUndefined()
    expect(root.sessions().files.has(sessionFile(inFlight.id))).toBe(true)
    expect((await storage.loadSession(inFlight.id)).note).toBe('lap 5')
    // …and the course is flyable again.
    await expect(storage.saveSession({ ...inFlight, note: 'lap 6' })).resolves.toBeUndefined()
  })

  it('a FAILED deleteCourse un-records the course, so its sessions stay saveable', async () => {
    const course = makeCourse()
    const { storage } = makeRig({
      hooks: {
        beforeCommit: (path) => {
          if (path === COURSES_FILE) throw new Error('backend exploded')
        },
      },
    })
    const error = await storage.deleteCourse(course.id).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isWriteFailedError(error)).toBe(true)

    // The cascade never committed, so the course is still standing and can
    // still be flown.
    await expect(
      storage.saveSession(makeSession({ courseId: course.id })),
    ).resolves.toBeUndefined()
  })

  it('importAll re-admits both id sets: a pre-delete export restores what was deleted', async () => {
    const { storage, root } = makeRig()
    const course = makeCourse()
    const session = makeSession({ courseId: course.id })
    const otherSession = makeSession()
    await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
    await storage.saveSession(session)
    await storage.saveSession(otherSession)

    const backup = await storage.exportAll()
    await storage.deleteCourse(course.id)
    await storage.deleteSession(otherSession.id)

    expect(await storage.importAll(backup)).toEqual({
      coursesAdded: 1,
      coursesSkipped: 0,
      sessionsAdded: 2,
      sessionsSkipped: 0,
    })
    expect((await storage.loadCourses()).courses).toEqual([course])
    expect(root.sessions().files.has(sessionFile(session.id))).toBe(true)
    expect(root.sessions().files.has(sessionFile(otherSession.id))).toBe(true)

    // Re-admitted for good: the restored sessions are writable again.
    await expect(storage.saveSession(session)).resolves.toBeUndefined()
    await expect(storage.saveSession(otherSession)).resolves.toBeUndefined()
  })

  it('resumePendingDeletions finishes an interrupted cascade and never rejects', async () => {
    const { storage, root } = makeRig()
    const course = makeCourse()
    const session = makeSession({ courseId: course.id })
    await storage.saveSession(session)
    // The crash state: INTENT written (course still present, marker recorded),
    // session files not yet removed.
    await storage.saveCourses({
      courses: [course],
      settings: {
        speechEnabled: true,
        pendingCourseDeletions: [
          { courseId: course.id, courseName: course.name, sessionIds: [session.id] },
        ],
      },
    })

    expect(await storage.resumePendingDeletions()).toEqual([
      { kind: 'completed', courseId: course.id, courseName: course.name, sessionsDeleted: 1 },
    ])
    const after = await storage.loadCourses()
    expect(after.courses).toEqual([])
    expect(after.settings.pendingCourseDeletions).toBeUndefined()
    expect(root.sessions().files.has(sessionFile(session.id))).toBe(false)
  })

  it('a completed resume leaves the course guarded: a session armed for it after the commit cannot land', async () => {
    const { storage, root } = makeRig()
    const course = makeCourse()
    const session = makeSession({ courseId: course.id })
    await storage.saveSession(session)
    await storage.saveCourses({
      courses: [course],
      settings: {
        speechEnabled: true,
        pendingCourseDeletions: [
          { courseId: course.id, courseName: course.name, sessionIds: [session.id] },
        ],
      },
    })

    await storage.resumePendingDeletions()

    // The resume ends in the same COMMIT as deleteCourse and leaves the course
    // guarded the same way: it is gone from courses.json, so a straggling
    // persister write for it would create a session file whose course does not
    // exist — the forbidden state. (A session armed while the resume was still
    // SCANNING is a different matter entirely: it lands, and it ABANDONS the
    // deletion — see the contract suite. Refusing it there is what inverted this
    // guard into a data-loss bug.)
    const armedAfterTheCommit = makeSession({ courseId: course.id })
    const error = await storage.saveSession(armedAfterTheCommit).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isNotFoundError(error)).toBe(true)
    expect(root.sessions().files.has(sessionFile(armedAfterTheCommit.id))).toBe(false)
  })

  it('an ABANDONED resume releases the course again, so it can still be flown', async () => {
    const { storage } = makeRig()
    const course = makeCourse()
    const confirmed = makeSession({ courseId: course.id, startedAt: '2026-07-12T10:00:00.000Z' })
    const flownSince = makeSession({ courseId: course.id, startedAt: '2026-07-13T10:00:00.000Z' })
    await storage.saveSession(confirmed)
    await storage.saveSession(flownSince)
    await storage.saveCourses({
      courses: [course],
      settings: {
        speechEnabled: true,
        pendingCourseDeletions: [
          { courseId: course.id, courseName: course.name, sessionIds: [confirmed.id] },
        ],
      },
    })

    expect(await storage.resumePendingDeletions()).toEqual([
      { kind: 'abandoned', courseId: course.id, courseName: course.name, reason: 'flown-since' },
    ])

    // The course survived the abandonment — leaving it condemned would make
    // every session flown on it reject not-found for the life of the tab.
    await expect(
      storage.saveSession(makeSession({ courseId: course.id })),
    ).resolves.toBeUndefined()
  })

  it('resumePendingDeletions resolves [] rather than rejecting when courses.json cannot be read', async () => {
    const { storage, root } = makeRig()
    root.files.set(COURSES_FILE, '{"schemaVersion":2,"courses":"shaped-differently"}')
    expect(await storage.resumePendingDeletions()).toEqual([])
  })

  it('a read-only instance rejects both deletes and resumes nothing', async () => {
    const locks = new FakeLockManager()
    const writer = makeRig({ locks }).storage
    await writer.saveCourses({ courses: [], settings: { speechEnabled: true } })

    const reader = makeRig({ locks }).storage
    const sessionError = await reader.deleteSession('any').then(
      () => undefined,
      (e: unknown) => e,
    )
    const courseError = await reader.deleteCourse('any').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isWriteFailedError(sessionError)).toBe(true)
    expect(isWriteFailedError(courseError)).toBe(true)
    expect((sessionError as Error).message).toContain('read-only')
    expect(await reader.resumePendingDeletions()).toEqual([])
  })
})

describe('OpfsStorage export integrity', () => {
  // A session file removed between the directory listing and its read — a
  // cascade running concurrently, or another tab. readDocument reports that as
  // status 'not-found' rather than throwing, which strict mode used to drop in
  // silence: a truncated backup, stamped lastExportAt, exactly where the
  // delete screen offers "Export backup first" as the only undo.
  function makeVanishingRig(first: string, vanishing: string) {
    const holder: { root?: FakeDirectory } = {}
    const rig = makeRig({
      hooks: {
        beforeRead: (path) => {
          if (path !== `${SESSIONS_DIR}/${first}`) return
          holder.root?.sessions().files.delete(vanishing)
        },
      },
    })
    holder.root = rig.root
    return rig
  }

  it('exportAll rejects when a listed session file vanishes mid-scan', async () => {
    const first = makeSession()
    const vanishing = makeSession()
    const rig = makeVanishingRig(`${first.id}.json`, `${vanishing.id}.json`)
    await rig.storage.saveSession(first)
    await rig.storage.saveSession(vanishing)

    const error = await rig.storage.exportAll().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isCorruptError(error)).toBe(true)
    expect((error as Error).message).toContain('disappeared during the scan')
    expect(rig.quarantines).toEqual([])
  })

  it('listSessions still skips it: availability over completeness', async () => {
    const first = makeSession()
    const vanishing = makeSession()
    const rig = makeVanishingRig(`${first.id}.json`, `${vanishing.id}.json`)
    await rig.storage.saveSession(first)
    await rig.storage.saveSession(vanishing)

    const summaries = await rig.storage.listSessions()
    expect(summaries.map((s) => s.id)).toEqual([first.id])
    expect(rig.quarantines).toEqual([])
  })
})

describe('OpfsStorage export contents', () => {
  it('strips the pending-deletion marker from the exported settings', async () => {
    const { storage } = makeRig()
    const course = makeCourse()
    await storage.saveCourses({
      courses: [course],
      settings: {
        speechEnabled: false,
        pendingCourseDeletions: [
          { courseId: course.id, courseName: course.name, sessionIds: [] },
        ],
      },
    })

    // The export is the backup a pilot inspects and restores from; the marker
    // is this store's in-flight bookkeeping, and has no business in it.
    expect((await storage.exportAll()).settings).toEqual({ speechEnabled: false })
    expect((await storage.loadCourses()).settings.pendingCourseDeletions).toHaveLength(1)
  })
})

describe('OpfsStorage clock injection', () => {
  it('exportAll stamps exportedAt from the injected clock', async () => {
    const { storage } = makeRig({ now: () => '2026-07-13T12:00:00.000Z' })
    await storage.saveSession(makeSession())
    const envelope = await storage.exportAll()
    expect(envelope.exportedAt).toBe('2026-07-13T12:00:00.000Z')
  })
})
