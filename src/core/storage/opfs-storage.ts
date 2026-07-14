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
// Deletion (plan 09, ADR 0011) is byte-level: a session file is removed by
// name with removeEntry and never read first, so a corrupt or
// unsupported-version file can still be deleted; a course deletes through the
// two-phase cascade shared with MemoryStorage (delete.ts). An in-memory,
// instance-scoped resurrection guard makes a write that was already in flight
// when a delete ran converge on "gone" — see deletedSessionIds,
// condemnedCourseIds and deletedCourseIds. Condemning only ever REFUSES a
// write; only a destruction that actually happened may remove a file.
//
// There is deliberately NO startup sweep (ADR 0010 amendment): our own writes
// leave no artifacts (createWritable's `.crswap` staging files are
// browser-managed, and deleting one could race another tab's in-flight write),
// quarantine files are kept on purpose, and reads skip every non-`.json` name.

import type { IsoDateString, Session } from '../domain/types'
import {
  deleteCourseFromStorage,
  resumePendingDeletionsFromStorage,
  settingsForExport,
} from './delete'
import { importIntoStorage } from './import'
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
  type DeleteCourseResult,
  type ImportResult,
  type PersistenceStatus,
  type ResumeOutcome,
  type SessionSummary,
  type Storage,
} from './storage'
import { defaultOpfsStorage, type OpfsDirectoryLike, type OpfsStorageLike } from './opfs-probe'

