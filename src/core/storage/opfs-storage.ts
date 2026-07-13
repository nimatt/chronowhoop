// OPFS implementation of the Storage seam (plan 06 item 4, ADR 0010). Layout
// per docs/specs/storage.md: `courses.json` at the root, one
// `sessions/<id>.json` per session. Every write goes through createWritable(),
// whose swap-file commit-on-close replaces content atomically — an interrupted
// write leaves the previous bytes intact. A file that fails JSON.parse or
// schema validation is quarantined aside as `<name>.corrupt.<ts>` and treated
// as absent; one bad session file loses one session, never the app. A file
// whose schemaVersion this app cannot read (newer app, or no migration chain)
// is REFUSED in place — StorageError 'unsupported-version', file untouched —
// so a version rollback strands no data. A Web Locks single-writer lock (held
// for the instance lifetime) makes additional tabs read-only; a denied lock
// request is re-tried once after a short delay before the instance settles
// into read-only, so a refresh race with a dying predecessor tab cannot
// permanently strand a lone tab.
//
// There is deliberately NO startup sweep (ADR 0010 amendment): our own writes
// leave no artifacts (createWritable's `.crswap` staging files are
// browser-managed, and deleting one could race another tab's in-flight write),
// quarantine files are kept on purpose, and reads skip every non-`.json` name.

import type { IsoDateString, Session } from '../domain/types'
import {
  defaultAppSettings,
  parseCoursesFile,
  parseSessionFile,
  SCHEMA_VERSION,
  SchemaError,
  SchemaVersionError,
  type ExportEnvelope,
  type SessionFile,
} from './schema'
import {
  compareSessionRecency,
  StorageError,
  summarizeSession,
  type CoursesData,
  type ImportResult,
  type PersistenceStatus,
  type SessionSummary,
  type Storage,
} from './storage'
import { defaultOpfsStorage, type OpfsDirectoryLike, type OpfsStorageLike } from './opfs-probe'

export const COURSES_FILE = 'courses.json'
export const SESSIONS_DIR = 'sessions'
export const WRITER_LOCK_NAME = 'chronowhoop-storage'
export const LOCK_RETRY_DELAY_MS = 1500

// Structural Web Locks surface (navigator.locks). With `ifAvailable: true` the
// callback receives null when another holder exists; otherwise the lock stays
// held while the callback's returned promise is pending.
export interface LocksLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>
}

export function defaultLocks(): LocksLike | undefined {
  const global = globalThis as { navigator?: { locks?: LocksLike } }
  return global.navigator?.locks
}

export interface QuarantineEvent {
  fileName: string
  // Absent when the corrupt bytes could not be copied aside (read-only
  // instance, or the quarantine write itself failed); the original file is
  // then left in place so the bytes are never destroyed without a copy.
  quarantinedTo?: string
  reason: string
}

export interface OpfsStorageOptions {
  // navigator.storage by default; also serves persist()/persisted().
  storage?: OpfsStorageLike
  // navigator.locks by default. Pass the key explicitly as undefined to model
  // an absent Web Locks API (the instance then proceeds as the writer).
  locks?: LocksLike
  // Where the file layout lives — the OPFS root by default. Tests point this
  // at a throwaway subdirectory for isolation.
  rootDirectory?: () => Promise<OpfsDirectoryLike>
  // Clock for ExportEnvelope.exportedAt and quarantine-file timestamps.
  now?: () => IsoDateString
  onQuarantine?: (event: QuarantineEvent) => void
  // Schedules the single re-request after a denied writer-lock attempt.
  // Default: setTimeout with LOCK_RETRY_DELAY_MS; tests inject their own.
  scheduleLockRetry?: (retry: () => void) => void
}

type ReadResult<T> = { status: 'ok'; value: T } | { status: 'not-found' | 'quarantined' }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNotFoundException(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundError'
}

function toWriteError(context: string, error: unknown): StorageError {
  if (error instanceof StorageError) return error
  if (error instanceof Error && error.name === 'QuotaExceededError') {
    return new StorageError('quota-exceeded', `${context}: storage quota exceeded`, {
      cause: error,
    })
  }
  return new StorageError('write-failed', `${context}: ${errorMessage(error)}`, { cause: error })
}

// Read-side infrastructure failures (an unreadable handle, a broken backend)
// map to 'corrupt' — the taxonomy's read-failure kind. Missing files are
// 'not-found'; parse/validation failures quarantine instead of throwing.
function toReadError(context: string, error: unknown): StorageError {
  if (error instanceof StorageError) return error
  return new StorageError('corrupt', `${context}: ${errorMessage(error)}`, { cause: error })
}

