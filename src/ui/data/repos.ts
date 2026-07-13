// Plain-TS repository classes over the Storage seam (plan 06 item 7): they own
// the loaded snapshots, upsert semantics, and error surfacing, and are fully
// node-testable against MemoryStorage. The reactive layer is a thin mirror in
// storage-context.svelte.ts — these classes report every state change through
// `onChange`, and never throw into their callers: failures land in
// `lastError` and ops report success/failure through their return values.

import type { CrossingDirection } from '../../core/detection/crossing-events'
import type { Course, IsoDateString, Session } from '../../core/domain/types'
import { defaultAppSettings, type AppSettings } from '../../core/storage/schema'
import {
  isStorageError,
  summarizeSession,
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

  async reload(): Promise<void> {
    try {
      const data = await this.storage.loadCourses()
      this.coursesList = data.courses
      this.settingsData = data.settings
      this.loadedFlag = true
      this.lastErrorValue = null
    } catch (error) {
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

  updateSettings(partial: Partial<AppSettings>): Promise<boolean> {
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

  private async persist(courses: Course[], settings: AppSettings): Promise<boolean> {
    try {
      await this.storage.saveCourses({ courses, settings })
      this.coursesList = courses
      this.settingsData = settings
      this.lastErrorValue = null
      this.onChange()
      return true
    } catch (error) {
      this.lastErrorValue = toRepoError(error)
      this.onChange()
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
