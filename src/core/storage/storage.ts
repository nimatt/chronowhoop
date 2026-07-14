// The single persistence seam (CLAUDE.md, docs/specs/storage.md, ADR 0004):
// everything the app stores goes through this interface. Implementations:
// MemoryStorage (tests/UI workhorse), OpfsStorage (the real one); future
// backend sync and desktop folder mirroring slot in here.
//
// The interface trades in DOMAIN shapes (Course, Session, AppSettings). The
// `schemaVersion` envelopes, validators, and migrations are the file layer's
// concern (schema.ts + the OPFS implementation); callers never see them —
// with one deliberate exception: exportAll returns the full ExportEnvelope,
// because the envelope IS the export file's contract.

import type { Course, IsoDateString, Session } from '../domain/types'
import type { AppSettings, ExportEnvelope } from './schema'

export interface CoursesData {
  courses: Course[]
  settings: AppSettings
}

// Cheap derivations for list views (course view shows the session list without
// loading every session body). No session index file exists in v1 —
// implementations derive summaries by scanning sessions.
export interface SessionSummary {
  id: string
  courseId: string
  startedAt: IsoDateString
  lapCount: number
  validLapCount: number
}

export interface PersistenceStatus {
  // Whether the underlying storage is protected from eviction
  // (navigator.storage.persisted() for OPFS; always true for MemoryStorage).
  persisted: boolean
}

// storage.md import semantics (merge by ID): what landed vs. what was
// already there, reported to the user after every import.
export interface ImportResult {
  coursesAdded: number
  coursesSkipped: number
  sessionsAdded: number
  sessionsSkipped: number
}

// What the cascade destroyed, so the caller can say it out loud (the confirm
// screen promised a count; a partial failure has to be able to contradict it).
export interface DeleteCourseResult {
  sessionsDeleted: number
}

// The result of finishing — or refusing to finish — a cascade that a crash
// interrupted between its INTENT and COMMIT writes (see deleteCourse).
export type ResumeOutcome =
  | { kind: 'completed'; courseId: string; courseName: string; sessionsDeleted: number }
  // The course was flown again after the interrupted deletion: sessions exist
  // that the user never confirmed deleting. The deletion is ABANDONED and the
  // marker cleared — we never destroy data the confirmation screen did not
  // count. The course survives intact; deleting it again re-states the real,
  // current blast radius.
  | { kind: 'abandoned'; courseId: string; courseName: string; reason: 'flown-since' }

export interface Storage {
  // Never rejects with 'not-found': empty storage yields no courses and
  // default settings. DOES reject with 'unsupported-version' when the stored
  // document was written by a newer app — returning defaults there would let
  // the next save entrench an empty courses.json over intact data.
  loadCourses(): Promise<CoursesData>
  // Replaces the whole courses+settings document.
  saveCourses(data: CoursesData): Promise<void>
  // Newest first: descending session recency (see compareSessionRecency).
  // Availability over completeness: an unreadable session file (infrastructure
  // failure or unsupported version) is skipped, never fails the listing;
  // loadSession on the same id surfaces the failure directly.
  listSessions(): Promise<SessionSummary[]>
  // Rejects with StorageError kind 'not-found' for unknown ids.
  loadSession(id: string): Promise<Session>
  // Insert-or-replace by session.id.
  saveSession(session: Session): Promise<void>
  // The most recent session for the course (by compareSessionRecency), or
  // undefined if the course has none. Feeds detection-config prefill.
  latestSessionForCourse(courseId: string): Promise<Session | undefined>
  // Assembles the full export envelope; sessions ordered oldest → newest.
  // Exports must be trustworthy: a session file that cannot be read
  // (infrastructure failure or unsupported version) REJECTS the export rather
  // than silently omitting data. Files quarantined as corrupt are the only
  // omissions — the quarantining read already removed them and reported
  // through the implementation's quarantine channel.
  exportAll(): Promise<ExportEnvelope>
  // Merge by ID (storage.md): unknown courses/sessions added, existing ids
  // skipped, local settings untouched; courses land before sessions. A
  // mid-import write failure rejects with that write's StorageError and the
  // counts so far are lost — re-importing the same file is the recovery
  // (merge-by-ID makes it idempotent). Implementations share
  // importIntoStorage (import.ts); the envelope comes from parseImportFile.
  // Known in-tab race (accepted): the course write-back re-persists the
  // settings read at import start, so a concurrent fire-and-forget settings
  // write (e.g. lastExportAt after an export) can be reverted — costs at most
  // one extra backup nudge.
  importAll(envelope: ExportEnvelope): Promise<ImportResult>
  persistenceStatus(): Promise<PersistenceStatus>
  // Removes the session's file. IDEMPOTENT: an unknown id RESOLVES — it never
  // rejects 'not-found'. That is the OPPOSITE of loadSession above, so it gets
  // implemented wrong unless it is written down: a double-tap and a retry after
  // a partially-applied cascade must both be safe, and neither is if the second
  // call throws. Byte-level by filename: the document is never read, so a
  // corrupt or unsupported-version session is removed as long as its id is
  // known — deletion is the one operation a broken file cannot refuse.
  // Quarantine copies (<id>.json.corrupt.<ts>) are never touched: quarantining
  // was a deliberate rescue, and this is not the quarantine manager.
  deleteSession(id: string): Promise<void>
  // Deletes the course AND every session whose courseId === id (cascade, not
  // orphaning: nothing else would ever list those sessions again, but exportAll
  // has no course filter, so they would ride out in every export and come back
  // as "Unknown course" on every import).
  //
  // TWO-PHASE, because ADR 0010 gives per-file atomicity only: there is no
  // multi-file transaction here, so the only thing left to choose is WHICH
  // crash state you get. This one is self-describing and self-healing:
  //   1. write courses.json with the course STILL PRESENT and the pending-
  //      deletion marker added — the exact session ids, captured now    [INTENT]
  //   2. remove those session files
  //   3. re-read courses.json and write it back without the course and without
  //      the marker                                                     [COMMIT]
  //   4. re-list sessions and remove any that still name the course     [SWEEP]
  // Step 4 is what forbids the ghost state (a readable session file whose
  // course is gone) without letting a deletion that has NOT committed destroy
  // anything: a write that raced the cascade and landed anyway is removed only
  // once the course is definitively gone. A cascade that fails before its
  // COMMIT destroys nothing it did not explicitly deleteSession.
  //
  // Every read that can reject runs BEFORE step 1. loadCourses can throw
  // 'unsupported-version', and discovering that after the session files are
  // gone would strand condemned data in a state no retry can finish: the
  // sessions destroyed, the course still standing, and no marker to say so.
  // Step 3 re-reads rather than reusing the step-1 snapshot, so a concurrent
  // write (or another course's commit) is not reverted by this one.
  //
  // Idempotent: an unknown course id still sweeps sessions referencing it —
  // that is precisely the retry path after a cascade that died mid-flight.
  // Clears settings.lastCourseId in the commit write when it pointed here.
  deleteCourse(id: string): Promise<DeleteCourseResult>
  // Finishes — or abandons — any cascade interrupted between steps 1 and 3,
  // replaying only the session ids the marker recorded. NEVER REJECTS: this
  // runs at startup, where there is no one to retry it, so a failed resume
  // leaves the marker in place for the next launch rather than surfacing an
  // error nobody can act on. Resolves [] when nothing is pending, and on a
  // read-only instance, which holds no writer lock and must not try.
  resumePendingDeletions(): Promise<ResumeOutcome[]>
}

