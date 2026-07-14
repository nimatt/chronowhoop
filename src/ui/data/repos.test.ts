import { describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from '../../core/storage/memory-storage'
import { makeCourse, makeSession } from '../../core/storage/storage-contract'
import { StorageError, type Storage } from '../../core/storage/storage'
import { CoursesRepo, SessionsRepo, type SettingsPatch } from './repos'

function failingStorage(error: unknown): Storage {
  const reject = () => Promise.reject(error)
  return {
    loadCourses: reject,
    saveCourses: reject,
    listSessions: reject,
    loadSession: reject,
    saveSession: reject,
    latestSessionForCourse: reject,
    exportAll: reject,
    importAll: reject,
    persistenceStatus: reject,
    deleteSession: reject,
    deleteCourse: reject,
    resumePendingDeletions: reject,
  }
}

describe('CoursesRepo', () => {
  // A cascade interrupted between its INTENT and COMMIT writes: course "a" is
  // still present, its session s-a is still on disk, and the marker names both.
  // Course "b" and its session are bystanders.
  async function seededPendingDeletion() {
    const storage = new MemoryStorage()
    const doomed = makeCourse({ id: 'a', name: 'A' })
    const other = makeCourse({ id: 'b', name: 'B' })
    await storage.saveCourses({
      courses: [doomed, other],
      settings: {
        speechEnabled: true,
        pendingCourseDeletions: [{ courseId: 'a', courseName: 'A', sessionIds: ['s-a'] }],
      },
    })
    await storage.saveSession(makeSession({ id: 's-a', courseId: 'a' }))
    await storage.saveSession(makeSession({ id: 's-b', courseId: 'b' }))
    return { storage, marked: { doomed, other } }
  }

  it('ensureLoaded loads courses and settings once, sharing concurrent calls', async () => {
    const storage = new MemoryStorage()
    const course = makeCourse()
    await storage.saveCourses({ courses: [course], settings: { speechEnabled: false } })

    const loadCourses = vi.spyOn(storage, 'loadCourses')
    const repo = new CoursesRepo(storage)
    expect(repo.loaded).toBe(false)

    await Promise.all([repo.ensureLoaded(), repo.ensureLoaded()])
    await repo.ensureLoaded()

    expect(loadCourses).toHaveBeenCalledTimes(1)
    expect(repo.loaded).toBe(true)
    expect(repo.courses).toEqual([course])
    expect(repo.settings).toEqual({ speechEnabled: false })
    expect(repo.lastError).toBeNull()
  })

  it('reload picks up external changes', async () => {
    const storage = new MemoryStorage()
    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()
    expect(repo.courses).toEqual([])

    const course = makeCourse()
    await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
    await repo.reload()
    expect(repo.courses).toEqual([course])
  })

  it('createCourse uses the injected id and clock and persists the course', async () => {
    const storage = new MemoryStorage()
    const repo = new CoursesRepo(storage, {
      newId: () => 'id-1',
      now: () => '2026-07-13T10:00:00.000Z',
    })

    const created = await repo.createCourse({ name: 'Basement', direction: 'rtl', minLapTimeMs: 4000 })
    expect(created).toEqual({
      id: 'id-1',
      name: 'Basement',
      direction: 'rtl',
      minLapTimeMs: 4000,
      createdAt: '2026-07-13T10:00:00.000Z',
    })
    expect(repo.courses).toEqual([created])

    const fresh = new CoursesRepo(storage)
    await fresh.ensureLoaded()
    expect(fresh.courses).toEqual([created])
  })

  it('saveCourse upserts: replaces by id, appends unknown ids', async () => {
    const storage = new MemoryStorage()
    const a = makeCourse({ id: 'a', name: 'A' })
    const b = makeCourse({ id: 'b', name: 'B' })
    await storage.saveCourses({ courses: [a, b], settings: { speechEnabled: true } })

    const repo = new CoursesRepo(storage)
    expect(await repo.saveCourse({ ...a, name: 'A2' })).toBe(true)
    expect(repo.courses.map((c) => c.name)).toEqual(['A2', 'B'])

    const c = makeCourse({ id: 'c', name: 'C' })
    expect(await repo.saveCourse(c)).toBe(true)
    expect(repo.courses.map((each) => each.id)).toEqual(['a', 'b', 'c'])

    expect((await storage.loadCourses()).courses.map((each) => each.name)).toEqual([
      'A2',
      'B',
      'C',
    ])
  })

  it('updateSettings merges the partial and persists; undefined values remove keys', async () => {
    const storage = new MemoryStorage()
    const repo = new CoursesRepo(storage)
    expect(await repo.updateSettings({ lastCourseId: 'c-1' })).toBe(true)
    expect(repo.settings).toEqual({ speechEnabled: true, lastCourseId: 'c-1' })

    expect(await repo.updateSettings({ speechEnabled: false, lastCourseId: undefined })).toBe(true)
    expect(repo.settings).toEqual({ speechEnabled: false })
    expect((await storage.loadCourses()).settings).toEqual({ speechEnabled: false })
  })

  it('does not open the settings door to the crash-recovery journal', () => {
    const patch: SettingsPatch = { speechEnabled: false, lastCourseId: 'c-1' }
    expect(patch.lastCourseId).toBe('c-1')

    // pendingCourseDeletions is the cascade's two-phase-commit work list (plan 09
    // item 1), not a user setting: a screen must not be able to forge one, nor
    // clear a live one whose sessions are already destroyed.
    // @ts-expect-error — not part of SettingsPatch.
    const forged: SettingsPatch = { pendingCourseDeletions: [] }
    expect(forged).toEqual({ pendingCourseDeletions: [] })
  })

  it('serializes concurrent writes: neither of two updateSettings is lost', async () => {
    const storage = new MemoryStorage()
    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()

    const results = await Promise.all([
      repo.updateSettings({ lastCourseId: 'c-1' }),
      repo.updateSettings({ speechEnabled: false }),
    ])
    expect(results).toEqual([true, true])

    const expected = { speechEnabled: false, lastCourseId: 'c-1' }
    expect(repo.settings).toEqual(expected)
    expect((await storage.loadCourses()).settings).toEqual(expected)
  })

  it('serializes a saveCourse racing an updateSettings: both land', async () => {
    const storage = new MemoryStorage()
    const repo = new CoursesRepo(storage)
    const course = makeCourse({ id: 'a', name: 'A' })

    const results = await Promise.all([
      repo.saveCourse(course),
      repo.updateSettings({ lastCourseId: 'a' }),
    ])
    expect(results).toEqual([true, true])

    const data = await storage.loadCourses()
    expect(data.courses).toEqual([course])
    expect(data.settings).toEqual({ speechEnabled: true, lastCourseId: 'a' })
  })

  it('a failed queued write does not block later writes', async () => {
    const storage = new MemoryStorage()
    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()

    const saveCourses = vi.spyOn(storage, 'saveCourses')
    saveCourses.mockRejectedValueOnce(new StorageError('write-failed', 'nope'))

    const [first, second] = await Promise.all([
      repo.updateSettings({ lastCourseId: 'c-1' }),
      repo.updateSettings({ speechEnabled: false }),
    ])
    expect(first).toBe(false)
    expect(second).toBe(true)
    expect(repo.settings).toEqual({ speechEnabled: false })
    expect(repo.lastError).toBeNull()
  })

  it('a failed load sets lastError, never throws, and is retried by the next ensureLoaded', async () => {
    const error = new StorageError('corrupt', 'disk on fire')
    const repo = new CoursesRepo(failingStorage(error))

    await expect(repo.ensureLoaded()).resolves.toBeUndefined()
    expect(repo.loaded).toBe(false)
    expect(repo.lastError).toEqual({ kind: 'corrupt', message: 'disk on fire' })

    // Not cached: a second ensureLoaded hits storage again (still failing).
    await repo.ensureLoaded()
    expect(repo.loaded).toBe(false)
  })

  it('a failed save sets lastError and leaves the snapshot unchanged', async () => {
    const storage = new MemoryStorage()
    const course = makeCourse({ id: 'a', name: 'A' })
    await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()
    vi.spyOn(storage, 'saveCourses').mockRejectedValue(
      new StorageError('quota-exceeded', 'quota exceeded'),
    )

    expect(await repo.saveCourse({ ...course, name: 'A2' })).toBe(false)
    expect(repo.lastError).toEqual({ kind: 'quota-exceeded', message: 'quota exceeded' })
    expect(repo.courses).toEqual([course])

    expect(await repo.createCourse({ name: 'X', direction: 'ltr', minLapTimeMs: 3000 })).toBeNull()
    expect(await repo.updateSettings({ speechEnabled: false })).toBe(false)
  })

  it('a non-StorageError failure surfaces as kind unknown', async () => {
    const repo = new CoursesRepo(failingStorage(new Error('boom')))
    await repo.ensureLoaded()
    expect(repo.lastError).toEqual({ kind: 'unknown', message: 'boom' })
  })

  it('deleteCourse removes the course from the snapshot and from storage', async () => {
    const storage = new MemoryStorage()
    const a = makeCourse({ id: 'a', name: 'A' })
    const b = makeCourse({ id: 'b', name: 'B' })
    await storage.saveCourses({
      courses: [a, b],
      settings: { speechEnabled: true, lastCourseId: 'a' },
    })
    await storage.saveSession(makeSession({ id: 's-a', courseId: 'a' }))
    await storage.saveSession(makeSession({ id: 's-b', courseId: 'b' }))

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()

    await expect(repo.deleteCourse('a')).resolves.toBe(true)
    expect(repo.courses).toEqual([b])
    expect(repo.settings).toEqual({ speechEnabled: true })
    expect(repo.lastError).toBeNull()

    const data = await storage.loadCourses()
    expect(data.courses).toEqual([b])
    expect((await storage.listSessions()).map((each) => each.id)).toEqual(['s-b'])
  })

  it('a failed deleteCourse resolves false, sets lastError, and still reloads', async () => {
    const storage = new MemoryStorage()
    const course = makeCourse({ id: 'a', name: 'A' })
    await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
    await storage.saveSession(makeSession({ id: 's-a', courseId: 'a' }))

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()

    // A cascade that dies AFTER its INTENT write: courses.json is already
    // rewritten (marker added) and the session file is already gone. Reloading
    // only on success would leave the repo holding a snapshot that predates
    // both — and the next updateSettings would write it back.
    vi.spyOn(storage, 'deleteCourse').mockImplementation(async (id) => {
      const data = await storage.loadCourses()
      await storage.saveCourses({
        courses: data.courses,
        settings: {
          ...data.settings,
          pendingCourseDeletions: [{ courseId: id, courseName: 'A', sessionIds: ['s-a'] }],
        },
      })
      await storage.deleteSession('s-a')
      throw new StorageError('write-failed', 'disk')
    })

    await expect(repo.deleteCourse('a')).resolves.toBe(false)
    expect(repo.lastError).toEqual({ kind: 'write-failed', message: 'disk' })
    expect(repo.courses).toEqual([course])
    expect(repo.settings.pendingCourseDeletions).toEqual([
      { courseId: 'a', courseName: 'A', sessionIds: ['s-a'] },
    ])

    // The marker survives the next settings write, so the next launch's resume
    // can still finish the cascade.
    await expect(repo.updateSettings({ speechEnabled: false })).resolves.toBe(true)
    expect((await storage.loadCourses()).settings.pendingCourseDeletions).toEqual([
      { courseId: 'a', courseName: 'A', sessionIds: ['s-a'] },
    ])
  })

  it('a deleted course is not resurrected by a later fire-and-forget updateSettings', async () => {
    const storage = new MemoryStorage()
    const a = makeCourse({ id: 'a', name: 'A' })
    const b = makeCourse({ id: 'b', name: 'B' })
    await storage.saveCourses({ courses: [a, b], settings: { speechEnabled: true } })

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()
    await expect(repo.deleteCourse('a')).resolves.toBe(true)

    // The field bug, and it needs no race: FlyFlow arms a flight and writes
    // lastCourseId. Without deleteCourse's reload this persists the stale
    // course list and brings "A" back — empty, its sessions destroyed.
    await expect(repo.updateSettings({ lastCourseId: 'b' })).resolves.toBe(true)

    const data = await storage.loadCourses()
    expect(data.courses).toEqual([b])
    expect(data.settings).toEqual({ speechEnabled: true, lastCourseId: 'b' })
  })

  it('a reload that fails after the cascade committed invalidates the snapshot', async () => {
    const storage = new MemoryStorage()
    const a = makeCourse({ id: 'a', name: 'A' })
    const b = makeCourse({ id: 'b', name: 'B' })
    await storage.saveCourses({ courses: [a, b], settings: { speechEnabled: true } })
    await storage.saveSession(makeSession({ id: 's-a', courseId: 'a' }))

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()

    // The cascade commits; only the repo's own post-delete read fails (OPFS maps
    // any read exception to 'corrupt'). Preserving the pre-delete snapshot with
    // loaded still true would resurrect "a" on the next settings write — and
    // erase the intent marker in the same breath, with its sessions already gone.
    const loadCourses = storage.loadCourses.bind(storage)
    let loadsFail = false
    vi.spyOn(storage, 'loadCourses').mockImplementation(async () => {
      if (loadsFail) throw new StorageError('corrupt', 'unreadable')
      return loadCourses()
    })
    const deleteCourse = storage.deleteCourse.bind(storage)
    vi.spyOn(storage, 'deleteCourse').mockImplementation(async (id) => {
      const result = await deleteCourse(id)
      loadsFail = true
      return result
    })

    await expect(repo.deleteCourse('a')).resolves.toBe(true)
    expect(repo.loaded).toBe(false)
    expect(repo.lastError).toEqual({ kind: 'corrupt', message: 'unreadable' })

    // The write door is shut while the snapshot is unknown, so the stale list
    // cannot be written back.
    await expect(repo.updateSettings({ lastCourseId: 'b' })).resolves.toBe(false)

    loadsFail = false
    await repo.ensureLoaded()
    expect(repo.loaded).toBe(true)
    expect(repo.courses).toEqual([b])
    expect(repo.lastError).toBeNull()

    await expect(repo.updateSettings({ lastCourseId: 'b' })).resolves.toBe(true)
    const data = await storage.loadCourses()
    expect(data.courses).toEqual([b])
    expect(await storage.listSessions()).toEqual([])
  })

  it('discards a load a committed write overtook: the deleted course is not re-instated', async () => {
    const storage = new MemoryStorage()
    const a = makeCourse({ id: 'a', name: 'A' })
    const b = makeCourse({ id: 'b', name: 'B' })
    await storage.saveCourses({ courses: [a, b], settings: { speechEnabled: true } })

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()

    // reload() is outside the write queue (queuing it would deadlock), so a read
    // that started before the delete can still land after it. This one reads the
    // pre-delete document and is held open until the cascade has committed.
    const loadCourses = storage.loadCourses.bind(storage)
    let releaseLoad = () => {}
    const held = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    vi.spyOn(storage, 'loadCourses').mockImplementationOnce(async () => {
      const data = await loadCourses()
      await held
      return data
    })

    const staleLoad = repo.reload()
    await expect(repo.deleteCourse('a')).resolves.toBe(true)
    releaseLoad()
    await staleLoad

    expect(repo.courses).toEqual([b])
    expect(repo.loaded).toBe(true)

    await expect(repo.updateSettings({ lastCourseId: 'b' })).resolves.toBe(true)
    expect((await storage.loadCourses()).courses).toEqual([b])
  })

  it('serializes a deleteCourse racing an updateSettings: the course stays deleted', async () => {
    const storage = new MemoryStorage()
    const a = makeCourse({ id: 'a', name: 'A' })
    const b = makeCourse({ id: 'b', name: 'B' })
    await storage.saveCourses({ courses: [a, b], settings: { speechEnabled: true } })

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()

    const [deleted, settingsSaved] = await Promise.all([
      repo.deleteCourse('a'),
      repo.updateSettings({ lastCourseId: 'b' }),
    ])
    expect([deleted, settingsSaved]).toEqual([true, true])

    const data = await storage.loadCourses()
    expect(data.courses).toEqual([b])
    expect(data.settings).toEqual({ speechEnabled: true, lastCourseId: 'b' })
    expect(repo.courses).toEqual([b])
  })

  it('resumePendingDeletions finishes the cascade and reloads the snapshot', async () => {
    const { storage, marked } = await seededPendingDeletion()

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()
    expect(repo.courses.map((each) => each.id)).toEqual(['a', 'b'])

    await expect(repo.resumePendingDeletions()).resolves.toEqual([
      { kind: 'completed', courseId: 'a', courseName: 'A', sessionsDeleted: 1 },
    ])
    expect(repo.courses).toEqual([marked.other])
    expect(repo.settings.pendingCourseDeletions).toBeUndefined()
    expect((await storage.listSessions()).map((each) => each.id)).toEqual(['s-b'])
  })

  it('resumePendingDeletions with nothing pending resolves [] and touches nothing', async () => {
    const storage = new MemoryStorage()
    const course = makeCourse({ id: 'a', name: 'A' })
    await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()
    const reload = vi.spyOn(repo, 'reload')

    await expect(repo.resumePendingDeletions()).resolves.toEqual([])
    expect(reload).not.toHaveBeenCalled()
    expect(repo.courses).toEqual([course])
  })

  it('serializes a resume racing a createCourse: both survive', async () => {
    const { storage } = await seededPendingDeletion()

    const repo = new CoursesRepo(storage, {
      newId: () => 'c',
      now: () => '2026-07-14T10:00:00.000Z',
    })
    await repo.ensureLoaded()

    const [outcomes, created] = await Promise.all([
      repo.resumePendingDeletions(),
      repo.createCourse({ name: 'C', direction: 'ltr', minLapTimeMs: 3000 }),
    ])
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['completed'])
    expect(created).not.toBeNull()

    // The new course is not destroyed by the resume's commit write, and the
    // resumed course does not come back through createCourse's write.
    const data = await storage.loadCourses()
    expect(data.courses.map((each) => each.id)).toEqual(['b', 'c'])
    expect(repo.courses.map((each) => each.id)).toEqual(['b', 'c'])
  })

  it('serializes a resume racing a deleteCourse of another course: neither is reverted', async () => {
    const { storage } = await seededPendingDeletion()

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()

    const [outcomes, deleted] = await Promise.all([
      repo.resumePendingDeletions(),
      repo.deleteCourse('b'),
    ])
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['completed'])
    expect(deleted).toBe(true)

    const data = await storage.loadCourses()
    expect(data.courses).toEqual([])
    expect(data.settings.pendingCourseDeletions).toBeUndefined()
    expect(repo.courses).toEqual([])
    expect(await storage.listSessions()).toEqual([])
  })

  it('importAll merges through the queue; a later updateSettings keeps the imported courses', async () => {
    const source = new MemoryStorage()
    const imported = makeCourse({ id: 'imported', name: 'Imported' })
    await source.saveCourses({ courses: [imported], settings: { speechEnabled: true } })
    await source.saveSession(makeSession({ id: 's-imported', courseId: 'imported' }))
    const envelope = await source.exportAll()

    const storage = new MemoryStorage()
    const local = makeCourse({ id: 'local', name: 'Local' })
    await storage.saveCourses({ courses: [local], settings: { speechEnabled: true } })

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()

    await expect(repo.importAll(envelope)).resolves.toEqual({
      coursesAdded: 1,
      coursesSkipped: 0,
      sessionsAdded: 1,
      sessionsSkipped: 0,
    })
    expect(repo.courses.map((each) => each.id)).toEqual(['local', 'imported'])

    // The missing-reload bug: without importAll's reload this write persists the
    // pre-import course list and drops the import on the floor.
    await expect(repo.updateSettings({ lastCourseId: 'local' })).resolves.toBe(true)
    expect((await storage.loadCourses()).courses.map((each) => each.id)).toEqual([
      'local',
      'imported',
    ])
  })

  it('a partially-applied importAll still reloads: the landed courses are not dropped', async () => {
    const source = new MemoryStorage()
    const imported = makeCourse({ id: 'imported', name: 'Imported' })
    await source.saveCourses({ courses: [imported], settings: { speechEnabled: true } })
    await source.saveSession(makeSession({ id: 's-imported', courseId: 'imported' }))
    const envelope = await source.exportAll()

    const storage = new MemoryStorage()
    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()

    // importIntoStorage writes the merged course list first, then the sessions:
    // this import fails halfway, with courses.json already rewritten.
    vi.spyOn(storage, 'saveSession').mockRejectedValue(new StorageError('write-failed', 'disk'))
    await expect(repo.importAll(envelope)).resolves.toBeNull()
    expect(repo.lastError).toEqual({ kind: 'write-failed', message: 'disk' })
    expect(repo.courses).toEqual([imported])

    await expect(repo.updateSettings({ speechEnabled: false })).resolves.toBe(true)
    expect((await storage.loadCourses()).courses).toEqual([imported])
  })

  it('a failed importAll resolves null with lastError set', async () => {
    const source = new MemoryStorage()
    await source.saveCourses({ courses: [makeCourse({ id: 'a' })], settings: { speechEnabled: true } })
    const envelope = await source.exportAll()

    const repo = new CoursesRepo(failingStorage(new StorageError('quota-exceeded', 'full')))
    await expect(repo.importAll(envelope)).resolves.toBeNull()
    expect(repo.lastError).toEqual({ kind: 'quota-exceeded', message: 'full' })
  })

  it('exportAll resolves the envelope; a failure resolves null with lastError set', async () => {
    const storage = new MemoryStorage({ now: () => '2026-07-14T10:00:00.000Z' })
    const course = makeCourse({ id: 'a', name: 'A' })
    await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })

    const repo = new CoursesRepo(storage)
    const envelope = await repo.exportAll()
    expect(envelope?.courses).toEqual([course])
    expect(repo.lastError).toBeNull()

    vi.spyOn(storage, 'exportAll').mockRejectedValue(new StorageError('corrupt', 'unreadable'))
    await expect(repo.exportAll()).resolves.toBeNull()
    expect(repo.lastError).toEqual({ kind: 'corrupt', message: 'unreadable' })
  })

  it('exportAll is serialized against a deleteCourse: it never observes a half-done cascade', async () => {
    const storage = new MemoryStorage()
    const a = makeCourse({ id: 'a', name: 'A' })
    const b = makeCourse({ id: 'b', name: 'B' })
    await storage.saveCourses({ courses: [a, b], settings: { speechEnabled: true } })
    await storage.saveSession(makeSession({ id: 's-a', courseId: 'a' }))
    await storage.saveSession(makeSession({ id: 's-b', courseId: 'b' }))

    const repo = new CoursesRepo(storage)
    await repo.ensureLoaded()

    const [deleted, envelope] = await Promise.all([repo.deleteCourse('a'), repo.exportAll()])
    expect(deleted).toBe(true)

    // Every session in the envelope belongs to a course in the same envelope:
    // an export taken mid-cascade would list s-a under a course that is gone.
    const courseIds = new Set(envelope?.courses.map((each) => each.id))
    expect(envelope?.sessions.every((session) => courseIds.has(session.courseId))).toBe(true)
    expect(envelope?.courses).toEqual([b])
  })

  it('onChange fires on load and on every save outcome', async () => {
    const storage = new MemoryStorage()
    const onChange = vi.fn()
    const repo = new CoursesRepo(storage, { onChange })

    await repo.ensureLoaded()
    expect(onChange).toHaveBeenCalledTimes(1)

    await repo.createCourse({ name: 'X', direction: 'ltr', minLapTimeMs: 3000 })
    expect(onChange).toHaveBeenCalledTimes(2)

    vi.spyOn(storage, 'saveCourses').mockRejectedValue(new StorageError('write-failed', 'nope'))
    await repo.updateSettings({ speechEnabled: false })
    expect(onChange).toHaveBeenCalledTimes(3)
  })
})

