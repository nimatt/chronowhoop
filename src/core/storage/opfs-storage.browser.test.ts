// OpfsStorage against REAL OPFS in the browser rig (plan 06 item 4): the full
// Storage contract suite, plus the ADR 0010 crash-simulation and quarantine
// round-trip tests. Isolation: every storage instance is rooted in a
// throwaway `chronowhoop-opfs-storage-test-<uuid>` subdirectory of the
// origin's OPFS root, removed recursively in cleanup — the production layout
// at the real root is never touched.

import { afterEach, describe, expect, it } from 'vitest'
import {
  OpfsStorage,
  SESSIONS_DIR,
  WRITER_LOCK_NAME,
  type OpfsStorageOptions,
  type QuarantineEvent,
} from './opfs-storage'
import { isNotFoundError } from './storage'
import { describeStorageContract, makeSession } from './storage-contract'

const TEST_ROOT_PREFIX = 'chronowhoop-opfs-storage-test-'

async function createTestRoot() {
  const opfsRoot = await navigator.storage.getDirectory()
  const name = `${TEST_ROOT_PREFIX}${crypto.randomUUID()}`
  const dir = await opfsRoot.getDirectoryHandle(name, { create: true })
  return {
    dir,
    remove: async () => {
      await opfsRoot.removeEntry(name, { recursive: true }).catch(() => {})
    },
  }
}

describeStorageContract('OpfsStorage (real OPFS)', async () => {
  const { dir, remove } = await createTestRoot()
  const storage = new OpfsStorage({ rootDirectory: () => Promise.resolve(dir) })
  return Object.assign(storage, {
    cleanup: async () => {
      storage.dispose()
      await remove()
    },
  })
})

describe('OpfsStorage crash simulation and quarantine (real OPFS)', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function openStorage(options: Partial<OpfsStorageOptions> = {}) {
    const { dir, remove } = await createTestRoot()
    cleanups.push(remove)
    const storage = new OpfsStorage({ rootDirectory: () => Promise.resolve(dir), ...options })
    cleanups.push(() => {
      storage.dispose()
    })
    return { storage, dir }
  }

  async function sessionFileHandle(dir: FileSystemDirectoryHandle, sessionId: string) {
    const sessions = await dir.getDirectoryHandle(SESSIONS_DIR)
    return sessions.getFileHandle(`${sessionId}.json`)
  }

  it('abort() mid-write leaves the previously saved session intact', async () => {
    const { storage, dir } = await openStorage()
    const session = makeSession({ note: 'survives the abort' })
    await storage.saveSession(session)

    const handle = await sessionFileHandle(dir, session.id)
    const writable = await handle.createWritable()
    await writable.write('{"schemaVersion":1,"id":"torn')
    await writable.abort()

    expect(await storage.loadSession(session.id)).toEqual(session)
  })

  it('a partial write that never closes leaves the committed content readable', async () => {
    const { storage, dir } = await openStorage()
    const session = makeSession({ note: 'survives the open writable' })
    await storage.saveSession(session)

    const handle = await sessionFileHandle(dir, session.id)
    const writable = await handle.createWritable()
    await writable.write('garbage that must never be committed')
    // Deliberately never closed — the read below is the reload-equivalent
    // check that the swap file has not replaced the committed bytes. The
    // writable is aborted only during cleanup, after the assertions, so the
    // recursive directory removal cannot race an open swap file.
    cleanups.push(async () => {
      await writable.abort().catch(() => {})
    })

    expect(await storage.loadSession(session.id)).toEqual(session)
    expect((await storage.listSessions()).map((s) => s.id)).toEqual([session.id])
  })

  it('quarantines a session file corrupted on disk: not-found, .corrupt.<ts> copy, listing survives', async () => {
    const quarantines: QuarantineEvent[] = []
    const { storage, dir } = await openStorage({
      onQuarantine: (event) => quarantines.push(event),
    })
    const corrupted = makeSession({ note: 'will be corrupted' })
    const survivor = makeSession({ startedAt: '2026-07-11T09:00:00.000Z' })
    await storage.saveSession(corrupted)
    await storage.saveSession(survivor)

    const garbage = '{"schemaVersion":1, truncated mid-wri'
    const handle = await sessionFileHandle(dir, corrupted.id)
    const writable = await handle.createWritable()
    await writable.write(garbage)
    await writable.close()

    const error = await storage.loadSession(corrupted.id).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isNotFoundError(error)).toBe(true)

    const sessions = await dir.getDirectoryHandle(SESSIONS_DIR)
    const names: string[] = []
    for await (const name of sessions.keys()) names.push(name)
    expect(names).not.toContain(`${corrupted.id}.json`)
    const quarantineFile = names.find((name) => name.startsWith(`${corrupted.id}.json.corrupt.`))
    expect(quarantineFile).toBeDefined()
    const preserved = await (await (await sessions.getFileHandle(quarantineFile ?? '')).getFile()).text()
    expect(preserved).toBe(garbage)

    expect(quarantines).toEqual([
      {
        fileName: `${corrupted.id}.json`,
        quarantinedTo: quarantineFile,
        reason: expect.stringContaining('invalid JSON') as string,
      },
    ])
    expect((await storage.listSessions()).map((s) => s.id)).toEqual([survivor.id])
  })

  it('a second instance is read-only under the real Web Locks API (retry also denied)', async () => {
    const { storage: writer } = await openStorage()
    await writer.saveCourses({ courses: [], settings: { speechEnabled: true } })
    expect(writer.readOnly).toBe(false)

    // Immediate retry: the writer still holds the lock, so the single
    // re-request is denied too and the instance settles read-only.
    const { storage: second } = await openStorage({
      scheduleLockRetry: (retry) => setTimeout(retry, 0),
    })
    const error = await second.saveSession(makeSession()).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toMatchObject({
      name: 'StorageError',
      kind: 'write-failed',
      message: expect.stringContaining('read-only') as string,
    })
    expect(second.readOnly).toBe(true)
    expect(await second.listSessions()).toEqual([])
  })

  it('a refresh race resolves: denied at startup, granted on the retry after the predecessor releases', async () => {
    const { storage: predecessor } = await openStorage()
    await predecessor.saveCourses({ courses: [], settings: { speechEnabled: true } })

    let retry: (() => void) | undefined
    const { storage: successor } = await openStorage({
      scheduleLockRetry: (fn) => {
        retry = fn
      },
    })
    // The real lock manager answers the ifAvailable request asynchronously;
    // wait for the denial to schedule the retry.
    for (let i = 0; retry === undefined && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(retry).toBeDefined()

    predecessor.dispose()
    for (let i = 0; i < 100; i++) {
      const state = await navigator.locks.query()
      if (!state.held?.some((lock) => lock.name === WRITER_LOCK_NAME)) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    retry?.()

    await successor.saveCourses({ courses: [], settings: { speechEnabled: false } })
    expect(successor.readOnly).toBe(false)
  })
})
