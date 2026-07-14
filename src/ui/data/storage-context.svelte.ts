import { OpfsStorage, type QuarantineEvent } from '../../core/storage/opfs-storage'
import type { PersistenceStatus, ResumeOutcome, Storage } from '../../core/storage/storage'
import { CoursesRepo, SessionsRepo, filterSessionsForCourse, findCourseById } from './repos'
import type {
  CoursesRepoView,
  DeletionNotice,
  QuarantineNotice,
  SessionsRepoView,
  StorageContext,
} from './storage-context'

export interface StorageContextOptions {
  // Builds the Storage instance; receives the quarantine callback so
  // implementations that quarantine (OpfsStorage) report into the context.
  // Default: `new OpfsStorage({ onQuarantine })`. Tests inject
  // `() => new MemoryStorage()`.
  createStorage?: (onQuarantine: (event: QuarantineEvent) => void) => Storage
  // Clocks/ids for CoursesRepo.createCourse; real crypto/Date by default.
  now?: () => string
  newId?: () => string
}

// Optional capability members some Storage implementations carry (OpfsStorage
// today). Checked structurally rather than via `instanceof OpfsStorage`, so any
// storage — a future sync-backed one, a read-only test double — can opt in
// without this module naming it.
//
// This module is one of only two in src/ui that may hold a Storage (the other
// is repos.ts) — the capability probes therefore live here, and the context
// re-exports the read-only answer as a method. Screens get answers, not the
// handle.
function storageReadOnly(storage: Storage): boolean {
  const { readOnly } = storage as { readOnly?: unknown }
  return typeof readOnly === 'boolean' ? readOnly : false
}

function disposeStorage(storage: Storage): void {
  const { dispose } = storage as { dispose?: unknown }
  if (typeof dispose === 'function') dispose.call(storage)
}