export const COURSES_FILE = 'courses.json'
export const SESSIONS_DIR = 'sessions'
export const WRITER_LOCK_NAME = 'chronowhoop-storage'
export const LOCK_RETRY_DELAY_MS = 1500
// Attempts at removing a session file that a racing write re-created after its
// delete (see removeResurrectedFile). More than one because the removal is the
// last line of defence against a session file outliving its course, and OPFS
// removals fail transiently (a handle still settling); few, because there is a
// pilot waiting on this write and a persistent failure has to be reported, not
// retried at.
export const RESURRECTION_REMOVAL_ATTEMPTS = 3

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
  // THE RESURRECTION GUARD (plan 09 item 4, ADR 0011). In-memory and
  // instance-scoped ON PURPOSE — these are NOT tombstones. Persisting them
  // would make importIntoStorage silently drop sessions the user just handed
  // it, and re-importing a pre-delete export is the only undo this product
  // has. They exist solely to close the window in which a write already in
  // flight when a delete ran re-creates the file it just removed.
  private readonly deletedSessionIds = new Set<string>()
  // Why COURSE sets as well as a session set: deleteCourse knows exactly the
  // ids in its pre-cascade listSessions() snapshot, so the session set cannot
  // know about a session that is not on disk yet. But the fly screen fires
  // `void persister.flush()` (fly-session.svelte.ts) — fire-and-forget,
  // outliving its component — and saveSession opens with { create: true }. A
  // persister write for a session armed moments before the delete (first write
  // still in flight, or in a write-failed retry) would land AFTER the commit
  // and create a session file whose course is gone: exactly the ghost state the
  // cascade exists to prevent. Guarding by courseId catches those unborn
  // sessions too.
  //
  // TWO course sets, not one, because REFUSING and DESTROYING are not the same
  // authority:
  //
  // condemnedCourseIds — a deletion is in flight. It may still fail at its very
  //   first write (quota on the INTENT write ends the cascade having destroyed
  //   nothing) or be abandoned by the resume's flown-since rule. A condemned
  //   course may only REFUSE new session writes. If it could also destroy, a
  //   delete that did nothing would remove the file of a write that raced it —
  //   a straggling persister write, for a session the pilot is still flying.
  // deletedCourseIds — the cascade's COMMIT write landed. The course is gone
  //   from courses.json for good, so a session file of it that appears anyway
  //   is the forbidden state and IS removed (removeResurrectedFile). This set
  //   is only ever added to after the commit, and never released.
  //
  // Both sets refuse; only the second destroys. Both are cleared by importAll,
  // which re-admits exactly what it restores.
  private readonly condemnedCourseIds = new Set<string>()
  private readonly deletedCourseIds = new Set<string>()

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
  // files, infrastructure read failures, unsupported versions, and files that
  // vanish mid-scan are all skipped; loadSession on the same id surfaces the
  // failure directly.
  // 'strict' (exportAll): an export that silently omitted sessions would be a
  // lossy backup the user trusts — infrastructure failures, unsupported
  // versions, AND a listed name that reads back not-found all reject.
  // Quarantined files are the only omissions: the read that quarantined them
  // already moved them aside and fired onQuarantine.
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
      let result: ReadResult<SessionFile>
      try {
        result = await this.readDocument(dir, name, parseSessionFile)
      } catch (error) {
        if (mode === 'strict') throw toReadError(`reading ${name}`, error)
        continue
      }
      if (result.status === 'ok') {
        sessions.push(toSession(result.value))
        continue
      }
      // The name WAS listed and then read back not-found: the file vanished
      // between the listing and the read (a cascade removing it, another tab).
      // readDocument reports that as a status rather than a throw, so strict
      // mode would otherwise drop the session from the export in silence —
      // handing the user a truncated backup and then stamping lastExportAt on
      // it, right where "Export backup first" makes that backup the only undo.
      if (mode === 'strict' && result.status === 'not-found') {
        throw new StorageError(
          'corrupt',
          `reading ${name}: the file disappeared during the scan — refusing to export without it`,
        )
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

  private isRefused(session: Session): boolean {
    return (
      this.deletedSessionIds.has(session.id) ||
      this.condemnedCourseIds.has(session.courseId) ||
      this.deletedCourseIds.has(session.courseId)
    )
  }

  // THE DESTRUCTIVE HALF OF THE GUARD, and deliberately NARROWER than
  // isRefused: a session file may only be removed on behalf of a destruction
  // that ACTUALLY HAPPENED — this exact session id was deleteSession'd, or this
  // course's cascade reached its COMMIT. A merely CONDEMNED course is a
  // deletion still in flight, which may fail at its first write and destroy
  // nothing at all; compensating for it would let a delete that did nothing
  // remove the file a racing persister write had just landed — the pilot's
  // laps, erased by a deletion that never happened.
  private wasDestroyed(session: Session): boolean {
    return this.deletedSessionIds.has(session.id) || this.deletedCourseIds.has(session.courseId)
  }

  private assertWritable(session: Session): void {
    if (!this.isRefused(session)) return
    // 'not-found' rather than 'write-failed' on purpose: SessionPersister
    // retries write-failed and nothing else, so a straggling tail write for a
    // deleted session dies quietly here instead of retrying its way back onto
    // disk (session-persister.ts).
    throw new StorageError(
      'not-found',
      `session "${session.id}" was deleted — refusing to write it back`,
    )
  }

  // The write we just made re-created a file a delete had already removed
  // ({ create: true } does that), so THIS REMOVAL IS THE ONLY THING between the
  // app and the state the cascade exists to forbid: a readable session file
  // whose course is gone. Swallowing a failure here (the old
  // `.catch(() => {})`) left that file on disk permanently — invisible, because
  // no screen lists a session whose course is gone, and unattributable, because
  // the only thing that knows it should be gone is this instance's in-memory
  // guard, which dies with the page. It would then ride out in every future
  // export as "Unknown course".
  //
  // So the failure is retried and then RAISED, as the write failure it is: the
  // caller (SessionPersister) retries 'write-failed' once, that retry's
  // pre-check rejects 'not-found', and the persister gives up — while the app's
  // storage-error channel has said out loud that a write did not land.
  // Deliberately NOT routed through onQuarantine: nothing here is corrupt and
  // nothing was set aside, which is precisely what that notice claims.
  private async removeResurrectedFile(dir: OpfsDirectoryLike, name: string): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < RESURRECTION_REMOVAL_ATTEMPTS; attempt++) {
      try {
        await dir.removeEntry(name)
        return
      } catch (error) {
        // Already gone (a concurrent delete beat us to it) is the outcome we
        // wanted.
        if (isNotFoundException(error)) return
        lastError = error
      }
    }
    throw new StorageError(
      'write-failed',
      `removing ${SESSIONS_DIR}/${name}: the session was deleted while this write was in flight and the re-created file could not be removed — it may now outlive its course: ${errorMessage(lastError)}`,
      { cause: lastError },
    )
  }

  async saveSession(session: Session): Promise<void> {
    await this.guardWriter()
    this.assertWritable(session)
    const name = sessionFileName(session.id)
    const file = { schemaVersion: SCHEMA_VERSION, ...session }
    assertValidDocument(() => parseSessionFile(file), `saving ${SESSIONS_DIR}/${name}`)
    const text = JSON.stringify(file)
    try {
      const dir = await this.sessionsDirectory({ create: true })
      if (!dir) throw new Error(`${SESSIONS_DIR}/ could not be created`)
      await this.writeTextFile(dir, name, text)
      // Checked AGAIN after the write, because the check above is passed by a
      // write that was already inside writeTextFile when the destruction ran:
      // the { create: true } handle then re-creates the file that was removed.
      // wasDestroyed, NOT isRefused — a deletion that is merely in flight has
      // destroyed nothing and gets no compensation here. What it cannot catch
      // (a session that was never on disk, so no id names it) the cascade's
      // post-commit sweep does, once the deletion is a fact (delete.ts).
      if (this.wasDestroyed(session)) {
        await this.removeResurrectedFile(dir, name)
        this.assertWritable(session)
      }
    } catch (error) {
      // toWriteError returns a StorageError unchanged, so the 'not-found'
      // above surfaces as 'not-found' and is not rewrapped as 'write-failed'.
      throw toWriteError(`saving ${SESSIONS_DIR}/${name}`, error)
    }
    this.requestPersistOnce()
  }

  async deleteSession(id: string): Promise<void> {
    await this.guardWriter()
    // Recorded BEFORE the I/O so a saveSession racing this removal loses: it
    // either fails its pre-check, or compensates its own write afterwards.
    this.deletedSessionIds.add(id)
    const name = sessionFileName(id)
    try {
      const dir = await this.sessionsDirectory({ create: false })
      if (!dir) return
      // removeEntry, as quarantine() already uses — not FileSystemHandle.remove().
      await dir.removeEntry(name)
    } catch (error) {
      // An unknown id RESOLVES: the file is gone, which is all deleteSession
      // promises. Idempotence is what makes a double-tap and the retry after a
      // partially-applied cascade safe.
      if (isNotFoundException(error)) return
      // A FAILED delete must UN-RECORD the id. The session still exists, and
      // leaving it in the guard set would poison it for the life of this tab:
      // every later saveSession would reject 'not-found', and the live
      // persister — which retries 'write-failed' and nothing else — would
      // silently stop saving laps for a session the user is still flying.
      this.deletedSessionIds.delete(id)
      throw toWriteError(`deleting ${SESSIONS_DIR}/${name}`, error)
    }
  }

  // The course half of the guard. Driven by the shared cascade (delete.ts) so
  // the resume — which ends in the same COMMIT — condemns, releases and commits
  // exactly as deleteCourse does, instead of the two drifting apart. See the
  // DeleteTarget doc comment for why refusing and destroying are separate
  // authorities.
  condemnCourse(id: string): void {
    this.condemnedCourseIds.add(id)
  }

  // Release is the same un-record rule deleteSession has, for the same reason:
  // a cascade that failed (or a resume that abandoned) leaves the course
  // standing, and a course left condemned would make every session flown on it
  // reject 'not-found' for the rest of the tab's life. Sessions the cascade DID
  // remove stay guarded by deletedSessionIds, which deleteSession recorded one
  // by one — releasing the course never re-admits them.
  releaseCourse(id: string): void {
    this.condemnedCourseIds.delete(id)
  }

  commitCourseDeletion(id: string): void {
    this.deletedCourseIds.add(id)
  }

  async deleteCourse(id: string): Promise<DeleteCourseResult> {
    // Fail fast, before the cascade's read-before-destroy scan: a read-only
    // instance holds no writer lock and every write it attempts would reject.
    await this.guardWriter()
    return deleteCourseFromStorage(this, id)
  }

  // Never rejects (the contract): resumePendingDeletionsFromStorage swallows a
  // failed entry and leaves its marker for the next launch.
  resumePendingDeletions(): Promise<ResumeOutcome[]> {
    return this.writerLockGranted.then((granted) =>
      // A read-only instance holds no writer lock, so it can finish nothing —
      // and must not try. The writer tab resumes; this one reports [].
      granted ? resumePendingDeletionsFromStorage(this) : [],
    )
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
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: this.now(),
      courses,
      settings: settingsForExport(settings),
      sessions,
    }
  }

  // RE-ADMITS the ids it is about to write before delegating. The import is the
  // undo: importing an export that still contains something deleted earlier in
  // this tab must restore it, not abort mid-import on the guard's 'not-found'.
  importAll(envelope: ExportEnvelope): Promise<ImportResult> {
    for (const course of envelope.courses) {
      this.condemnedCourseIds.delete(course.id)
      this.deletedCourseIds.delete(course.id)
    }
    for (const session of envelope.sessions) this.deletedSessionIds.delete(session.id)
    return importIntoStorage(this, envelope)
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
