import type { Course, Session } from '../../core/domain/types'
import type { AppSettings } from '../../core/storage/schema'
import type { QuarantineEvent } from '../../core/storage/opfs-storage'
import type { PersistenceStatus, SessionSummary, Storage } from '../../core/storage/storage'
import type { NewCourseFields, RepoError } from './repos'

// App-level storage wiring (plan 06 item 7): one StorageContext is created per
// App.svelte mount and passed to screens via props (the diag/fly session
// precedent). It owns the Storage instance (OpfsStorage in production,
// MemoryStorage in tests), surfaces read-only mode, quarantine notices, and
// persistence status, and exposes the two repositories as reactive views —
// all low-frequency data, so plain $state per the bridge rule. The reactive
// implementation is storage-context.svelte.ts.

export interface QuarantineNotice extends QuarantineEvent {
  id: number
}

// Reactive view over CoursesRepo (repos.ts): fields are $state-backed
// mirrors, methods delegate. Ops never reject — failures land in lastError.
export interface CoursesRepoView {
  readonly loaded: boolean
  readonly courses: readonly Course[]
  readonly settings: AppSettings
  readonly lastError: RepoError | null
  courseById(id: string): Course | undefined
  ensureLoaded(): Promise<void>
  reload(): Promise<void>
  // Insert-or-replace by id; true on success.
  saveCourse(course: Course): Promise<boolean>
  // Resolves the created course (id/createdAt filled in), or null on failure.
  createCourse(fields: NewCourseFields): Promise<Course | null>
  updateSettings(partial: Partial<AppSettings>): Promise<boolean>
}

export interface SessionsRepoView {
  readonly loaded: boolean
  // Newest first.
  readonly summaries: readonly SessionSummary[]
  readonly lastError: RepoError | null
  sessionsForCourse(courseId: string): SessionSummary[]
  ensureLoaded(): Promise<void>
  // Invalidation rule: any write that bypasses this repo (the session
  // persister during a flight, Phase 7 import) leaves `summaries` stale —
  // readers after such writes must call refresh(). CourseView refreshes on
  // every mount for exactly this reason.
  refresh(): Promise<void>
  // Per-caller queries: resolve undefined on failure — never reject, and
  // never touch lastError; the caller handles the miss locally.
  loadSession(id: string): Promise<Session | undefined>
  latestForCourse(courseId: string): Promise<Session | undefined>
  // Insert-or-replace by id; true on success (session-view note editing).
  saveSession(session: Session): Promise<boolean>
}

export interface StorageContext {
  readonly storage: Storage
  // True when another tab holds the writer lock (OpfsStorage); refreshed
  // after every repository operation. Always false for storages without the
  // concept (MemoryStorage).
  readonly readOnly: boolean
  // null until the first persistenceStatus() answer arrives.
  readonly persistence: PersistenceStatus | null
  readonly quarantineNotices: readonly QuarantineNotice[]
  dismissQuarantineNotice(id: number): void
  readonly coursesRepo: CoursesRepoView
  readonly sessionsRepo: SessionsRepoView
  destroy(): void
}
