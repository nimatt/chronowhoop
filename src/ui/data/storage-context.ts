import type { SessionWriter } from '../../core/session/session-persister'
import type { Course, Session } from '../../core/domain/types'
import type { AppSettings, ExportEnvelope } from '../../core/storage/schema'
import type { QuarantineEvent } from '../../core/storage/opfs-storage'
import type {
  ImportResult,
  PersistenceStatus,
  ResumeOutcome,
  SessionSummary,
} from '../../core/storage/storage'
import type { NewCourseFields, RepoError, SettingsPatch } from './repos'

// App-level storage wiring (plan 06 item 7): one StorageContext is created per
// App.svelte mount and passed to screens via props (the diag/fly session
// precedent). It owns the Storage instance (OpfsStorage in production,
// MemoryStorage in tests), surfaces read-only mode, quarantine notices, and
// persistence status, and exposes the two repositories as reactive views —
// all low-frequency data, so plain $state per the bridge rule. The reactive
// implementation is storage-context.svelte.ts.
//
// THE STORAGE HANDLE IS NOT ON THIS INTERFACE, and that is the point (plan 09
// item 6). courses.json is a whole-document read-merge-write and
// CoursesRepo.enqueueWrite is the app's only serialization point for it; a
// screen holding a `Storage` could call saveCourses / deleteCourse / importAll
// / exportAll / resumePendingDeletions straight past the queue and resurrect a
// deleted course with its sessions already destroyed. That invariant used to be
// a comment in repos.ts, and the comment was already being violated (Home
// called storage.importAll, export-action called storage.exportAll) — so it is
// now structural: this interface exposes the two repository views, plus a
// SessionWriter narrow enough to be harmless, and no way to reach the rest.
// eslint.config.js's `seam/courses-json-critical-section` keeps it that way.

export interface QuarantineNotice extends QuarantineEvent {
  id: number
}

// A cascade a crash interrupted, finished (or abandoned) on this launch — see
// StorageContext.deletionNotices.
export interface DeletionNotice {
  id: number
  outcome: ResumeOutcome
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
  // Insert-or-replace by id; true on success.
  saveCourse(course: Course): Promise<boolean>
  // Resolves the created course (id/createdAt filled in), or null on failure.
  createCourse(fields: NewCourseFields): Promise<Course | null>
  // Never pendingCourseDeletions: the deletion cascade's crash-recovery journal
  // is not a setting and does not have a door here (see SettingsPatch in
  // repos.ts).
  updateSettings(partial: SettingsPatch): Promise<boolean>
  // Deletes the course and cascades to its sessions; true on success.
  //
  // CROSS-REPO INVALIDATION: the cascade removes session FILES behind
  // SessionsRepo's back, so it triggers the invalidation rule below — the
  // sessions repo must be refreshed afterwards. The composition point
  // (storage-context.svelte.ts) does that for every caller of this view, so
  // screens need not remember; nothing else may call Storage.deleteCourse.
  //
  // There is deliberately NO resumePendingDeletions here. Resuming an
  // interrupted cascade is a startup act, composed once in
  // storage-context.svelte.ts (repo call → sessions refresh → deletion
  // notices); nothing a screen holds has any business finishing a deletion, and
  // a second way in is a second post-condition to forget.
  deleteCourse(id: string): Promise<boolean>
  // Merge-by-id import of a parsed envelope; resolves the counts, or null on
  // failure (lastError set). Writes sessions too, so callers refresh the
  // sessions repo. Queued: the only door to Storage.importAll.
  importAll(envelope: ExportEnvelope): Promise<ImportResult | null>
  // Resolves the full export envelope, or null on failure (lastError set).
  // Queued, so it cannot observe a cascade half-done: the export file is this
  // product's only undo and does not get to be torn.
  exportAll(): Promise<ExportEnvelope | null>
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
  // Removes the session and drops its summary; true on success (lastError set
  // on failure — a delete the store refused is an app-wide condition, not a
  // per-caller miss). Idempotent: deleting an unknown id succeeds.
  deleteSession(id: string): Promise<boolean>
}

export interface StorageContext {
  // The live-session write path's handle: saveSession, and deliberately nothing
  // else (see SessionWriter). FlyFlow hands it to createFlySession →
  // createSessionPersister; it is the only Storage surface product code holds.
  readonly sessionWriter: SessionWriter
  // True when another tab holds the writer lock (OpfsStorage); refreshed
  // after every repository operation. Always false for storages without the
  // concept (MemoryStorage).
  readonly readOnly: boolean
  // The same answer, read from the storage instance at call time rather than
  // from the mirror above. The mirror only refreshes when a repository
  // operation settles, but the Web Locks answer settles — and can flip —
  // asynchronously, so anything gating a WRITE on it (the fly flow's arm, the
  // export's lastExportAt recording) must re-derive it at the moment of truth.
  // Callers used to reach through `context.storage` for this; that door is
  // closed, so the capability probe lives here.
  liveReadOnly(): boolean
  // null until the first persistenceStatus() answer arrives.
  readonly persistence: PersistenceStatus | null
  readonly quarantineNotices: readonly QuarantineNotice[]
  dismissQuarantineNotice(id: number): void
  // One per cascade resumed (or abandoned) by the startup call to
  // coursesRepo.resumePendingDeletions(). Rendered by App.svelte rather than a
  // screen: the app restores the last hash route, so a relaunch after a crashed
  // delete may never land on Home.
  readonly deletionNotices: readonly DeletionNotice[]
  dismissDeletionNotice(id: number): void
  readonly coursesRepo: CoursesRepoView
  readonly sessionsRepo: SessionsRepoView
  destroy(): void
}
