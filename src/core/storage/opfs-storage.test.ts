import { describe, expect, it } from 'vitest'
import type { OpfsDirectoryLike, OpfsFileHandleLike, OpfsStorageLike, OpfsWritableLike } from './opfs-probe'
import {
  COURSES_FILE,
  OpfsStorage,
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
import { describeStorageContract, makeSession } from './storage-contract'

function notFoundError(name: string): Error {
  return Object.assign(new Error(`entry "${name}" not found`), { name: 'NotFoundError' })
}

interface FakeOpfsHooks {
  // Called with the file's full path just before a writable commits on
  // close(); throw to make that write fail.
  beforeCommit?: (path: string) => void
  // Called with the file's full path when getFile() is requested; throw to
  // make that read fail like a transient infrastructure error.
  beforeRead?: (path: string) => void
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
          close: () => {
            this.hooks.beforeCommit?.(fullPath)
            this.files.set(name, buffer)
            return Promise.resolve()
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

describe('OpfsStorage clock injection', () => {
  it('exportAll stamps exportedAt from the injected clock', async () => {
    const { storage } = makeRig({ now: () => '2026-07-13T12:00:00.000Z' })
    await storage.saveSession(makeSession())
    const envelope = await storage.exportAll()
    expect(envelope.exportedAt).toBe('2026-07-13T12:00:00.000Z')
  })
})