describe('SessionsRepo', () => {
  async function seeded() {
    const storage = new MemoryStorage()
    const older = makeSession({
      id: 's-old',
      courseId: 'course-a',
      startedAt: '2026-07-10T10:00:00.000Z',
    })
    const newer = makeSession({
      id: 's-new',
      courseId: 'course-a',
      startedAt: '2026-07-12T10:00:00.000Z',
    })
    const other = makeSession({
      id: 's-other',
      courseId: 'course-b',
      startedAt: '2026-07-11T10:00:00.000Z',
    })
    for (const session of [older, newer, other]) await storage.saveSession(session)
    return { storage, older, newer, other }
  }

  it('ensureLoaded loads summaries newest first; refresh picks up new sessions', async () => {
    const { storage } = await seeded()
    const repo = new SessionsRepo(storage)
    expect(repo.loaded).toBe(false)

    await repo.ensureLoaded()
    expect(repo.loaded).toBe(true)
    expect(repo.summaries.map((summary) => summary.id)).toEqual(['s-new', 's-other', 's-old'])

    await storage.saveSession(
      makeSession({ id: 's-newest', courseId: 'course-b', startedAt: '2026-07-13T10:00:00.000Z' }),
    )
    await repo.refresh()
    expect(repo.summaries[0].id).toBe('s-newest')
  })

  it('sessionsForCourse filters the summaries, preserving order', async () => {
    const { storage } = await seeded()
    const repo = new SessionsRepo(storage)
    await repo.ensureLoaded()

    expect(repo.sessionsForCourse('course-a').map((summary) => summary.id)).toEqual([
      's-new',
      's-old',
    ])
    expect(repo.sessionsForCourse('course-missing')).toEqual([])
  })

  it('loadSession passes through; a miss resolves undefined without touching lastError', async () => {
    const { storage, older } = await seeded()
    const repo = new SessionsRepo(storage)

    await expect(repo.loadSession('s-old')).resolves.toEqual(older)
    expect(repo.lastError).toBeNull()

    // Per-caller query: the miss is the caller's to handle locally, not an
    // app-wide storage error (a failed load must not plant a sticky banner).
    await expect(repo.loadSession('nope')).resolves.toBeUndefined()
    expect(repo.lastError).toBeNull()
  })

  it('saveSession persists and updates a listed summary in place', async () => {
    const { storage, older } = await seeded()
    const repo = new SessionsRepo(storage)
    await repo.ensureLoaded()

    const updated = { ...older, note: 'edited', laps: older.laps.slice(0, 1) }
    await expect(repo.saveSession(updated)).resolves.toBe(true)
    expect(repo.lastError).toBeNull()
    await expect(storage.loadSession('s-old')).resolves.toEqual(updated)
    const summary = repo.summaries.find((each) => each.id === 's-old')
    expect(summary?.lapCount).toBe(1)
  })

  it('a failed saveSession resolves false with lastError set, summaries untouched', async () => {
    const { storage } = await seeded()
    const repo = new SessionsRepo(storage)
    await repo.ensureLoaded()
    const before = repo.summaries

    vi.spyOn(storage, 'saveSession').mockRejectedValue(new StorageError('write-failed', 'disk'))
    await expect(repo.saveSession(makeSession({ id: 's-old' }))).resolves.toBe(false)
    expect(repo.lastError).toEqual({ kind: 'write-failed', message: 'disk' })
    expect(repo.summaries).toEqual(before)
  })

  it('deleteSession drops the summary and removes the session', async () => {
    const { storage } = await seeded()
    const repo = new SessionsRepo(storage)
    await repo.ensureLoaded()

    await expect(repo.deleteSession('s-old')).resolves.toBe(true)
    expect(repo.summaries.map((summary) => summary.id)).toEqual(['s-new', 's-other'])
    expect(repo.lastError).toBeNull()
    await expect(storage.loadSession('s-old')).rejects.toThrow()

    // Idempotent at the seam: a double-tap resolves and changes nothing.
    await expect(repo.deleteSession('s-old')).resolves.toBe(true)
    expect(repo.summaries.map((summary) => summary.id)).toEqual(['s-new', 's-other'])
  })

  it('a failed deleteSession resolves false with lastError set, summaries untouched', async () => {
    const { storage } = await seeded()
    const repo = new SessionsRepo(storage)
    await repo.ensureLoaded()
    const before = repo.summaries

    vi.spyOn(storage, 'deleteSession').mockRejectedValue(new StorageError('write-failed', 'disk'))
    await expect(repo.deleteSession('s-old')).resolves.toBe(false)
    // Unlike loadSession/latestForCourse: a delete the store refused is an
    // app-wide storage condition, not a per-caller miss.
    expect(repo.lastError).toEqual({ kind: 'write-failed', message: 'disk' })
    expect(repo.summaries).toEqual(before)
  })

  it('latestForCourse resolves the most recent session, undefined when none', async () => {
    const { storage, newer } = await seeded()
    const repo = new SessionsRepo(storage)

    await expect(repo.latestForCourse('course-a')).resolves.toEqual(newer)
    await expect(repo.latestForCourse('course-missing')).resolves.toBeUndefined()
    expect(repo.lastError).toBeNull()
  })

  it('a failed list sets lastError and never throws', async () => {
    const repo = new SessionsRepo(failingStorage(new StorageError('corrupt', 'bad dir')))
    await expect(repo.ensureLoaded()).resolves.toBeUndefined()
    expect(repo.loaded).toBe(false)
    expect(repo.lastError).toEqual({ kind: 'corrupt', message: 'bad dir' })

    await expect(repo.latestForCourse('x')).resolves.toBeUndefined()
  })

  it('lastError is not sticky: a later successful op clears it', async () => {
    const { storage } = await seeded()
    const repo = new SessionsRepo(storage)
    await repo.ensureLoaded()

    vi.spyOn(storage, 'saveSession').mockRejectedValueOnce(
      new StorageError('write-failed', 'disk'),
    )
    await expect(repo.saveSession(makeSession({ id: 's-old' }))).resolves.toBe(false)
    expect(repo.lastError?.kind).toBe('write-failed')

    await repo.refresh()
    expect(repo.lastError).toBeNull()
  })
})