// 'unsupported-version': the document is intact but written by a newer app
// (or no migration chain reaches it). Refused in place — never quarantined —
// so a version rollback strands no data; Phase 7 import reuses this kind for
// its refuse-newer rule.
//
// Deletion adds no kind: it is a write, and fails like one ('write-failed' /
// 'quota-exceeded' — a two-phase delete writes courses.json twice, so it can
// hit quota even while freeing space). A read-only tab rejects 'write-failed'
// through OpfsStorage's guardWriter(), and that is the REAL guard: readOnly is
// still false for up to LOCK_RETRY_DELAY_MS while the lock request settles, so
// a delete button disabled on that flag is cosmetic — the storage layer, not
// the UI, is what makes a second tab harmless.
export type StorageErrorKind =
  | 'not-found'
  | 'corrupt'
  | 'quota-exceeded'
  | 'write-failed'
  | 'unsupported-version'

export class StorageError extends Error {
  readonly kind: StorageErrorKind

  constructor(kind: StorageErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StorageError'
    this.kind = kind
  }
}

export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError
}

export function isNotFoundError(error: unknown): error is StorageError & { kind: 'not-found' } {
  return isStorageError(error) && error.kind === 'not-found'
}

export function isCorruptError(error: unknown): error is StorageError & { kind: 'corrupt' } {
  return isStorageError(error) && error.kind === 'corrupt'
}

export function isQuotaExceededError(
  error: unknown,
): error is StorageError & { kind: 'quota-exceeded' } {
  return isStorageError(error) && error.kind === 'quota-exceeded'
}

export function isWriteFailedError(
  error: unknown,
): error is StorageError & { kind: 'write-failed' } {
  return isStorageError(error) && error.kind === 'write-failed'
}

export function isUnsupportedVersionError(
  error: unknown,
): error is StorageError & { kind: 'unsupported-version' } {
  return isStorageError(error) && error.kind === 'unsupported-version'
}

// Session recency order, shared by every implementation so listSessions and
// latestSessionForCourse can never disagree: primarily startedAt (as epoch
// ms); ties break by id (code-unit order), the larger id counting as newer —
// an arbitrary but deterministic choice, since ids are random UUIDs.
// Ascending: negative when `a` is older than `b`.
export function compareSessionRecency(
  a: Pick<Session, 'id' | 'startedAt'>,
  b: Pick<Session, 'id' | 'startedAt'>,
): number {
  const timeDelta = Date.parse(a.startedAt) - Date.parse(b.startedAt)
  if (timeDelta !== 0 && !Number.isNaN(timeDelta)) return timeDelta
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function summarizeSession(session: Session): SessionSummary {
  return {
    id: session.id,
    courseId: session.courseId,
    startedAt: session.startedAt,
    lapCount: session.laps.length,
    validLapCount: session.laps.filter((lap) => lap.status === 'valid').length,
  }
}
