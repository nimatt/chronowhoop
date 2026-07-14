// Plain-TS repository classes over the Storage seam (plan 06 item 7): they own
// the loaded snapshots, upsert semantics, and error surfacing, and are fully
// node-testable against MemoryStorage. The reactive layer is a thin mirror in
// storage-context.svelte.ts — these classes report every state change through
// `onChange`, and never throw into their callers: failures land in
// `lastError` and ops report success/failure through their return values.
//
// THE COURSES.JSON CRITICAL SECTION (plan 09 item 6). courses.json is a
// whole-document read-merge-write, and `CoursesRepo.enqueueWrite` is the app's
// ONLY serialization point for it. EVERY operation that reads-then-writes that
// document — or that must not observe it half-done — goes through the queue,
// with no exceptions: saveCourse, updateSettings, deleteCourse,
// resumePendingDeletions, importAll and exportAll. Nothing outside this class
// may call the corresponding Storage members. Two unsynchronized read-merge-
// write cycles do not merely race: the loser's whole document is overwritten
// from a stale snapshot, which is how a deleted course comes back from the
// dead with its sessions genuinely destroyed.

import type { CrossingDirection } from '../../core/detection/crossing-events'
import type { Course, IsoDateString, Session } from '../../core/domain/types'
import {
  defaultAppSettings,
  type AppSettings,
  type ExportEnvelope,
} from '../../core/storage/schema'
import {
  isStorageError,
  summarizeSession,
  type ImportResult,
  type ResumeOutcome,
  type SessionSummary,
  type Storage,
  type StorageErrorKind,
} from '../../core/storage/storage'

export interface RepoError {
  kind: StorageErrorKind | 'unknown'
  message: string
}