// Validating the (tiny) document before it is written turns "a future read
// quarantines the file" into an immediate write-failed, before bad bytes ever
// reach disk.
function assertValidDocument(validate: () => unknown, context: string): void {
  try {
    validate()
  } catch (error) {
    if (error instanceof SchemaError) {
      throw new StorageError(
        'write-failed',
        `${context}: refusing to write an invalid document: ${error.message}`,
        { cause: error },
      )
    }
    throw error
  }
}

function sessionFileName(id: string): string {
  return `${id}.json`
}

function filenameSafeTimestamp(iso: IsoDateString): string {
  return iso.replace(/[^0-9A-Za-z._-]/g, '-')
}

function toSession(file: SessionFile): Session {
  const { id, courseId, startedAt, note, detectionConfig, laps } = file
  return { id, courseId, startedAt, note, detectionConfig, laps }
}

export class OpfsStorage implements Storage {
  private readonly storageManager: OpfsStorageLike | undefined
  private readonly openRootDirectory: () => Promise<OpfsDirectoryLike>
  private readonly now: () => IsoDateString
  private readonly onQuarantine: ((event: QuarantineEvent) => void) | undefined
  private readonly writerLockGranted: Promise<boolean>
  private releaseWriterLock: () => void = () => {}
  private disposed = false
  private isReadOnly = false
  private persistRequested = false
  private rootPromise: Promise<OpfsDirectoryLike> | undefined

  constructor(options: OpfsStorageOptions = {}) {
    const storageManager = 'storage' in options ? options.storage : defaultOpfsStorage()
    this.storageManager = storageManager
    this.openRootDirectory =
      options.rootDirectory ??
      (() => {
        if (typeof storageManager?.getDirectory !== 'function') {
          throw new StorageError('write-failed', 'navigator.storage.getDirectory is not available')
        }
        return storageManager.getDirectory()
      })
    this.now = options.now ?? (() => new Date().toISOString())
    this.onQuarantine = options.onQuarantine
    const locks = 'locks' in options ? options.locks : defaultLocks()
    const scheduleLockRetry =
      options.scheduleLockRetry ??
      ((retry: () => void) => {
        setTimeout(retry, LOCK_RETRY_DELAY_MS)
      })
    this.writerLockGranted = this.acquireWriterLock(locks, scheduleLockRetry)
    void this.writerLockGranted.then((granted) => {
      this.isReadOnly = !granted
    })
  }

  // False until the Web Locks request resolves (writes await that resolution
  // internally, so they can never slip past a pending answer).
  get readOnly(): boolean {
    return this.isReadOnly
  }

  // Releases the writer lock so another instance can become the writer. The
  // instance is not meant to be used afterwards; product code holds the lock
  // for the page lifetime, tests release it between cases.
  dispose(): void {
    this.disposed = true
    this.releaseWriterLock()
  }

  private acquireWriterLock(
    locks: LocksLike | undefined,
    scheduleRetry: (retry: () => void) => void,
  ): Promise<boolean> {
    // No Web Locks API: proceed as the writer — single-tab environments lose
    // nothing, and there is no cross-tab guard to be had anyway.
    if (typeof locks?.request !== 'function') return Promise.resolve(true)
    return new Promise((resolve) => {
      const attempt = (retriesLeft: number) => {
        locks
          .request(WRITER_LOCK_NAME, { ifAvailable: true }, (lock) => {
            if (lock === null) {
              // A denied ifAvailable request would otherwise be permanent,
              // but the denial may be a refresh race: the predecessor tab
              // still held the lock while dying. One delayed re-request
              // before settling keeps a lone tab from being stranded
              // read-only; writes await the grant answer, so nothing races
              // the retry window.
              if (retriesLeft > 0 && !this.disposed) {
                scheduleRetry(() => {
                  attempt(retriesLeft - 1)
                })
              } else {
                resolve(false)
              }
              return Promise.resolve()
            }
            resolve(true)
            // dispose() may run before the lock manager invokes this callback
            // (a purely-reading instance never awaits the grant); holding the
            // lock then would leak it past the instance's lifetime.
            if (this.disposed) return Promise.resolve()
            return new Promise<void>((release) => {
              this.releaseWriterLock = release
            })
          })
          // A failing request means the API is unusable, not that another tab
          // holds the lock — treated like the absent-API case.
          .catch(() => {
            resolve(true)
          })
      }
      attempt(1)
    })
  }

