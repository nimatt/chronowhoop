// Reusable Storage contract suite (plan 06 item 2): every implementation must
// pass the same describe block. memory-storage.test.ts runs it in node; the
// OpfsStorage wave reuses it from a .browser.test.ts file — so nothing in here
// may touch node-only APIs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Course, Lap, Session } from '../domain/types'
import { DEFAULT_CROSSING_DETECTOR_CONFIG } from '../detection/crossing-detector'
import { DEFAULT_DETECTION_TUNABLES } from '../detection/types'
import {
  SCHEMA_VERSION,
  type AppSettings,
  type ExportEnvelope,
  type PendingCourseDeletion,
} from './schema'
import { isNotFoundError, isStorageError, StorageError, type Storage } from './storage'

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

    describe('deletion', () => {
      function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
        return promise.then(
          () => undefined,
          (error: unknown) => error,
        )
      }

      // The on-disk state a crash between the cascade's INTENT and COMMIT
      // writes leaves behind. Written through saveCourses — the public seam —
      // rather than poked into a private field, so the marker takes a real
      // serialize/parse round trip: a parseSettings that silently dropped the
      // key would make the whole recovery mechanism inert dead code, and only
      // a test that reads it back off the implementation can catch that.
      function marker(course: Course, sessionIds: string[]): PendingCourseDeletion {
        return { courseId: course.id, courseName: course.name, sessionIds }
      }

      describe('cascade', () => {
        it('deleteCourse removes the course and exactly its sessions, and reports the count', async () => {
          const doomed = makeCourse({ name: 'Basement 3-gate' })
          const bystander = makeCourse({ name: 'Garage loop' })
          const doomedSessions = [
            makeSession({ courseId: doomed.id, startedAt: '2026-07-12T10:00:00.000Z' }),
            makeSession({ courseId: doomed.id, startedAt: '2026-07-11T10:00:00.000Z' }),
          ]
          const bystanderSession = makeSession({ courseId: bystander.id })
          await storage.saveCourses({
            courses: [doomed, bystander],
            settings: { speechEnabled: true },
          })
          for (const session of [...doomedSessions, bystanderSession]) {
            await storage.saveSession(session)
          }

          expect(await storage.deleteCourse(doomed.id)).toEqual({ sessionsDeleted: 2 })

          expect((await storage.loadCourses()).courses).toEqual([bystander])
          expect((await storage.listSessions()).map((s) => s.id)).toEqual([bystanderSession.id])
          expect(await storage.loadSession(bystanderSession.id)).toEqual(bystanderSession)
          for (const session of doomedSessions) {
            expect(isNotFoundError(await rejectionOf(storage.loadSession(session.id)))).toBe(true)
          }
        })

        it('clears lastCourseId when it pointed at the deleted course', async () => {
          const course = makeCourse()
          await storage.saveCourses({
            courses: [course],
            settings: { speechEnabled: false, lastCourseId: course.id },
          })

          await storage.deleteCourse(course.id)

          expect((await storage.loadCourses()).settings).toEqual({ speechEnabled: false })
        })

        it('leaves lastCourseId alone when it pointed at a different course', async () => {
          const doomed = makeCourse()
          const current = makeCourse()
          await storage.saveCourses({
            courses: [doomed, current],
            settings: { speechEnabled: true, lastCourseId: current.id },
          })

          await storage.deleteCourse(doomed.id)

          expect((await storage.loadCourses()).settings).toEqual({
            speechEnabled: true,
            lastCourseId: current.id,
          })
        })

        // THE FORBIDDEN STATE, from the other side. The guard above can only
        // refuse writes it can see coming; a write that landed while the cascade
        // was still READING passed its pre-check honestly (nothing was condemned
        // yet) and is in no snapshot the cascade took. Nothing keyed by session
        // id can ever name it. Once the COMMIT has landed — and only then — the
        // course is definitively gone and the file is an orphan, so the cascade
        // re-lists and takes it. Without that sweep it survives: invisible (no
        // screen lists a session whose course is gone) and riding out in every
        // future export as "Unknown course".
        it('no readable session file outlives its course: one that landed mid-scan is swept after the COMMIT', async () => {
          const course = makeCourse({ name: 'Basement 3-gate' })
          const known = makeSession({ courseId: course.id })
          const bystander = makeSession({ courseId: 'other-course' })
          await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
          await storage.saveSession(known)
          await storage.saveSession(bystander)

          const landsMidScan = makeSession({ courseId: course.id })
          let landed = false
          const scan = storage.listSessions.bind(storage)
          storage.listSessions = async () => {
            const summaries = await scan()
            if (!landed) {
              landed = true
              await storage.saveSession(landsMidScan)
            }
            return summaries
          }

          const result = await storage.deleteCourse(course.id)
          storage.listSessions = scan

          expect(landed).toBe(true)
          // Honest about what it destroyed: the one it counted, and the one the
          // sweep found.
          expect(result).toEqual({ sessionsDeleted: 2 })
          expect((await storage.loadCourses()).courses).toEqual([])
          expect((await storage.listSessions()).map((s) => s.id)).toEqual([bystander.id])
        })

        it('deleteCourse with an unknown id resolves, and still sweeps sessions referencing it', async () => {
          const stray = makeSession({ courseId: 'course-nobody-has' })
          await storage.saveSession(stray)

          expect(await storage.deleteCourse('course-nobody-has')).toEqual({ sessionsDeleted: 1 })

          expect(await storage.listSessions()).toEqual([])
          expect((await storage.loadCourses()).courses).toEqual([])
        })
      })

      // deleteSession's idempotence is the OPPOSITE of loadSession's not-found
      // contract, so it gets implemented wrong unless it is pinned: a double-tap
      // and the retry after a partially-applied cascade must both be safe, and
      // neither is if the second call throws.
      describe('idempotence', () => {
        it('deleteSession on an unknown id resolves — it never rejects not-found', async () => {
          await expect(storage.deleteSession('no-such-session')).resolves.toBeUndefined()
        })

        it('deleting the same course twice resolves; the second sweep finds nothing left', async () => {
          const course = makeCourse()
          await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
          await storage.saveSession(makeSession({ courseId: course.id }))

          expect(await storage.deleteCourse(course.id)).toEqual({ sessionsDeleted: 1 })
          expect(await storage.deleteCourse(course.id)).toEqual({ sessionsDeleted: 0 })

          expect((await storage.loadCourses()).courses).toEqual([])
          expect(await storage.listSessions()).toEqual([])
        })
      })

      // The in-memory, instance-scoped resurrection guard: a write that was
      // already in flight when a delete ran must not re-create what the delete
      // removed. It is NOT a tombstone list (see the import pin below).
      describe('resurrection guard', () => {
        it('a deleted session cannot be written back: saveSession rejects not-found', async () => {
          const session = makeSession()
          await storage.saveSession(session)
          await storage.deleteSession(session.id)

          expect(isNotFoundError(await rejectionOf(storage.saveSession(session)))).toBe(true)
          expect(await storage.listSessions()).toEqual([])
        })

        it('after deleteCourse, saveSession rejects not-found for any session of that course — including an id that never reached disk', async () => {
          const course = makeCourse()
          const flown = makeSession({ courseId: course.id })
          await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
          await storage.saveSession(flown)

          await storage.deleteCourse(course.id)

          expect(isNotFoundError(await rejectionOf(storage.saveSession(flown)))).toBe(true)
          // THE STRAGGLING PERSISTER, and the whole reason the guard carries a
          // COURSE id set and not just a session id set: a session armed moments
          // before the delete, whose first write is still in flight, is not in
          // the cascade's listSessions() snapshot at all — so no set of session
          // ids could ever know about it. Let this write land and the result is
          // a session file whose course is gone: exactly the ghost state the
          // cascade exists to prevent.
          const unborn = makeSession({ courseId: course.id })
          expect(isNotFoundError(await rejectionOf(storage.saveSession(unborn)))).toBe(true)
          expect(await storage.listSessions()).toEqual([])
        })

        // THE ORDERING, not just the existence, of the guard registration. The
        // test above lands its straggler after deleteCourse RESOLVED, which any
        // implementation passes as long as it records the course id at some
        // point. This one lands it INSIDE the cascade — after INTENT, before
        // COMMIT — which is the only window that produces the forbidden state,
        // and the only thing that distinguishes "condemn, then destroy" from
        // "destroy, then condemn".
        //
        // Condemn after the session files are gone and the straggler is
        // ACCEPTED: its file is created, the cascade's doomed list (a
        // listSessions() snapshot taken before it existed) never named it, and
        // COMMIT then removes the course — leaving a READABLE SESSION FILE
        // WHOSE COURSE IS GONE. That is the one state this whole phase exists
        // to make impossible (ADR 0011).
        //
        // Note what this does NOT say: it does not say the condemn precedes the
        // cascade's READS. It must not — the reads take real time, and a
        // deletion that has not committed (and may fail at its very first write)
        // must never refuse, let alone destroy, a write that races it. See "a
        // cascade that fails at its INTENT write destroys nothing" below.
        it('a straggling write landing mid-cascade is refused: the guard is armed before the session files go, not after', async () => {
          const course = makeCourse({ name: 'Basement 3-gate' })
          const flown = makeSession({ courseId: course.id })
          await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
          await storage.saveSession(flown)

          // Never persisted: the fly screen's fire-and-forget persister flush
          // (fly-session.svelte.ts) for a session armed moments before the
          // delete, whose first write is still in flight. No snapshot of what is
          // on disk can name it.
          const unborn = makeSession({ courseId: course.id })
          let strayWriteFired = false
          let strayWriteOutcome: unknown
          const sweep = storage.deleteSession.bind(storage)
          storage.deleteSession = async (id: string) => {
            if (!strayWriteFired) {
              strayWriteFired = true
              strayWriteOutcome = await rejectionOf(storage.saveSession(unborn))
            }
            await sweep(id)
          }

          await storage.deleteCourse(course.id)
          storage.deleteSession = sweep

          expect(strayWriteFired).toBe(true)
          expect(isNotFoundError(strayWriteOutcome)).toBe(true)
          // The forbidden state, stated as the plan states it: no readable
          // session file outlives its course.
          expect(await storage.listSessions()).toEqual([])
          expect((await storage.loadCourses()).courses).toEqual([])
        })

        // CONDEMNING MAY ONLY REFUSE. A cascade destroys nothing until it has
        // deleteSession'd an id or committed, and a cascade can die at its very
        // first write — quota on the INTENT write is the likely one, and it is
        // exactly the regime in which a persister is stuck retrying too.
        //
        // The stray write here lands while the cascade is still READING (its
        // read-before-destroy scan), which is the only place it can land: after
        // that the course is condemned and it would rightly be refused. Condemn
        // before the reads instead and this write never lands at all — and if
        // it had already been inside the implementation's write when the condemn
        // fired, the post-write compensation would have removed the bytes it had
        // just put down. Either way: a delete that did nothing destroyed a
        // session.
        it('a cascade that fails at its INTENT write destroys nothing — a session that raced it survives', async () => {
          const course = makeCourse({ name: 'Basement 3-gate' })
          const flown = makeSession({ courseId: course.id })
          await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
          await storage.saveSession(flown)

          // The fly screen's fire-and-forget flush outlives its component, and a
          // write-failed retry can still be in backoff minutes later: this write
          // is in flight when the pilot taps Delete.
          const racing = makeSession({ courseId: course.id, note: 'still flying' })
          let racingOutcome: unknown = 'never attempted'
          const scan = storage.listSessions.bind(storage)
          storage.listSessions = async () => {
            const summaries = await scan()
            if (racingOutcome === 'never attempted') {
              racingOutcome = await rejectionOf(storage.saveSession(racing))
            }
            return summaries
          }
          const write = storage.saveCourses.bind(storage)
          storage.saveCourses = () =>
            Promise.reject(new StorageError('quota-exceeded', 'injected: no room for the marker'))

          const failure = await rejectionOf(storage.deleteCourse(course.id))
          storage.listSessions = scan
          storage.saveCourses = write

          expect(isStorageError(failure)).toBe(true)
          // The write landed — the cascade had not committed to anything yet, so
          // it had no business refusing it.
          expect(racingOutcome).toBeUndefined()
          // And nothing was destroyed. The course is standing, the marker never
          // landed, and BOTH sessions are still readable.
          expect((await storage.loadCourses()).courses).toEqual([course])
          expect((await storage.loadCourses()).settings.pendingCourseDeletions).toBeUndefined()
          expect(await storage.loadSession(flown.id)).toEqual(flown)
          expect(await storage.loadSession(racing.id)).toEqual(racing)
          // The course is flyable again: the failed cascade released it.
          await expect(storage.saveSession(racing)).resolves.toBeUndefined()
        })
      })

      // ─────────────────────────────────────────────────────────────────────
      // READ THIS BEFORE "FIXING" IT. There are deliberately NO persisted
      // tombstones (ADR 0011). Re-importing an export that predates a deletion
      // brings the deleted data BACK, and that is INTENDED: the export file is
      // the only undo this product has (docs/specs/storage.md) — the delete
      // confirmation screen literally offers "Export backup first" and calls
      // that file the way to get this back.
      //
      // Making import honour a tombstone list would make importIntoStorage
      // silently DROP sessions the user just handed the app, on the exact
      // phone→desktop path storage.md calls the v1 cross-device story. This
      // test exists to stop that "consistency fix" from ever landing.
      // ─────────────────────────────────────────────────────────────────────
      describe('import re-admits deleted ids (the export file is the only undo)', () => {
        it('re-importing a pre-delete export restores the course AND its sessions', async () => {
          const course = makeCourse({ name: 'Basement 3-gate' })
          const sessions = [
            makeSession({ courseId: course.id, startedAt: '2026-07-10T08:00:00.000Z' }),
            makeSession({ courseId: course.id, startedAt: '2026-07-11T08:00:00.000Z' }),
          ]
          await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
          for (const session of sessions) await storage.saveSession(session)
          const backup = await storage.exportAll()

          await storage.deleteCourse(course.id)
          expect((await storage.loadCourses()).courses).toEqual([])
          expect(await storage.listSessions()).toEqual([])

          expect(await storage.importAll(backup)).toEqual({
            coursesAdded: 1,
            coursesSkipped: 0,
            sessionsAdded: 2,
            sessionsSkipped: 0,
          })

          expect((await storage.loadCourses()).courses).toEqual([course])
          expect(await storage.loadSession(sessions[0].id)).toEqual(sessions[0])
          expect(await storage.loadSession(sessions[1].id)).toEqual(sessions[1])
          // And the restored data is live again — the guard let go of the ids,
          // it did not merely permit one import.
          const flownAfterRestore = makeSession({ courseId: course.id })
          await expect(storage.saveSession(flownAfterRestore)).resolves.toBeUndefined()
        })
      })

      // The marker is a BOUNDED WORK LIST, not a standing instruction to
      // "delete course X". A resume may only ever remove the ids the
      // confirmation screen counted.
      describe('pending-deletion marker and resume', () => {
        it('a resume deletes only the sessions the marker recorded, and nothing of another course', async () => {
          const doomed = makeCourse({ name: 'Basement 3-gate' })
          const bystander = makeCourse()
          // The crash landed part-way through step 2: this one's file is
          // already gone, and its id is still on the work list.
          const alreadyRemoved = makeSession({ courseId: doomed.id })
          const stillOnDisk = makeSession({ courseId: doomed.id })
          const bystanderSession = makeSession({ courseId: bystander.id })
          await storage.saveSession(stillOnDisk)
          await storage.saveSession(bystanderSession)
          await storage.saveCourses({
            courses: [doomed, bystander],
            settings: {
              speechEnabled: true,
              lastCourseId: doomed.id,
              pendingCourseDeletions: [marker(doomed, [alreadyRemoved.id, stillOnDisk.id])],
            },
          })

          expect(await storage.resumePendingDeletions()).toEqual([
            {
              kind: 'completed',
              courseId: doomed.id,
              courseName: doomed.name,
              sessionsDeleted: 2,
            },
          ])

          const after = await storage.loadCourses()
          expect(after.courses).toEqual([bystander])
          expect(after.settings).toEqual({ speechEnabled: true })
          expect((await storage.listSessions()).map((s) => s.id)).toEqual([bystanderSession.id])
        })

        it('abandoned (flown-since): a session the marker never counted keeps the course and everything on it', async () => {
          const course = makeCourse({ name: 'Basement 3-gate' })
          const confirmed = makeSession({
            courseId: course.id,
            startedAt: '2026-07-12T10:00:00.000Z',
          })
          // Flown AFTER the interrupted delete: the confirmation screen never
          // counted it. Completing the deletion now would destroy data the user
          // never confirmed — which is what turns an abandoned deletion into a
          // standing instruction. Abandon instead: keep the course, keep every
          // session, clear the marker.
          const flownSince = makeSession({
            courseId: course.id,
            startedAt: '2026-07-13T09:00:00.000Z',
          })
          await storage.saveSession(confirmed)
          await storage.saveSession(flownSince)
          await storage.saveCourses({
            courses: [course],
            settings: {
              speechEnabled: true,
              lastCourseId: course.id,
              pendingCourseDeletions: [marker(course, [confirmed.id])],
            },
          })

          expect(await storage.resumePendingDeletions()).toEqual([
            {
              kind: 'abandoned',
              courseId: course.id,
              courseName: course.name,
              reason: 'flown-since',
            },
          ])

          const after = await storage.loadCourses()
          expect(after.courses).toEqual([course])
          expect(after.settings).toEqual({ speechEnabled: true, lastCourseId: course.id })
          expect((await storage.listSessions()).map((s) => s.id)).toEqual([
            flownSince.id,
            confirmed.id,
          ])
          expect(await storage.loadSession(confirmed.id)).toEqual(confirmed)
          expect(await storage.loadSession(flownSince.id)).toEqual(flownSince)
        })

        // THE RESUME MUST NOT DISARM ITS OWN SAFETY RULE. It runs unawaited at
        // startup, the course is still LISTED while it runs (the INTENT write
        // keeps it present on purpose, so the fly screen still offers it), and
        // its scan is a full body scan taking real time. A pilot can tap that
        // course and arm a flight inside that window.
        //
        // Condemn before the scan and the arm's saveSession is REFUSED: the
        // session never lands, so the scan finds no stray, so flown-since never
        // fires, so the resume COMPLETES — deleting the course the pilot is
        // flying, with none of that flight's laps saved. The rule inverts into
        // the very destruction it exists to prevent. The session must be able to
        // land, and landing must abandon the deletion.
        it('a session armed while the resume is scanning ABANDONS the deletion — the course and the flight survive', async () => {
          const course = makeCourse({ name: 'Basement 3-gate' })
          const confirmed = makeSession({
            courseId: course.id,
            startedAt: '2026-07-12T10:00:00.000Z',
          })
          await storage.saveSession(confirmed)
          await storage.saveCourses({
            courses: [course],
            settings: {
              speechEnabled: true,
              lastCourseId: course.id,
              pendingCourseDeletions: [marker(course, [confirmed.id])],
            },
          })

          // A scan reads a SNAPSHOT: OPFS collects the directory's names first
          // and reads the bodies afterwards, so a session file created while it
          // runs is on disk but absent from its result. Modelled exactly —
          // summaries computed, then the pilot arms, then the stale summaries
          // come back. An implementation that only ever scans once cannot see
          // this session, and will delete it.
          const armed = makeSession({
            courseId: course.id,
            startedAt: '2026-07-13T09:00:00.000Z',
            note: 'armed while the resume was scanning',
          })
          let armOutcome: unknown = 'never attempted'
          const scan = storage.listSessions.bind(storage)
          storage.listSessions = async () => {
            const summaries = await scan()
            if (armOutcome === 'never attempted') {
              armOutcome = await rejectionOf(storage.saveSession(armed))
            }
            return summaries
          }

          const outcomes = await storage.resumePendingDeletions()
          storage.listSessions = scan

          // The arm LANDED: an in-flight deletion refusing it is what breaks the
          // rule.
          expect(armOutcome).toBeUndefined()
          expect(outcomes).toEqual([
            {
              kind: 'abandoned',
              courseId: course.id,
              courseName: course.name,
              reason: 'flown-since',
            },
          ])
          // Course intact, marker gone, and NOTHING deleted — including the
          // sessions the marker did name.
          const after = await storage.loadCourses()
          expect(after.courses).toEqual([course])
          expect(after.settings).toEqual({ speechEnabled: true, lastCourseId: course.id })
          expect(await storage.loadSession(armed.id)).toEqual(armed)
          expect(await storage.loadSession(confirmed.id)).toEqual(confirmed)
          // The flight goes on: the abandoned deletion released the course, so
          // the very next lap saves.
          await expect(
            storage.saveSession({ ...armed, note: 'lap 2' }),
          ).resolves.toBeUndefined()
        })

        it('multiple pending markers all resume, and no commit reverts another', async () => {
          const first = makeCourse()
          const second = makeCourse()
          const keeper = makeCourse()
          const firstSession = makeSession({ courseId: first.id })
          const secondSession = makeSession({ courseId: second.id })
          const keeperSession = makeSession({ courseId: keeper.id })
          for (const session of [firstSession, secondSession, keeperSession]) {
            await storage.saveSession(session)
          }
          await storage.saveCourses({
            courses: [first, second, keeper],
            settings: {
              speechEnabled: true,
              pendingCourseDeletions: [
                marker(first, [firstSession.id]),
                marker(second, [secondSession.id]),
              ],
            },
          })

          expect(await storage.resumePendingDeletions()).toEqual([
            { kind: 'completed', courseId: first.id, courseName: first.name, sessionsDeleted: 1 },
            { kind: 'completed', courseId: second.id, courseName: second.name, sessionsDeleted: 1 },
          ])

          // Each entry commits from a fresh read, so neither commit write
          // resurrects the course the other one just removed.
          const after = await storage.loadCourses()
          expect(after.courses).toEqual([keeper])
          expect(after.settings.pendingCourseDeletions).toBeUndefined()
          expect((await storage.listSessions()).map((s) => s.id)).toEqual([keeperSession.id])
        })

        it('resumePendingDeletions with nothing pending resolves [] and writes nothing observable', async () => {
          const course = makeCourse()
          const session = makeSession({ courseId: course.id })
          const settings: AppSettings = { speechEnabled: false, lastCourseId: course.id }
          await storage.saveCourses({ courses: [course], settings })
          await storage.saveSession(session)

          expect(await storage.resumePendingDeletions()).toEqual([])

          expect(await storage.loadCourses()).toEqual({ courses: [course], settings })
          expect(await storage.loadSession(session.id)).toEqual(session)
        })
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