function toRepoError(error: unknown): RepoError {
  if (isStorageError(error)) return { kind: error.kind, message: error.message }
  return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

export function findCourseById(courses: readonly Course[], id: string): Course | undefined {
  return courses.find((course) => course.id === id)
}

export function filterSessionsForCourse(
  summaries: readonly SessionSummary[],
  courseId: string,
): SessionSummary[] {
  return summaries.filter((summary) => summary.courseId === courseId)
}

export interface NewCourseFields {
  name: string
  direction: CrossingDirection
  minLapTimeMs: number
}

export interface CoursesRepoOptions {
  now?: () => IsoDateString
  newId?: () => string
  onChange?: () => void
}

export interface CoursesSnapshot {
  loaded: boolean
  courses: readonly Course[]
  settings: AppSettings
  lastError: RepoError | null
}

// What a caller may write through updateSettings. `pendingCourseDeletions` is
// excluded on purpose: it is the deletion cascade's two-phase-commit journal
// (plan 09 item 1), owned by src/core/storage, and it rides inside AppSettings
// only because courses.json is the document it lives in. Writing it through the
// settings door would let any screen forge a work list — or clear a live one
// while its sessions are already gone, which is the unrecoverable state the
// marker exists to prevent. Settings writes still carry the on-disk value
// through untouched (the merge below preserves it).
export type SettingsPatch = Partial<Omit<AppSettings, 'pendingCourseDeletions'>>

export class CoursesRepo {
  private readonly storage: Storage
  private readonly nowFn: () => IsoDateString
  private readonly newId: () => string
  private readonly onChange: () => void

  private loadedFlag = false
  private loadPromise: Promise<void> | undefined
  private coursesList: Course[] = []
  private settingsData: AppSettings = defaultAppSettings()
  private lastErrorValue: RepoError | null = null
  private lastWrite: Promise<unknown> = Promise.resolve()
  private commits = 0

  constructor(storage: Storage, options: CoursesRepoOptions = {}) {
    this.storage = storage
    this.nowFn = options.now ?? (() => new Date().toISOString())
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.onChange = options.onChange ?? (() => {})
  }

  get loaded(): boolean {
    return this.loadedFlag
  }

  get courses(): readonly Course[] {
    return this.coursesList
  }

  get settings(): AppSettings {
    return this.settingsData
  }

  get lastError(): RepoError | null {
    return this.lastErrorValue
  }

  get snapshot(): CoursesSnapshot {
    return {
      loaded: this.loadedFlag,
      courses: this.coursesList,
      settings: this.settingsData,
      lastError: this.lastErrorValue,
    }
  }

  courseById(id: string): Course | undefined {
    return findCourseById(this.coursesList, id)
  }

  // Load-once: concurrent and repeated calls share one storage read. A failed
  // load is not cached — the next call retries.
  ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.reload().finally(() => {
      if (!this.loadedFlag) this.loadPromise = undefined
    })
    return this.loadPromise
  }

  // Two rules here, and both of them exist to stop a deleted course coming back.
  //
  // 1. A LOAD THAT A COMMITTED WRITE OVERTOOK IS DISCARDED. reload() runs
  //    outside enqueueWrite (queuing it would deadlock the ensureLoaded that
  //    queued writes await from inside the queue), so a read that started before
  //    a write committed can still land after it — putting the snapshot back
  //    behind the disk, which the next persist() would then write out. Loads
  //    therefore carry the commit count they started with and drop their result
  //    when a write landed under them. Dropping cannot strand the repo: every
  //    op that bumps the counter either sets the snapshot itself (persist) or
  //    reloads inside its own queued turn (deleteCourse / importAll /
  //    resumePendingDeletions), so the fresher answer always arrives.
  //
  // 2. A FAILED LOAD INVALIDATES — it does not preserve. Keeping the previous
  //    snapshot with `loaded` still true is the same resurrection by another
  //    door: storage.deleteCourse commits, this reload throws (OPFS maps any
  //    read failure to 'corrupt'), coursesList still holds the deleted course
  //    and settingsData is the pre-delete copy — and the next fire-and-forget
  //    updateSettings persists both, re-instating the course AND erasing the
  //    intent marker whose sessions are already destroyed. saveCourse and
  //    updateSettings both bail on !loadedFlag, so dropping the flag makes every
  //    write fail safe; clearing loadPromise keeps the load-once cache honest
  //    (it caches successes only) so the next ensureLoaded retries the read.
  async reload(): Promise<void> {
    const commitsAtRead = this.commits
    try {
      const data = await this.storage.loadCourses()
      if (this.commits !== commitsAtRead) return
      this.coursesList = data.courses
      this.settingsData = data.settings
      this.loadedFlag = true
      this.lastErrorValue = null
    } catch (error) {
      this.loadedFlag = false
      this.loadPromise = undefined
      this.lastErrorValue = toRepoError(error)
    }
    this.onChange()
  }

  // Writes are serialized: courses.json is a whole-document save, so two
  // concurrent read-merge-write cycles would silently drop each other's
  // changes. Each queued op starts only after the previous one settled and
  // reads the then-current snapshot before merging. Reads (ensureLoaded /
  // reload) stay outside the queue — queuing reload would deadlock the
  // ensureLoaded a queued write awaits.
  private enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const run = this.lastWrite.then(op, op)
    this.lastWrite = run.then(
      () => {},
      () => {},
    )
    return run
  }

  // Insert-or-replace by course.id; resolves true on success. On failure the
  // in-memory snapshot is left unchanged (no optimistic mutation).
  saveCourse(course: Course): Promise<boolean> {
    return this.enqueueWrite(async () => {
      await this.ensureLoaded()
      if (!this.loadedFlag) return false
      const exists = this.coursesList.some((each) => each.id === course.id)
      const next = exists
        ? this.coursesList.map((each) => (each.id === course.id ? course : each))
        : [...this.coursesList, course]
      return this.persist(next, this.settingsData)
    })
  }

  // Resolves the created course, or null when the save failed (lastError set).
  async createCourse(fields: NewCourseFields): Promise<Course | null> {
    const course: Course = { id: this.newId(), ...fields, createdAt: this.nowFn() }
    return (await this.saveCourse(course)) ? course : null
  }

  // SettingsPatch, not Partial<AppSettings>: the crash-recovery journal is not a
  // setting and cannot be written through this door (see SettingsPatch). The
  // merge carries the loaded value of pendingCourseDeletions through unchanged,
  // so a settings write never disturbs a live marker.
  updateSettings(partial: SettingsPatch): Promise<boolean> {
    return this.enqueueWrite(async () => {
      await this.ensureLoaded()
      if (!this.loadedFlag) return false
      const merged = { ...this.settingsData, ...partial }
      for (const key of Object.keys(merged) as (keyof AppSettings)[]) {
        if (merged[key] === undefined) delete merged[key]
      }
      return this.persist(this.coursesList, merged)
    })
  }

  // Deletes the course and cascades to its sessions (SessionsRepo's summaries
  // go stale — storage-context composes the refresh). Resolves true on success;
  // false with lastError set on failure.
  //
  // RELOAD ON BOTH OUTCOMES, and the failure arm is not defensive padding:
  // - On success the storage rewrote courses.json from its own read, so this
  //   repo's cached snapshot still holds the deleted course.
  // - On failure the cascade may have died anywhere between its INTENT and
  //   COMMIT writes: courses.json was already rewritten (marker added) and real
  //   session files are already gone.
  // Skip either reload and the next fire-and-forget updateSettings — FlyFlow
  // writing lastCourseId when the pilot arms — persists the stale coursesList
  // through persist(), which RESURRECTS THE DELETED COURSE: empty, and with its
  // sessions genuinely destroyed. That is the nastiest bug this queue prevents,
  // and it needs no race at all: the delete can have committed minutes earlier.
  // Resolves true when the cascade committed, even if the reload that follows it
  // then failed: the course IS gone from disk, and reporting "the course is
  // still here. Try again." would be a lie. The failed reload is not swallowed —
  // it leaves the repo unloaded with lastError set, so no write can persist the
  // stale list and the app-wide storage error is on screen.
  deleteCourse(id: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      try {
        await this.storage.deleteCourse(id)
        this.noteCommit()
        await this.reload()
        return true
      } catch (error) {
        this.noteCommit()
        // Reload first, then record: reload() clears lastError on success, and
        // the delete failure is the error worth surfacing.
        await this.reload()
        this.recordError(error)
        return false
      }
    })
  }

  // Finishes (or abandons) a cascade a crash interrupted — the startup call,
  // routed HERE and never at the storage directly. A resume is a second
  // read-merge-write cycle over courses.json: run outside this queue, against a
  // snapshot this repo does not share, it loses data with no race at all (see
  // deleteCourse — the resume commits, the stale coursesList still holds the
  // course, the next updateSettings writes it back).
  //
  // storage.resumePendingDeletions() never rejects (see its contract): it runs
  // at startup, where there is nobody to retry it, so a failed resume keeps its
  // marker for the next launch instead of raising an error no one can act on.
  resumePendingDeletions(): Promise<ResumeOutcome[]> {
    return this.enqueueWrite(async () => {
      const outcomes = await this.storage.resumePendingDeletions()
      // It rewrote courses.json behind this repo's back — but only if it
      // actually did something.
      if (outcomes.length > 0) {
        this.noteCommit()
        await this.reload()
      }
      return outcomes
    })
  }

  // Resolves the merge counts, or null when the import failed (lastError set).
  //
  // Queued because importIntoStorage snapshots the course list BEFORE its
  // session writes and writes courses.json from that snapshot: a delete
  // committing inside that prelude is reverted by it — the course comes back
  // while its sessions stay destroyed.
  //
  // Reload on BOTH outcomes: a mid-import failure can still have landed the
  // course write-back, so the stale snapshot would drop the imported courses on
  // the next settings write either way.
  importAll(envelope: ExportEnvelope): Promise<ImportResult | null> {
    return this.enqueueWrite(async () => {
      try {
        const result = await this.storage.importAll(envelope)
        this.noteCommit()
        await this.reload()
        return result
      } catch (error) {
        this.noteCommit()
        await this.reload()
        this.recordError(error)
        return null
      }
    })
  }

  // Resolves the envelope, or null when the export failed (lastError set).
  //
  // A READ — but queued, because it must not observe a cascade half-done.
  // Storage.exportAll reads courses.json and scans the session files as two
  // unsynchronized reads; a cascade committing between them yields an envelope
  // whose course is already gone while its sessions are still listed, and those
  // sessions come back as orphans on every re-import. The export file is this
  // product's only undo, so it does not get to be torn.
  //
  // No reload(): it writes nothing.
  exportAll(): Promise<ExportEnvelope | null> {
    return this.enqueueWrite(async () => {
      try {
        const envelope = await this.storage.exportAll()
        this.lastErrorValue = null
        this.onChange()
        return envelope
      } catch (error) {
        this.recordError(error)
        return null
      }
    })
  }

  private recordError(error: unknown): void {
    this.lastErrorValue = toRepoError(error)
    this.onChange()
  }

  // Records that courses.json may have changed on disk, so any load already in
  // flight is now stale (see reload). Called in the same turn the write settles
  // — before any further await — on BOTH outcomes of the storage-level writes,
  // because a cascade or an import that threw can still have landed its first
  // write.
  private noteCommit(): void {
    this.commits += 1
  }

  private async persist(courses: Course[], settings: AppSettings): Promise<boolean> {
    try {
      await this.storage.saveCourses({ courses, settings })
      this.noteCommit()
      this.coursesList = courses
      this.settingsData = settings
      this.lastErrorValue = null
      this.onChange()
      return true
    } catch (error) {
      this.recordError(error)
      return false
    }
  }
}

