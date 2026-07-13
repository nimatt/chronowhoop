// Reusable Storage contract suite (plan 06 item 2): every implementation must
// pass the same describe block. memory-storage.test.ts runs it in node; the
// OpfsStorage wave reuses it from a .browser.test.ts file — so nothing in here
// may touch node-only APIs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Course, Lap, Session } from '../domain/types'
import { DEFAULT_CROSSING_DETECTOR_CONFIG } from '../detection/crossing-detector'
import { DEFAULT_DETECTION_TUNABLES } from '../detection/types'
import { SCHEMA_VERSION, type AppSettings, type ExportEnvelope } from './schema'
import { isNotFoundError, type Storage } from './storage'

export type ContractStorage = Storage & { cleanup?(): Promise<void> | void }
export type StorageFactory = () => Promise<ContractStorage>

let fixtureCounter = 0

export function makeCourse(overrides: Partial<Course> = {}): Course {
  fixtureCounter++
  return {
    id: `course-${String(fixtureCounter).padStart(4, '0')}`,
    name: `Course ${String(fixtureCounter)}`,
    direction: 'ltr',
    minLapTimeMs: 3000,
    createdAt: '2026-07-12T09:30:00.000Z',
    ...overrides,
  }
}

export function makeLap(overrides: Partial<Lap> = {}): Lap {
  return {
    n: 1,
    durationMs: 14320,
    completedAt: '2026-07-12T10:06:02.310Z',
    status: 'valid',
    ...overrides,
  }
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  fixtureCounter++
  return {
    id: `session-${String(fixtureCounter).padStart(4, '0')}`,
    courseId: 'course-0000',
    startedAt: '2026-07-12T10:05:00.000Z',
    note: '',
    detectionConfig: structuredClone({
      tunables: DEFAULT_DETECTION_TUNABLES,
      detector: DEFAULT_CROSSING_DETECTOR_CONFIG,
    }),
    laps: [
      makeLap({ n: 1 }),
      makeLap({ n: 2, durationMs: 13980, completedAt: '2026-07-12T10:06:16.290Z', status: 'discarded' }),
    ],
    ...overrides,
  }
}

