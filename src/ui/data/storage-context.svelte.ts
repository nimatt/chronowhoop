import { OpfsStorage, type QuarantineEvent } from '../../core/storage/opfs-storage'
import type { PersistenceStatus, Storage } from '../../core/storage/storage'
import { CoursesRepo, SessionsRepo, filterSessionsForCourse, findCourseById } from './repos'
import { storageReadOnly } from './storage-context'
import type {
  CoursesRepoView,
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

// Optional capability member some Storage implementations carry (OpfsStorage
// today), checked structurally like storageReadOnly (storage-context.ts).
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
    reload: () => coursesRepo.reload(),
    saveCourse: (course) => coursesRepo.saveCourse(course),
    createCourse: (fields) => coursesRepo.createCourse(fields),
    updateSettings: (partial) => coursesRepo.updateSettings(partial),
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
  }

  return {
    storage,
    get readOnly() {
      return readOnly
    },
    get persistence() {
      return persistence
    },
    get quarantineNotices() {
      return quarantineNotices
    },
    dismissQuarantineNotice(id: number) {
      quarantineNotices = quarantineNotices.filter((notice) => notice.id !== id)
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
