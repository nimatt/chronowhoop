import { describe, expect, it } from 'vitest'
import type { Course, Session } from '../domain/types'
import { computeImportPlan, importIntoStorage, parseImportFile, type ImportTarget } from './import'
import { SCHEMA_VERSION, type ExportEnvelope, type PendingCourseDeletion } from './schema'
import {
  isStorageError,
  StorageError,
  type CoursesData,
  type SessionSummary,
} from './storage'
import { makeCourse, makeSession } from './storage-contract'

function makeEnvelope(overrides: Partial<ExportEnvelope> = {}): ExportEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: '2026-07-12T18:00:00.000Z',
    courses: [],
    settings: { speechEnabled: true },
    sessions: [],
    ...overrides,
  }
}

function captureError(run: () => unknown): unknown {
  try {
    run()
    return undefined
  } catch (error) {
    return error
  }
}

describe('parseImportFile', () => {
  it('round-trips a valid pretty-printed export file', () => {
    const course = makeCourse()
    const envelope = makeEnvelope({
      courses: [course],
      sessions: [makeSession({ courseId: course.id })],
    })
    expect(parseImportFile(JSON.stringify(envelope, null, 2))).toEqual(envelope)
  })

  it('maps malformed JSON to StorageError corrupt', () => {
    const error = captureError(() => parseImportFile('{"schemaVersion": 1, tru'))
    expect(error).toMatchObject({
      name: 'StorageError',
      kind: 'corrupt',
      message: expect.stringContaining('not valid JSON') as string,
    })
  })

  it('maps validation failures to StorageError corrupt with the $-rooted field path', () => {
    const invalid = { ...makeEnvelope(), courses: 'not-an-array' }
    const error = captureError(() => parseImportFile(JSON.stringify(invalid)))
    expect(error).toMatchObject({
      name: 'StorageError',
      kind: 'corrupt',
      message: expect.stringContaining('$.courses') as string,
    })
  })

  it('refuses a newer schemaVersion with unsupported-version and an "update the app" message', () => {
    const newer = { ...makeEnvelope(), schemaVersion: SCHEMA_VERSION + 1 }
    const error = captureError(() => parseImportFile(JSON.stringify(newer)))
    expect(isStorageError(error) && error.kind === 'unsupported-version').toBe(true)
    expect((error as Error).message).toContain('update the app')
  })

  it('migrates an older schemaVersion forward like any other read', () => {
    // The registered (fabricated) 0→1 migration adds default settings.
    const v0 = { schemaVersion: 0, exportedAt: '2026-07-12T18:00:00.000Z', courses: [], sessions: [] }
    expect(parseImportFile(JSON.stringify(v0))).toEqual(makeEnvelope())
  })
})

describe('computeImportPlan', () => {
  it('splits unknown ids from existing ids and counts both', () => {
    const existingCourse = makeCourse()
    const newCourse = makeCourse()
    const existingSession = makeSession()
    const newSession = makeSession()
    const envelope = makeEnvelope({
      courses: [existingCourse, newCourse],
      sessions: [existingSession, newSession],
    })

    const plan = computeImportPlan(
      envelope,
      new Set([existingCourse.id]),
      new Set([existingSession.id]),
    )

    expect(plan.coursesToAdd).toEqual([newCourse])
    expect(plan.sessionsToAdd).toEqual([newSession])
    expect(plan.result).toEqual({
      coursesAdded: 1,
      coursesSkipped: 1,
      sessionsAdded: 1,
      sessionsSkipped: 1,
    })
  })

  it('keeps orphan sessions in the plan', () => {
    const orphan = makeSession({ courseId: 'no-such-course' })
    const plan = computeImportPlan(makeEnvelope({ sessions: [orphan] }), new Set(), new Set())
    expect(plan.sessionsToAdd).toEqual([orphan])
  })

  it('duplicate ids within one envelope: first occurrence wins, later ones count as skipped', () => {
    const course = makeCourse({ name: 'first' })
    const session = makeSession({ note: 'first' })
    const envelope = makeEnvelope({
      courses: [course, { ...course, name: 'second' }],
      sessions: [session, { ...session, note: 'second' }],
    })

    const plan = computeImportPlan(envelope, new Set(), new Set())

    expect(plan.coursesToAdd).toEqual([course])
    expect(plan.sessionsToAdd).toEqual([session])
    expect(plan.result).toEqual({
      coursesAdded: 1,
      coursesSkipped: 1,
      sessionsAdded: 1,
      sessionsSkipped: 1,
    })
  })

  it('does not mutate the envelope or the id sets', () => {
    const envelope = makeEnvelope({ courses: [makeCourse()], sessions: [makeSession()] })
    const pristine = structuredClone(envelope)
    const courseIds = new Set<string>()
    const sessionIds = new Set<string>()

    computeImportPlan(envelope, courseIds, sessionIds)

    expect(envelope).toEqual(pristine)
    expect(courseIds.size).toBe(0)
    expect(sessionIds.size).toBe(0)
  })
})

