import { describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from '../../core/storage/memory-storage'
import { makeCourse, makeSession } from '../../core/storage/storage-contract'
import { StorageError, type Storage } from '../../core/storage/storage'
import { CoursesRepo, SessionsRepo } from './repos'

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
  }
}

describe('CoursesRepo', () => {
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
