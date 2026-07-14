// In-memory Storage implementation — the workhorse for unit, component, and
// E2E tests (plan 06 item 2). Deep-copies on the way in AND out, so callers
// can never mutate stored state through a retained reference (the OPFS
// implementation gets the same isolation for free from JSON round-trips; the
// contract suite pins it for both).

import type { IsoDateString, Session } from '../domain/types'
import {
  deleteCourseFromStorage,
  resumePendingDeletionsFromStorage,
  settingsForExport,
} from './delete'
import { importIntoStorage } from './import'
import { defaultAppSettings, SCHEMA_VERSION, type ExportEnvelope } from './schema'
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

export interface MemoryStorageOptions {
  // Clock for ExportEnvelope.exportedAt.
  now?: () => IsoDateString
}

export class MemoryStorage implements Storage {
  private courses: CoursesData | undefined
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => IsoDateString

  // THE RESURRECTION GUARD (plan 09 item 4). Instance-scoped, never persisted:
  // ids deleted by THIS instance, so a straggling fire-and-forget saveSession
  // (fly-session.svelte.ts flushes the persister without awaiting it) cannot
  // re-create a session whose file — or whose whole course — the user just
  // destroyed.
  //
  // This store's writes are synchronous, so unlike OpfsStorage it has no
  // in-flight window to compensate for: the pre-check in saveSession is the
  // whole guard, with no post-write recheck-and-remove. The FIELDS and the
  // REJECTION are carried anyway, because MemoryStorage's job is to be
  // indistinguishable from OpfsStorage under the shared contract suite
  // (storage-contract.ts) — which asserts this rejection against both. A
  // MemoryStorage that quietly accepted a write for a deleted session would
  // green-light, in every unit and component test, behaviour the real storage
  // rejects.
  //
  // Likewise OpfsStorage's rule that a FAILED deleteSession must un-record the
  // id (or a session that still exists is permanently poisoned) is vacuous
  // here — nothing in this implementation can fail — but it is the same
  // contract, and any failure mode introduced here would have to honour it.
  //
  // Condemned (a deletion in flight) and deleted (its COMMIT landed) are kept
  // apart here too, for the same reason (see DeleteTarget in delete.ts). Both
  // refuse a write; the difference only shows on OpfsStorage, where only the
  // second may destroy a file — but the sets must not drift apart between the
  // two implementations, so the cascade drives them identically.
  private readonly deletedSessionIds = new Set<string>()
  private readonly condemnedCourseIds = new Set<string>()
  private readonly deletedCourseIds = new Set<string>()

  constructor(options: MemoryStorageOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  loadCourses(): Promise<CoursesData> {
    return Promise.resolve(
      this.courses ? structuredClone(this.courses) : { courses: [], settings: defaultAppSettings() },
    )
  }

  saveCourses(data: CoursesData): Promise<void> {
    this.courses = structuredClone(data)
    return Promise.resolve()
  }

  listSessions(): Promise<SessionSummary[]> {
    const summaries = [...this.sessions.values()]
      .sort((a, b) => compareSessionRecency(b, a))
      .map(summarizeSession)
    return Promise.resolve(summaries)
  }

  loadSession(id: string): Promise<Session> {
    const session = this.sessions.get(id)
    if (!session) {
      return Promise.reject(new StorageError('not-found', `session "${id}" does not exist`))
    }
    return Promise.resolve(structuredClone(session))
  }

  private isRefused(session: Session): boolean {
    return (
      this.deletedSessionIds.has(session.id) ||
      this.condemnedCourseIds.has(session.courseId) ||
      this.deletedCourseIds.has(session.courseId)
    )
  }

  saveSession(session: Session): Promise<void> {
    if (this.isRefused(session)) {
      return Promise.reject(
        new StorageError('not-found', `session "${session.id}" was deleted and cannot be re-created`),
      )
    }
    this.sessions.set(session.id, structuredClone(session))
    return Promise.resolve()
  }

  latestSessionForCourse(courseId: string): Promise<Session | undefined> {
    let latest: Session | undefined
    for (const session of this.sessions.values()) {
      if (session.courseId !== courseId) continue
      if (!latest || compareSessionRecency(session, latest) > 0) latest = session
    }
    return Promise.resolve(latest && structuredClone(latest))
  }

  async exportAll(): Promise<ExportEnvelope> {
    const { courses, settings } = await this.loadCourses()
    const sessions = [...this.sessions.values()]
      .sort(compareSessionRecency)
      .map((session) => structuredClone(session))
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: this.now(),
      courses,
      settings: settingsForExport(settings),
      sessions,
    }
  }

  // Re-admits every id the envelope carries BEFORE the merge runs: the export
  // file is the product's only undo, so importing one that still holds data
  // deleted earlier in this instance must restore it — and it cannot, if the
  // guard above rejects the first saveSession and aborts the import halfway.
  importAll(envelope: ExportEnvelope): Promise<ImportResult> {
    for (const course of envelope.courses) {
      this.condemnedCourseIds.delete(course.id)
      this.deletedCourseIds.delete(course.id)
    }
    for (const session of envelope.sessions) this.deletedSessionIds.delete(session.id)
    return importIntoStorage(this, envelope)
  }

  persistenceStatus(): Promise<PersistenceStatus> {
    return Promise.resolve({ persisted: true })
  }

  // Idempotent: an unknown id RESOLVES — the opposite of loadSession. Recorded
  // before the removal, matching the OPFS ordering: the guard must already be
  // closed when the session ceases to exist, not a moment after.
  deleteSession(id: string): Promise<void> {
    this.deletedSessionIds.add(id)
    this.sessions.delete(id)
    return Promise.resolve()
  }

  // The course half of the guard, driven by the shared cascade (delete.ts) —
  // from deleteCourse AND from the resume, which ends in the same COMMIT.
  condemnCourse(id: string): void {
    this.condemnedCourseIds.add(id)
  }

  releaseCourse(id: string): void {
    this.condemnedCourseIds.delete(id)
  }

  commitCourseDeletion(id: string): void {
    this.deletedCourseIds.add(id)
  }

  deleteCourse(id: string): Promise<DeleteCourseResult> {
    return deleteCourseFromStorage(this, id)
  }

  // No read-only concept here (that is OpfsStorage's writer lock), so no early
  // return. resumePendingDeletionsFromStorage never rejects.
  resumePendingDeletions(): Promise<ResumeOutcome[]> {
    return resumePendingDeletionsFromStorage(this)
  }
}