export interface SessionsRepoOptions {
  onChange?: () => void
}

export interface SessionsSnapshot {
  loaded: boolean
  summaries: readonly SessionSummary[]
  lastError: RepoError | null
}

export class SessionsRepo {
  private readonly storage: Storage
  private readonly onChange: () => void

  private loadedFlag = false
  private loadPromise: Promise<void> | undefined
  private summariesList: SessionSummary[] = []
  private lastErrorValue: RepoError | null = null

  constructor(storage: Storage, options: SessionsRepoOptions = {}) {
    this.storage = storage
    this.onChange = options.onChange ?? (() => {})
  }

  get loaded(): boolean {
    return this.loadedFlag
  }

  // Newest first (the Storage contract's listSessions order).
  get summaries(): readonly SessionSummary[] {
    return this.summariesList
  }

  get lastError(): RepoError | null {
    return this.lastErrorValue
  }

  get snapshot(): SessionsSnapshot {
    return {
      loaded: this.loadedFlag,
      summaries: this.summariesList,
      lastError: this.lastErrorValue,
    }
  }

  ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.refresh().finally(() => {
      if (!this.loadedFlag) this.loadPromise = undefined
    })
    return this.loadPromise
  }

  // The invalidation point: writes that bypass this repo (the session
  // persister during a flight, Phase 7 import) leave the summaries stale
  // until someone calls refresh(). A successful refresh clears lastError.
  async refresh(): Promise<void> {
    try {
      this.summariesList = await this.storage.listSessions()
      this.loadedFlag = true
      this.lastErrorValue = null
    } catch (error) {
      this.lastErrorValue = toRepoError(error)
    }
    this.onChange()
  }

  sessionsForCourse(courseId: string): SessionSummary[] {
    return filterSessionsForCourse(this.summariesList, courseId)
  }

  // Resolves undefined on any failure (including not-found) — repos never
  // reject into the UI. Deliberately does NOT touch lastError: this is a
  // per-caller query (a not-found session view, a skipped unreadable session
  // in the course records scan) whose failure the caller handles locally,
  // not an app-wide storage condition.
  async loadSession(id: string): Promise<Session | undefined> {
    try {
      return await this.storage.loadSession(id)
    } catch {
      return undefined
    }
  }

  // Insert-or-replace by session.id (note editing on the session view);
  // resolves true on success (clearing lastError). An already-listed
  // session's summary is updated in place; unknown ids appear on the next
  // refresh().
  async saveSession(session: Session): Promise<boolean> {
    try {
      await this.storage.saveSession(session)
      this.summariesList = this.summariesList.map((summary) =>
        summary.id === session.id ? summarizeSession(session) : summary,
      )
      this.lastErrorValue = null
      this.onChange()
      return true
    } catch (error) {
      this.lastErrorValue = toRepoError(error)
      this.onChange()
      return false
    }
  }

  // Removes the session and drops its summary from the list; resolves true on
  // success (clearing lastError). Idempotent at the seam: deleting an unknown
  // id resolves, so a double-tap is safe.
  //
  // Unlike loadSession / latestForCourse, this one DOES set lastError on
  // failure: those are per-caller queries whose miss the caller handles locally
  // (a not-found session view, a skipped unreadable session in a records scan),
  // whereas a delete that could not be written is an app-wide storage condition
  // — the user asked for destruction and the store refused.
  async deleteSession(id: string): Promise<boolean> {
    try {
      await this.storage.deleteSession(id)
      this.summariesList = this.summariesList.filter((summary) => summary.id !== id)
      this.lastErrorValue = null
      this.onChange()
      return true
    } catch (error) {
      this.lastErrorValue = toRepoError(error)
      this.onChange()
      return false
    }
  }

  // Resolves undefined both when the course has no sessions and on failure —
  // prefill callers fall back to defaults either way, so like loadSession
  // this query does not touch lastError.
  async latestForCourse(courseId: string): Promise<Session | undefined> {
    try {
      return await this.storage.latestSessionForCourse(courseId)
    } catch {
      return undefined
    }
  }
}
