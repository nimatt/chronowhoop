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

// storage.md import semantics (merge by ID, existing IDs skipped) — the
// implementation is Phase 7; Phase 6 implementations reject from importAll.
export interface ImportResult {
  coursesAdded: number
  coursesSkipped: number
  sessionsAdded: number
  sessionsSkipped: number
}

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
  // Phase 7. Phase 6 implementations reject with a plain Error (not a
  // StorageError — calling it is a programming error, not a storage failure).
  importAll(envelope: ExportEnvelope): Promise<ImportResult>
  persistenceStatus(): Promise<PersistenceStatus>
}

// 'unsupported-version': the document is intact but written by a newer app
// (or no migration chain reaches it). Refused in place — never quarantined —
// so a version rollback strands no data; Phase 7 import reuses this kind for
// its refuse-newer rule.
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