  private root(): Promise<OpfsDirectoryLike> {
    if (!this.rootPromise) {
      const promise = Promise.resolve()
        .then(() => this.openRootDirectory())
        .catch((error: unknown) => {
          // Never cache the rejection: the next operation must retry opening
          // the root instead of replaying a possibly-transient failure.
          if (this.rootPromise === promise) this.rootPromise = undefined
          throw toWriteError('opening OPFS storage root', error)
        })
      this.rootPromise = promise
    }
    return this.rootPromise
  }

  private async sessionsDirectory(options: { create: boolean }): Promise<OpfsDirectoryLike | undefined> {
    const root = await this.root()
    if (typeof root.getDirectoryHandle !== 'function') {
      throw new StorageError(
        'write-failed',
        'FileSystemDirectoryHandle.getDirectoryHandle is not available',
      )
    }
    try {
      return await root.getDirectoryHandle(SESSIONS_DIR, options)
    } catch (error) {
      if (!options.create && isNotFoundException(error)) return undefined
      throw options.create
        ? toWriteError(`opening ${SESSIONS_DIR}/`, error)
        : toReadError(`opening ${SESSIONS_DIR}/`, error)
    }
  }

  private async guardWriter(): Promise<void> {
    if (!(await this.writerLockGranted)) {
      throw new StorageError('write-failed', 'read-only: another tab holds the lock')
    }
  }