// The repos are plain-TS classes (node-tested in repos.test.ts); this module
// mirrors their snapshots into $state on every onChange — the same
// core-truth → reactive-mirror bridge fly-session uses for laps. All storage
// data here is low-frequency, so $state is the right side of the bridge rule.
export function createStorageContext(options: StorageContextOptions = {}): StorageContext {
  let quarantineNotices = $state<QuarantineNotice[]>([])
  let nextNoticeId = 0
  const onQuarantine = (event: QuarantineEvent) => {
    nextNoticeId += 1
    quarantineNotices = [...quarantineNotices, { id: nextNoticeId, ...event }]
  }

  const storage = options.createStorage
    ? options.createStorage(onQuarantine)
    : new OpfsStorage({ onQuarantine })

  let readOnly = $state(false)
  let persistence = $state<PersistenceStatus | null>(null)

  // The lock answer and the persist() answer both settle asynchronously after
  // construction/writes, so both are re-read whenever a repository operation
  // settles (and once right away) rather than assumed stable.
  function refreshStorageStatus(): void {
    readOnly = storageReadOnly(storage)
    void storage.persistenceStatus().then(
      (status) => {
        persistence = status
      },
      () => {},
    )
  }

  const coursesRepo: CoursesRepo = new CoursesRepo(storage, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
    onChange: () => {
      coursesState = coursesRepo.snapshot
      refreshStorageStatus()
    },
  })

  let coursesState = $state(coursesRepo.snapshot)

  const sessionsRepo: SessionsRepo = new SessionsRepo(storage, {
    onChange: () => {
      sessionsState = sessionsRepo.snapshot
      refreshStorageStatus()
    },
  })

  let sessionsState = $state(sessionsRepo.snapshot)

  refreshStorageStatus()

  // Resume on startup (plan 09 item 10): finish — or abandon — a cascade a
  // crash interrupted, so no course is left lying about its session count.
  //
  // Through the REPO, never storage.resumePendingDeletions() directly: a resume
  // is a second read-merge-write cycle over courses.json, and run outside
  // CoursesRepo's queue it loses data with no race at all (the resume commits,
  // the repo's cached list still holds the deleted course, and the next
  // fire-and-forget updateSettings writes it straight back — resurrected, empty,
  // its sessions destroyed).
  //
  // Fire-and-forget by design: createStorageContext is synchronous (App.svelte
  // constructs it during setup) and the resume never rejects. Screens render
  // against whatever the repos hold and re-render when this settles.
  //
  // THIS IS THE ONLY RESUME PATH. It is deliberately not on CoursesRepoView:
  // the cascade's collateral is cross-cutting (session files removed behind
  // SessionsRepo's back, plus a notice the user must see), and a second entry
  // point would be a second place to forget one of them.
  let deletionNotices = $state<DeletionNotice[]>([])
  let nextDeletionNoticeId = 0

  function addDeletionNotices(outcomes: readonly ResumeOutcome[]): void {
    deletionNotices = [
      ...deletionNotices,
      ...outcomes.map((outcome) => {
        nextDeletionNoticeId += 1
        return { id: nextDeletionNoticeId, outcome }
      }),
    ]
  }

  void coursesRepo.resumePendingDeletions().then(async (outcomes) => {
    if (outcomes.length === 0) return
    // The cascade removed session files behind SessionsRepo's back.
    await sessionsRepo.refresh()
    addDeletionNotices(outcomes)
  })

  const coursesView: CoursesRepoView = {
    get loaded() {
      return coursesState.loaded
    },
    get courses() {
      return coursesState.courses
    },
    get settings() {
      return coursesState.settings
    },
    get lastError() {
      return coursesState.lastError
    },
    courseById: (id) => findCourseById(coursesState.courses, id),
    ensureLoaded: () => coursesRepo.ensureLoaded(),
    saveCourse: (course) => coursesRepo.saveCourse(course),
    createCourse: (fields) => coursesRepo.createCourse(fields),
    updateSettings: (partial) => coursesRepo.updateSettings(partial),
    // THE cross-repo invalidation point. Screens only ever hold the views, so
    // this composition is the one place the cascade's collateral — the session
    // files it removed behind SessionsRepo's back — can be accounted for, and
    // therefore the one place it can be forgotten.
    deleteCourse: async (id) => {
      const deleted = await coursesRepo.deleteCourse(id)
      await sessionsRepo.refresh()
      return deleted
    },
    importAll: (envelope) => coursesRepo.importAll(envelope),
    exportAll: () => coursesRepo.exportAll(),
  }

  const sessionsView: SessionsRepoView = {
    get loaded() {
      return sessionsState.loaded
    },
    get summaries() {
      return sessionsState.summaries
    },
    get lastError() {
      return sessionsState.lastError
    },
    sessionsForCourse: (courseId) => filterSessionsForCourse(sessionsState.summaries, courseId),
    ensureLoaded: () => sessionsRepo.ensureLoaded(),
    refresh: () => sessionsRepo.refresh(),
    loadSession: (id) => sessionsRepo.loadSession(id),
    latestForCourse: (courseId) => sessionsRepo.latestForCourse(courseId),
    saveSession: (session) => sessionsRepo.saveSession(session),
    deleteSession: (id) => sessionsRepo.deleteSession(id),
  }

  return {
    // Narrowed to saveSession on the way out (SessionWriter): the fly flow is
    // the one product path that still needs to touch storage directly, and it
    // only ever writes session files. Handing it the whole Storage is what put
    // deleteCourse / importAll / exportAll / resumePendingDeletions within
    // reach of every screen and left the courses.json critical section
    // (repos.ts) enforced by nothing but a comment.
    sessionWriter: storage,
    get readOnly() {
      return readOnly
    },
    liveReadOnly: () => storageReadOnly(storage),
    get persistence() {
      return persistence
    },
    get quarantineNotices() {
      return quarantineNotices
    },
    dismissQuarantineNotice(id: number) {
      quarantineNotices = quarantineNotices.filter((notice) => notice.id !== id)
    },
    get deletionNotices() {
      return deletionNotices
    },
    dismissDeletionNotice(id: number) {
      deletionNotices = deletionNotices.filter((notice) => notice.id !== id)
    },
    coursesRepo: coursesView,
    sessionsRepo: sessionsView,
    destroy() {
      // Releases the writer lock so a later context (next test, next mount)
      // can become the writer; product code holds it for the page lifetime.
      disposeStorage(storage)
    },
  }
}