describe('importIntoStorage', () => {
  function summarize(session: Session): SessionSummary {
    return {
      id: session.id,
      courseId: session.courseId,
      startedAt: session.startedAt,
      lapCount: session.laps.length,
      validLapCount: session.laps.filter((lap) => lap.status === 'valid').length,
    }
  }

  // A structural ImportTarget that records every successful write in order and
  // can fail specific saveSession calls (counted across the target's lifetime,
  // so a retry into the same target continues the count).
  function makeTarget(
    options: {
      seedCourses?: Course[]
      seedSessions?: Session[]
      seedMarkers?: PendingCourseDeletion[]
      failSaveSessionCalls?: number[]
    } = {},
  ) {
    let saveSessionCalls = 0
    const writes: string[] = []
    let data: CoursesData = {
      courses: structuredClone(options.seedCourses ?? []),
      settings: {
        speechEnabled: true,
        ...(options.seedMarkers
          ? { pendingCourseDeletions: structuredClone(options.seedMarkers) }
          : {}),
      },
    }
    const sessions = new Map(
      (options.seedSessions ?? []).map((session) => [session.id, structuredClone(session)]),
    )
    const target: ImportTarget = {
      loadCourses: () => Promise.resolve(structuredClone(data)),
      listSessions: () => Promise.resolve([...sessions.values()].map(summarize)),
      saveCourses: (next) => {
        writes.push('saveCourses')
        data = structuredClone(next)
        return Promise.resolve()
      },
      saveSession: (session) => {
        saveSessionCalls++
        if (options.failSaveSessionCalls?.includes(saveSessionCalls)) {
          return Promise.reject(
            new StorageError('write-failed', `injected failure on saveSession call ${String(saveSessionCalls)}`),
          )
        }
        writes.push(`saveSession:${session.id}`)
        sessions.set(session.id, structuredClone(session))
        return Promise.resolve()
      },
    }
    return {
      target,
      writes,
      courseIds: () => data.courses.map((course) => course.id),
      sessionIds: () => [...sessions.keys()],
      markers: () => structuredClone(data.settings.pendingCourseDeletions ?? []),
    }
  }

  it('writes the merged course list before the first session file', async () => {
    const course = makeCourse()
    const first = makeSession({ courseId: course.id })
    const second = makeSession({ courseId: course.id })
    const rig = makeTarget()

    const result = await importIntoStorage(
      rig.target,
      makeEnvelope({ courses: [course], sessions: [first, second] }),
    )

    expect(rig.writes).toEqual([
      'saveCourses',
      `saveSession:${first.id}`,
      `saveSession:${second.id}`,
    ])
    expect(result).toEqual({
      coursesAdded: 1,
      coursesSkipped: 0,
      sessionsAdded: 2,
      sessionsSkipped: 0,
    })
  })

  it('propagates a mid-import saveSession failure; re-importing the same file completes the merge', async () => {
    const course = makeCourse()
    const sessions = [
      makeSession({ courseId: course.id }),
      makeSession({ courseId: course.id }),
      makeSession({ courseId: course.id }),
    ]
    const envelope = makeEnvelope({ courses: [course], sessions })
    const rig = makeTarget({ failSaveSessionCalls: [2] })

    const error = await importIntoStorage(rig.target, envelope).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(isStorageError(error) && error.kind === 'write-failed').toBe(true)
    expect(rig.courseIds()).toEqual([course.id])
    expect(rig.sessionIds()).toEqual([sessions[0].id])

    const retry = await importIntoStorage(rig.target, envelope)

    expect(retry).toEqual({
      coursesAdded: 0,
      coursesSkipped: 1,
      sessionsAdded: 2,
      sessionsSkipped: 1,
    })
    expect(rig.sessionIds().sort()).toEqual(sessions.map((session) => session.id).sort())
    expect(rig.writes).toEqual([
      'saveCourses',
      `saveSession:${sessions[0].id}`,
      `saveSession:${sessions[1].id}`,
      `saveSession:${sessions[2].id}`,
    ])
  })

  it('a zero-add plan performs no writes', async () => {
    const course = makeCourse()
    const session = makeSession({ courseId: course.id })
    const rig = makeTarget({ seedCourses: [course], seedSessions: [session] })

    const result = await importIntoStorage(
      rig.target,
      makeEnvelope({ courses: [course], sessions: [session] }),
    )

    expect(rig.writes).toEqual([])
    expect(result).toEqual({
      coursesAdded: 0,
      coursesSkipped: 1,
      sessionsAdded: 0,
      sessionsSkipped: 1,
    })
  })

  // The import is the product's only undo — the delete screen says so — and the
  // state it is most often asked to undo is a CASCADE THAT DIED between INTENT
  // and COMMIT: the marker on disk, some session files gone, the course still
  // present. Restoring the backup into that state and leaving the marker
  // standing would let the next launch replay the cascade over exactly the data
  // just restored (the restored ids ARE the recorded ids, so no stray exists and
  // flown-since does not fire) — and destroy it a second time, silently.
  describe('abandons a pending deletion the envelope covers', () => {
    it('drops the marker in the same courses write when the envelope names the course', async () => {
      const course = makeCourse()
      const session = makeSession({ courseId: course.id })
      const rig = makeTarget({
        seedMarkers: [{ courseId: course.id, courseName: course.name, sessionIds: [session.id] }],
      })

      await importIntoStorage(rig.target, makeEnvelope({ courses: [course], sessions: [session] }))

      expect(rig.markers()).toEqual([])
      // The marker goes AHEAD of the session writes, so an import that dies
      // half-way still cannot leave one behind.
      expect(rig.writes).toEqual(['saveCourses', `saveSession:${session.id}`])
    })

    it('writes courses.json even when the plan adds no course — the restore case', async () => {
      // The INTENT write keeps the course present, so re-importing the backup
      // after an interrupted cascade adds only sessions: a marker-clearing write
      // gated on coursesToAdd would never happen at all.
      const course = makeCourse()
      const restored = makeSession({ courseId: course.id })
      const rig = makeTarget({
        seedCourses: [course],
        seedMarkers: [{ courseId: course.id, courseName: course.name, sessionIds: [restored.id] }],
      })

      await importIntoStorage(rig.target, makeEnvelope({ courses: [course], sessions: [restored] }))

      expect(rig.markers()).toEqual([])
      expect(rig.courseIds()).toEqual([course.id])
      expect(rig.writes).toEqual(['saveCourses', `saveSession:${restored.id}`])
    })

    it('abandons on a session id alone, even when the envelope carries no course', async () => {
      const orphanBackup = makeSession({ courseId: 'doomed' })
      const rig = makeTarget({
        seedMarkers: [
          { courseId: 'doomed', courseName: 'Basement', sessionIds: [orphanBackup.id] },
        ],
      })

      await importIntoStorage(rig.target, makeEnvelope({ sessions: [orphanBackup] }))

      expect(rig.markers()).toEqual([])
      expect(rig.sessionIds()).toEqual([orphanBackup.id])
    })

    it('leaves a marker the envelope does not touch alone', async () => {
      const untouched: PendingCourseDeletion = {
        courseId: 'other',
        courseName: 'Garage loop',
        sessionIds: ['other-session'],
      }
      const course = makeCourse()
      const rig = makeTarget({ seedMarkers: [untouched] })

      await importIntoStorage(rig.target, makeEnvelope({ courses: [course] }))

      expect(rig.markers()).toEqual([untouched])
    })
  })
})
