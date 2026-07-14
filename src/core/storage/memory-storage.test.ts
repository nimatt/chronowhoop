import { describe, expect, it } from 'vitest'
import { MemoryStorage } from './memory-storage'
import { describeStorageContract, makeCourse, makeSession } from './storage-contract'

describeStorageContract('MemoryStorage', () => Promise.resolve(new MemoryStorage()))

describe('MemoryStorage specifics', () => {
  it('exportAll stamps exportedAt from the injected clock', async () => {
    const storage = new MemoryStorage({ now: () => '2026-07-13T12:00:00.000Z' })
    await storage.saveSession(makeSession())
    const envelope = await storage.exportAll()
    expect(envelope.exportedAt).toBe('2026-07-13T12:00:00.000Z')
  })

  it('exportAll strips the pending-deletion marker from the settings it exports', async () => {
    const storage = new MemoryStorage()
    const course = makeCourse()
    await storage.saveCourses({
      courses: [course],
      settings: {
        speechEnabled: true,
        lastExportAt: '2026-07-12T18:00:00.000Z',
        pendingCourseDeletions: [
          { courseId: course.id, courseName: course.name, sessionIds: [] },
        ],
      },
    })

    // The marker is instance-and-disk state ("a destruction is in flight
    // here"), not user data. A backup file must not advertise an in-flight
    // destruction of a course it also carries — it is human-inspectable by
    // design and it is the thing the user restores FROM.
    expect((await storage.exportAll()).settings).toEqual({
      speechEnabled: true,
      lastExportAt: '2026-07-12T18:00:00.000Z',
    })
    // …and the store keeps it: the export reads, it does not resolve anything.
    expect((await storage.loadCourses()).settings.pendingCourseDeletions).toHaveLength(1)
  })

  // IMPORT-AS-UNDO, end to end through the real cascade. The state this
  // restores from is the one the delete screen creates when it fails: the
  // marker on disk, some session files gone, the course still standing
  // ("Deleted 1 of 2 — the course is still here. Try again."). The pilot does
  // what the product offers and re-imports the backup that same screen told
  // them to take. A marker surviving that import would be replayed at the next
  // launch — over exactly the ids just restored, so not one stray exists and
  // the flown-since rule never fires — and take the course and every session
  // with it.
  it('an import abandons a pending marker it covers, so the next launch does not re-destroy the restored data', async () => {
    const storage = new MemoryStorage()
    const course = makeCourse()
    const sessions = [
      makeSession({ courseId: course.id, startedAt: '2026-07-11T10:00:00.000Z' }),
      makeSession({ courseId: course.id, startedAt: '2026-07-12T10:00:00.000Z' }),
    ]
    await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
    for (const session of sessions) await storage.saveSession(session)
    const backup = await storage.exportAll()

    // The cascade died between INTENT and COMMIT: marker written, one session
    // file removed, the course still there.
    await storage.saveCourses({
      courses: [course],
      settings: {
        speechEnabled: true,
        pendingCourseDeletions: [
          {
            courseId: course.id,
            courseName: course.name,
            sessionIds: sessions.map((session) => session.id),
          },
        ],
      },
    })
    await storage.deleteSession(sessions[0].id)

    expect(await storage.importAll(backup)).toEqual({
      coursesAdded: 0,
      coursesSkipped: 1,
      sessionsAdded: 1,
      sessionsSkipped: 1,
    })

    expect((await storage.loadCourses()).settings.pendingCourseDeletions).toBeUndefined()
    expect(await storage.resumePendingDeletions()).toEqual([])
    expect((await storage.loadCourses()).courses).toEqual([course])
    expect((await storage.listSessions()).map((summary) => summary.id).sort()).toEqual(
      sessions.map((session) => session.id).sort(),
    )
  })
})