  private async writeTextFile(dir: OpfsDirectoryLike, name: string, text: string): Promise<void> {
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(text)
      await writable.close()
    } catch (error) {
      // Never closing already leaves the previous content intact (ADR 0010);
      // abort is best-effort cleanup of the swap file, not correctness.
      await writable.abort?.().catch(() => {})
      throw error
    }
  }

  private async readDocument<T>(
    dir: OpfsDirectoryLike,
    name: string,
    parse: (doc: unknown) => T,
  ): Promise<ReadResult<T>> {
    let text: string
    try {
      const handle = await dir.getFileHandle(name)
      if (typeof handle.getFile !== 'function') {
        throw new Error('FileSystemFileHandle.getFile is not available')
      }
      text = await (await handle.getFile()).text()
    } catch (error) {
      if (isNotFoundException(error)) return { status: 'not-found' }
      throw toReadError(`reading ${name}`, error)
    }

    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch (error) {
      await this.quarantine(dir, name, text, `invalid JSON: ${errorMessage(error)}`)
      return { status: 'quarantined' }
    }
    try {
      return { status: 'ok', value: parse(doc) }
    } catch (error) {
      // A version this app cannot read is refused in place — the file stays
      // untouched for the newer app (or a fixed migration chain) to read.
      // Quarantining here would destroy every document after a version
      // rollback and let the next settings write entrench an empty file.
      if (error instanceof SchemaVersionError) {
        throw new StorageError('unsupported-version', `reading ${name}: ${error.message}`, {
          cause: error,
        })
      }
      if (error instanceof SchemaError) {
        await this.quarantine(dir, name, text, error.message)
        return { status: 'quarantined' }
      }
      throw toReadError(`reading ${name}`, error)
    }
  }

  // "Rename aside" per ADR 0010: OPFS has no rename, so the corrupt bytes are
  // copied to `<name>.corrupt.<ts>` and the original removed. Read-only
  // instances skip the file operations (they hold no write lock) and only
  // report; the writer tab quarantines for real on its next read.
  private async quarantine(
    dir: OpfsDirectoryLike,
    name: string,
    rawText: string,
    reason: string,
  ): Promise<void> {
    let quarantinedTo: string | undefined
    if (await this.writerLockGranted) {
      const target = `${name}.corrupt.${filenameSafeTimestamp(this.now())}`
      try {
        await this.writeTextFile(dir, target, rawText)
        quarantinedTo = target
        await dir.removeEntry(name).catch(() => {})
      } catch {
        // Copying the bytes aside failed — leave the original in place rather
        // than destroy the only copy; the next read retries.
      }
    }
    this.onQuarantine?.({
      fileName: name,
      ...(quarantinedTo === undefined ? {} : { quarantinedTo }),
      reason,
    })
  }

  // 'skip-unreadable' (listSessions, latestSessionForCourse): one unreadable
  // session file loses one session, never the listing (ADR 0010) — quarantined
  // files, infrastructure read failures, and unsupported versions are all
  // skipped; loadSession on the same id surfaces the failure directly.
  // 'strict' (exportAll): an export that silently omitted sessions would be a
  // lossy backup the user trusts — infrastructure failures and unsupported
  // versions reject. Quarantined files are the only omissions: the read that
  // quarantined them already moved them aside and fired onQuarantine.
  private async loadAllSessions(mode: 'skip-unreadable' | 'strict'): Promise<Session[]> {
    const dir = await this.sessionsDirectory({ create: false })
    if (!dir) return []
    if (typeof dir.keys !== 'function') {
      throw new StorageError('corrupt', `listing ${SESSIONS_DIR}/: directory iteration is not available`)
    }
    // Names are collected before any file is read: a quarantine mutates the
    // directory (adds the .corrupt copy, removes the original), which must not
    // happen under a live directory iterator.
    const names: string[] = []
    for await (const name of dir.keys()) {
      // Skips `.crswap` staging artifacts and `.corrupt.<ts>` quarantine
      // files — neither ends in `.json`.
      if (name.endsWith('.json')) names.push(name)
    }
    const sessions: Session[] = []
    for (const name of names) {
      try {
        const result = await this.readDocument(dir, name, parseSessionFile)
        if (result.status === 'ok') sessions.push(toSession(result.value))
      } catch (error) {
        if (mode === 'strict') throw toReadError(`reading ${name}`, error)
      }
    }
    return sessions
  }

  // Requests durable storage lazily on the first successful save — the first
  // moment real data exists (plan 06 item 4). Fire-and-forget by design: the
  // grant answer surfaces through persistenceStatus(), and a denied or failed
  // request must never fail a save.
  private requestPersistOnce(): void {
    if (this.persistRequested) return
    this.persistRequested = true
    if (typeof this.storageManager?.persist !== 'function') return
    try {
      this.storageManager.persist().catch(() => {})
    } catch {
      // The grant answer (or its absence) surfaces via persistenceStatus().
    }
  }

  async loadCourses(): Promise<CoursesData> {
    const root = await this.root()
    const result = await this.readDocument(root, COURSES_FILE, parseCoursesFile)
    if (result.status !== 'ok') return { courses: [], settings: defaultAppSettings() }
    return { courses: result.value.courses, settings: result.value.settings }
  }

  async saveCourses(data: CoursesData): Promise<void> {
    await this.guardWriter()
    const file = {
      schemaVersion: SCHEMA_VERSION,
      courses: data.courses,
      settings: data.settings,
    }
    assertValidDocument(() => parseCoursesFile(file), `saving ${COURSES_FILE}`)
    const text = JSON.stringify(file)
    try {
      await this.writeTextFile(await this.root(), COURSES_FILE, text)
    } catch (error) {
      throw toWriteError(`saving ${COURSES_FILE}`, error)
    }
    this.requestPersistOnce()
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessions = await this.loadAllSessions('skip-unreadable')
    return sessions.sort((a, b) => compareSessionRecency(b, a)).map(summarizeSession)
  }

  async loadSession(id: string): Promise<Session> {
    const notFound = () => new StorageError('not-found', `session "${id}" does not exist`)
    const dir = await this.sessionsDirectory({ create: false })
    if (!dir) throw notFound()
    const result = await this.readDocument(dir, sessionFileName(id), parseSessionFile)
    if (result.status !== 'ok') throw notFound()
    return toSession(result.value)
  }

  async saveSession(session: Session): Promise<void> {
    await this.guardWriter()
    const name = sessionFileName(session.id)
    const file = { schemaVersion: SCHEMA_VERSION, ...session }
    assertValidDocument(() => parseSessionFile(file), `saving ${SESSIONS_DIR}/${name}`)
    const text = JSON.stringify(file)
    try {
      const dir = await this.sessionsDirectory({ create: true })
      if (!dir) throw new Error(`${SESSIONS_DIR}/ could not be created`)
      await this.writeTextFile(dir, name, text)
    } catch (error) {
      throw toWriteError(`saving ${SESSIONS_DIR}/${name}`, error)
    }
    this.requestPersistOnce()
  }

  async latestSessionForCourse(courseId: string): Promise<Session | undefined> {
    let latest: Session | undefined
    for (const session of await this.loadAllSessions('skip-unreadable')) {
      if (session.courseId !== courseId) continue
      if (!latest || compareSessionRecency(session, latest) > 0) latest = session
    }
    return latest
  }

  async exportAll(): Promise<ExportEnvelope> {
    const { courses, settings } = await this.loadCourses()
    const sessions = (await this.loadAllSessions('strict')).sort(compareSessionRecency)
    return { schemaVersion: SCHEMA_VERSION, exportedAt: this.now(), courses, settings, sessions }
  }

  importAll(): Promise<ImportResult> {
    return Promise.reject(new Error('importAll is not implemented until Phase 7'))
  }

  async persistenceStatus(): Promise<PersistenceStatus> {
    if (typeof this.storageManager?.persisted !== 'function') return { persisted: false }
    try {
      return { persisted: await this.storageManager.persisted() }
    } catch {
      return { persisted: false }
    }
  }
}