export function describeStorageContract(name: string, makeStorage: StorageFactory): void {
  describe(`Storage contract — ${name}`, () => {
    let storage: ContractStorage

    beforeEach(async () => {
      storage = await makeStorage()
    })

    afterEach(async () => {
      await storage.cleanup?.()
    })

    describe('courses + settings', () => {
      it('empty storage loads no courses and default settings', async () => {
        expect(await storage.loadCourses()).toEqual({
          courses: [],
          settings: { speechEnabled: true },
        })
      })

      it('round-trips courses and a fully-populated settings object', async () => {
        const courses = [makeCourse(), makeCourse({ direction: 'rtl', minLapTimeMs: 5000 })]
        const settings: AppSettings = {
          speechEnabled: false,
          lastExportAt: '2026-07-12T18:00:00.000Z',
          lastCourseId: courses[1].id,
        }
        await storage.saveCourses({ courses, settings })
        expect(await storage.loadCourses()).toEqual({ courses, settings })
      })

      it('saveCourses replaces the whole document', async () => {
        await storage.saveCourses({
          courses: [makeCourse(), makeCourse()],
          settings: { speechEnabled: true },
        })
        const replacement = { courses: [makeCourse()], settings: { speechEnabled: false } }
        await storage.saveCourses(replacement)
        expect(await storage.loadCourses()).toEqual(replacement)
      })

      it('mutating saved input or loaded output does not affect stored state', async () => {
        const course = makeCourse({ name: 'original' })
        const input = { courses: [course], settings: { speechEnabled: true } }
        await storage.saveCourses(input)
        input.courses[0].name = 'mutated input'
        input.settings.speechEnabled = false

        const loaded = await storage.loadCourses()
        loaded.courses[0].name = 'mutated output'
        loaded.courses.push(makeCourse())

        expect(await storage.loadCourses()).toEqual({
          courses: [{ ...course, name: 'original' }],
          settings: { speechEnabled: true },
        })
      })
    })

    describe('sessions', () => {
      it('loadSession rejects with StorageError not-found for an unknown id', async () => {
        const error = await storage.loadSession('no-such-session').then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(isNotFoundError(error)).toBe(true)
      })

      it('round-trips a session deeply (laps, detectionConfig)', async () => {
        const session = makeSession({ note: 'new props, 300mah' })
        await storage.saveSession(session)
        expect(await storage.loadSession(session.id)).toEqual(session)
      })

      it('saveSession with an existing id overwrites', async () => {
        const session = makeSession()
        await storage.saveSession(session)
        const updated: Session = {
          ...session,
          note: 'after lap 3',
          laps: [...session.laps, makeLap({ n: 3, durationMs: 12100 })],
        }
        await storage.saveSession(updated)
        expect(await storage.loadSession(session.id)).toEqual(updated)
        expect(await storage.listSessions()).toHaveLength(1)
      })

      it('mutating saved input or loaded output does not affect stored state', async () => {
        const session = makeSession()
        const pristine = structuredClone(session)
        await storage.saveSession(session)
        session.laps.push(makeLap({ n: 99 }))
        session.detectionConfig.tunables.stripCount = 99

        const loaded = await storage.loadSession(pristine.id)
        loaded.laps[0].status = 'discarded'
        loaded.note = 'mutated output'

        expect(await storage.loadSession(pristine.id)).toEqual(pristine)
      })
    })

    describe('summaries and ordering', () => {
      it('listSessions on empty storage returns []', async () => {
        expect(await storage.listSessions()).toEqual([])
      })

      it('summarizes lap counts and orders newest first, startedAt ties broken by larger id', async () => {
        const oldest = makeSession({ id: 'b-old', startedAt: '2026-07-10T08:00:00.000Z' })
        const tieSmallId = makeSession({ id: 'a-tie', startedAt: '2026-07-12T10:00:00.000Z' })
        const tieLargeId = makeSession({ id: 'z-tie', startedAt: '2026-07-12T10:00:00.000Z' })
        const newest = makeSession({
          id: 'c-new',
          startedAt: '2026-07-12T11:00:00.000Z',
          laps: [makeLap({ n: 1 }), makeLap({ n: 2, status: 'discarded' }), makeLap({ n: 3 })],
        })
        for (const session of [newest, oldest, tieSmallId, tieLargeId]) {
          await storage.saveSession(session)
        }

        const summaries = await storage.listSessions()
        expect(summaries.map((s) => s.id)).toEqual(['c-new', 'z-tie', 'a-tie', 'b-old'])
        expect(summaries[0]).toEqual({
          id: 'c-new',
          courseId: newest.courseId,
          startedAt: newest.startedAt,
          lapCount: 3,
          validLapCount: 2,
        })
      })

      it('latestSessionForCourse returns undefined when the course has no sessions', async () => {
        await storage.saveSession(makeSession({ courseId: 'other-course' }))
        expect(await storage.latestSessionForCourse('course-without-sessions')).toBeUndefined()
      })

      it('latestSessionForCourse picks that course’s newest session, ties broken by larger id', async () => {
        await storage.saveSession(
          makeSession({ courseId: 'target', startedAt: '2026-07-11T09:00:00.000Z' }),
        )
        const tieWinner = makeSession({
          id: 'z-tie',
          courseId: 'target',
          startedAt: '2026-07-12T09:00:00.000Z',
        })
        await storage.saveSession(tieWinner)
        await storage.saveSession(
          makeSession({ id: 'a-tie', courseId: 'target', startedAt: '2026-07-12T09:00:00.000Z' }),
        )
        await storage.saveSession(
          makeSession({ courseId: 'decoy', startedAt: '2026-07-13T09:00:00.000Z' }),
        )

        expect(await storage.latestSessionForCourse('target')).toEqual(tieWinner)
      })
    })

    describe('export', () => {
      it('exportAll assembles the complete envelope, sessions oldest first', async () => {
        const courses = [makeCourse()]
        const settings: AppSettings = { speechEnabled: true, lastExportAt: '2026-07-01T00:00:00.000Z' }
        await storage.saveCourses({ courses, settings })
        const older = makeSession({ startedAt: '2026-07-10T08:00:00.000Z' })
        const newer = makeSession({ startedAt: '2026-07-12T08:00:00.000Z' })
        await storage.saveSession(newer)
        await storage.saveSession(older)

        const before = Date.now()
        const envelope = await storage.exportAll()
        const after = Date.now()

        expect(envelope.schemaVersion).toBe(SCHEMA_VERSION)
        expect(envelope.courses).toEqual(courses)
        expect(envelope.settings).toEqual(settings)
        expect(envelope.sessions).toEqual([older, newer])
        const exportedAt = Date.parse(envelope.exportedAt)
        expect(exportedAt).toBeGreaterThanOrEqual(before)
        expect(exportedAt).toBeLessThanOrEqual(after)
      })

      it('mutating the exported envelope does not affect stored state', async () => {
        const session = makeSession()
        await storage.saveSession(session)
        const envelope = await storage.exportAll()
        envelope.sessions[0].note = 'mutated envelope'
        envelope.sessions[0].laps.length = 0
        expect(await storage.loadSession(session.id)).toEqual(session)
      })
    })

    describe('import (merge by id, storage.md)', () => {
      function makeEnvelope(overrides: Partial<ExportEnvelope> = {}): ExportEnvelope {
        return {
          schemaVersion: SCHEMA_VERSION,
          exportedAt: '2026-07-12T00:00:00.000Z',
          courses: [],
          settings: { speechEnabled: true },
          sessions: [],
          ...overrides,
        }
      }

      it('into empty storage adds every course and session and reports the counts', async () => {
        const course = makeCourse()
        const sessions = [
          makeSession({ courseId: course.id, startedAt: '2026-07-10T08:00:00.000Z' }),
          makeSession({ courseId: course.id, startedAt: '2026-07-11T08:00:00.000Z' }),
        ]
        const result = await storage.importAll(makeEnvelope({ courses: [course], sessions }))

        expect(result).toEqual({
          coursesAdded: 1,
          coursesSkipped: 0,
          sessionsAdded: 2,
          sessionsSkipped: 0,
        })
        expect((await storage.loadCourses()).courses).toEqual([course])
        expect(await storage.loadSession(sessions[0].id)).toEqual(sessions[0])
        expect(await storage.loadSession(sessions[1].id)).toEqual(sessions[1])
      })

      it('adds unknown ids, skips existing ids without overwriting local content', async () => {
        const localCourse = makeCourse({ name: 'local name' })
        const localSession = makeSession({ courseId: localCourse.id, note: 'local note' })
        await storage.saveCourses({ courses: [localCourse], settings: { speechEnabled: true } })
        await storage.saveSession(localSession)

        const newCourse = makeCourse()
        const newSession = makeSession({ courseId: newCourse.id })
        const result = await storage.importAll(
          makeEnvelope({
            courses: [{ ...localCourse, name: 'imported name' }, newCourse],
            sessions: [{ ...localSession, note: 'imported note' }, newSession],
          }),
        )

        expect(result).toEqual({
          coursesAdded: 1,
          coursesSkipped: 1,
          sessionsAdded: 1,
          sessionsSkipped: 1,
        })
        expect((await storage.loadCourses()).courses).toEqual([localCourse, newCourse])
        expect(await storage.loadSession(localSession.id)).toEqual(localSession)
        expect(await storage.loadSession(newSession.id)).toEqual(newSession)
      })

      it('re-importing the same file is idempotent: all skips, state unchanged', async () => {
        const course = makeCourse()
        const envelope = makeEnvelope({
          courses: [course],
          sessions: [makeSession({ courseId: course.id })],
        })
        await storage.importAll(envelope)
        const coursesAfterFirst = await storage.loadCourses()
        const sessionsAfterFirst = await storage.listSessions()

        const result = await storage.importAll(envelope)

        expect(result).toEqual({
          coursesAdded: 0,
          coursesSkipped: 1,
          sessionsAdded: 0,
          sessionsSkipped: 1,
        })
        expect(await storage.loadCourses()).toEqual(coursesAfterFirst)
        expect(await storage.listSessions()).toEqual(sessionsAfterFirst)
      })

      it('local settings always win: imported settings are ignored entirely', async () => {
        const localSettings: AppSettings = {
          speechEnabled: false,
          lastExportAt: '2026-07-01T00:00:00.000Z',
          lastCourseId: 'local-course',
        }
        await storage.saveCourses({ courses: [], settings: localSettings })

        await storage.importAll(
          makeEnvelope({
            courses: [makeCourse()],
            settings: {
              speechEnabled: true,
              lastExportAt: '2026-07-12T00:00:00.000Z',
              lastCourseId: 'imported-course',
            },
          }),
        )

        expect((await storage.loadCourses()).settings).toEqual(localSettings)
      })

      it('orphan sessions (courseId matching no course) are imported, not dropped', async () => {
        const orphan = makeSession({ courseId: 'course-nobody-has' })
        const result = await storage.importAll(makeEnvelope({ sessions: [orphan] }))

        expect(result).toEqual({
          coursesAdded: 0,
          coursesSkipped: 0,
          sessionsAdded: 1,
          sessionsSkipped: 0,
        })
        expect(await storage.loadSession(orphan.id)).toEqual(orphan)
        expect((await storage.loadCourses()).courses).toEqual([])
      })
    })

    describe('persistence status', () => {
      it('persistenceStatus reports a boolean persisted flag', async () => {
        const status = await storage.persistenceStatus()
        expect(typeof status.persisted).toBe('boolean')
      })
    })
  })
}
