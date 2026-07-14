import { describe, expect, it } from 'vitest'
import type { Course, Session } from '../domain/types'
import {
  deleteCourseFromStorage,
  resumePendingDeletionsFromStorage,
  withPendingDeletion,
  withoutCourse,
  withoutPendingDeletion,
  type DeleteTarget,
} from './delete'
import type { AppSettings, PendingCourseDeletion } from './schema'
import { StorageError, summarizeSession, type CoursesData } from './storage'
import { makeCourse, makeSession } from './storage-contract'

// A structural DeleteTarget — the point of this file is the cascade itself, not
// either implementation of it (both delegate here; the contract suite covers
// them). EVERY call is appended to `log` in call order, reads included: the
// ordering IS the contract here, and the two orderings that matter most are
// invisible in the end state — the reads must happen BEFORE the condemn (a
// deletion in flight may never commit, so it may not lock the pilot out while
// it scans), and the destructive commit flag must be raised only AFTER the
// COMMIT write.
function makeTarget(
  options: {
    courses?: Course[]
    sessions?: Session[]
    settings?: Partial<AppSettings>
    failDeleteSessionIds?: string[]
  } = {},
) {
  const log: string[] = []
  const failing = new Set(options.failDeleteSessionIds ?? [])
  const condemned = new Set<string>()
  const committed = new Set<string>()
  let data: CoursesData = structuredClone({
    courses: options.courses ?? [],
    settings: { speechEnabled: true, ...options.settings },
  })
  const sessions = new Map(
    (options.sessions ?? []).map((session) => [session.id, structuredClone(session)]),
  )

  const describeWrite = (next: CoursesData): string => {
    const markers = (next.settings.pendingCourseDeletions ?? []).map((entry) => entry.courseId)
    return `saveCourses courses=[${next.courses.map((course) => course.id).join(',')}] pending=[${markers.join(',')}]`
  }

  const target: DeleteTarget = {
    loadCourses: () => {
      log.push('loadCourses')
      return Promise.resolve(structuredClone(data))
    },
    listSessions: () => {
      log.push('listSessions')
      return Promise.resolve([...sessions.values()].map((session) => summarizeSession(session)))
    },
    saveCourses: (next) => {
      log.push(describeWrite(next))
      data = structuredClone(next)
      return Promise.resolve()
    },
    deleteSession: (id) => {
      if (failing.has(id)) {
        return Promise.reject(new StorageError('write-failed', `injected failure deleting ${id}`))
      }
      log.push(`deleteSession:${id}`)
      sessions.delete(id)
      return Promise.resolve()
    },
    condemnCourse: (id) => {
      log.push(`condemn:${id}`)
      condemned.add(id)
    },
    releaseCourse: (id) => {
      log.push(`release:${id}`)
      condemned.delete(id)
    },
    commitCourseDeletion: (id) => {
      log.push(`commit:${id}`)
      committed.add(id)
    },
  }

  return {
    target,
    log,
    failing,
    sessions,
    condemned: (): string[] => [...condemned],
    committed: (): string[] => [...committed],
    settings: (): AppSettings => structuredClone(data.settings),
    markers: (): PendingCourseDeletion[] => structuredClone(data.settings.pendingCourseDeletions ?? []),
    courseIds: (): string[] => data.courses.map((course) => course.id),
    sessionIds: (): string[] => [...sessions.keys()],
  }
}

function marker(overrides: Partial<PendingCourseDeletion> = {}): PendingCourseDeletion {
  return { courseId: 'course-x', courseName: 'Course X', sessionIds: [], ...overrides }
}

describe('courses.json transforms', () => {
  it('withPendingDeletion appends the marker without mutating the input', () => {
    const data: CoursesData = { courses: [makeCourse()], settings: { speechEnabled: true } }
    const next = withPendingDeletion(data, marker({ sessionIds: ['s1'] }))

    expect(next.settings.pendingCourseDeletions).toEqual([marker({ sessionIds: ['s1'] })])
    expect(data.settings.pendingCourseDeletions).toBeUndefined()
    expect(next.courses).toEqual(data.courses)
  })

  it('withPendingDeletion replaces an earlier marker for the same course', () => {
    const data: CoursesData = {
      courses: [],
      settings: {
        speechEnabled: true,
        pendingCourseDeletions: [
          marker({ courseId: 'a', sessionIds: ['s1', 's2'] }),
          marker({ courseId: 'b' }),
        ],
      },
    }
    const next = withPendingDeletion(data, marker({ courseId: 'a', sessionIds: ['s2'] }))

    expect(next.settings.pendingCourseDeletions).toEqual([
      marker({ courseId: 'b' }),
      marker({ courseId: 'a', sessionIds: ['s2'] }),
    ])
  })

  it('withoutPendingDeletion drops the key entirely when the last marker goes', () => {
    const data: CoursesData = {
      courses: [],
      settings: { speechEnabled: true, pendingCourseDeletions: [marker({ courseId: 'a' })] },
    }
    const next = withoutPendingDeletion(data, 'a')

    expect('pendingCourseDeletions' in next.settings).toBe(false)
    expect(data.settings.pendingCourseDeletions).toHaveLength(1)
  })

  it('withoutCourse drops course, marker and lastCourseId in one transform', () => {
    const doomed = makeCourse({ id: 'doomed' })
    const kept = makeCourse({ id: 'kept' })
    const data: CoursesData = {
      courses: [doomed, kept],
      settings: {
        speechEnabled: true,
        lastCourseId: 'doomed',
        pendingCourseDeletions: [marker({ courseId: 'doomed' }), marker({ courseId: 'other' })],
      },
    }
    const next = withoutCourse(data, 'doomed')

    expect(next.courses).toEqual([kept])
    expect(next.settings.lastCourseId).toBeUndefined()
    expect(next.settings.pendingCourseDeletions).toEqual([marker({ courseId: 'other' })])
    expect(data.courses).toHaveLength(2)
    expect(data.settings.lastCourseId).toBe('doomed')
  })
})

describe('deleteCourseFromStorage', () => {
  it('deletes exactly the course and its sessions, and nothing else', async () => {
    const doomed = makeCourse({ id: 'doomed' })
    const kept = makeCourse({ id: 'kept' })
    const fixture = makeTarget({
      courses: [doomed, kept],
      sessions: [
        makeSession({ id: 's1', courseId: 'doomed' }),
        makeSession({ id: 's2', courseId: 'kept' }),
        makeSession({ id: 's3', courseId: 'doomed' }),
      ],
    })

    const result = await deleteCourseFromStorage(fixture.target, 'doomed')

    expect(result).toEqual({ sessionsDeleted: 2 })
    expect(fixture.courseIds()).toEqual(['kept'])
    expect(fixture.sessionIds()).toEqual(['s2'])
    expect(fixture.markers()).toEqual([])
  })

  it('reads, THEN condemns, THEN writes INTENT — and only commits the destructive guard after COMMIT', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed', name: 'Basement 3-gate' })],
      sessions: [
        makeSession({ id: 's1', courseId: 'doomed' }),
        makeSession({ id: 's2', courseId: 'doomed' }),
      ],
    })

    await deleteCourseFromStorage(fixture.target, 'doomed')

    expect(fixture.log).toEqual([
      // READ-BEFORE-DESTROY, and read-before-CONDEMN: the scan takes real time
      // and condemning refuses every session write for the course. A deletion
      // that may still fail at its very first write must not lock the pilot out
      // while it is only looking.
      'loadCourses',
      'listSessions',
      'condemn:doomed',
      'saveCourses courses=[doomed] pending=[doomed]',
      'deleteSession:s1',
      'deleteSession:s2',
      'loadCourses',
      'saveCourses courses=[] pending=[]',
      // Only NOW may a session file of this course be destroyed rather than
      // merely refused — the course is definitively gone. The sweep that
      // follows is what forbids the ghost state.
      'commit:doomed',
      'listSessions',
    ])
    // Still condemned after the commit — the course is gone, and a straggling
    // write for it must keep losing.
    expect(fixture.condemned()).toEqual(['doomed'])
    expect(fixture.committed()).toEqual(['doomed'])
  })

  it('a cascade that fails at its INTENT write never commits the destructive guard', async () => {
    const fixture = makeTarget({ courses: [makeCourse({ id: 'doomed' })] })
    const quotaExceeded: DeleteTarget = {
      ...fixture.target,
      saveCourses: () => Promise.reject(new StorageError('quota-exceeded', 'no room')),
    }

    await expect(deleteCourseFromStorage(quotaExceeded, 'doomed')).rejects.toMatchObject({
      kind: 'quota-exceeded',
    })

    // NOTHING was destroyed and nothing is authorised to be: the marker never
    // landed, the course is standing, and a persister write that raced this
    // cascade must keep its file. Committing the guard here is what let a
    // delete that did nothing remove a live session's bytes.
    expect(fixture.committed()).toEqual([])
    expect(fixture.condemned()).toEqual([])
    expect(fixture.courseIds()).toEqual(['doomed'])
  })

  it('SWEEPS a session of the course that landed after the pre-cascade scan', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed' })],
      sessions: [makeSession({ id: 's1', courseId: 'doomed' })],
    })
    // A persister write that raced the cascade: it passed its pre-check before
    // the condemn (the reads run first now) and its bytes landed while the
    // cascade was working, so it is in no snapshot the cascade took. Nothing
    // keyed by session id could ever name it — the post-commit sweep is the
    // only thing between it and outliving its course.
    let landed = false
    const racing: DeleteTarget = {
      ...fixture.target,
      deleteSession: async (id) => {
        await fixture.target.deleteSession(id)
        if (landed) return
        landed = true
        fixture.sessions.set(
          'landed-mid-cascade',
          makeSession({ id: 'landed-mid-cascade', courseId: 'doomed' }),
        )
      },
    }

    const result = await deleteCourseFromStorage(racing, 'doomed')

    expect(result).toEqual({ sessionsDeleted: 2 })
    expect(fixture.sessionIds()).toEqual([])
    expect(fixture.courseIds()).toEqual([])
  })

  it('RELEASES the course when the cascade fails: the course is still standing and must stay flyable', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed' })],
      sessions: [makeSession({ id: 's1', courseId: 'doomed' })],
      failDeleteSessionIds: ['s1'],
    })

    await expect(deleteCourseFromStorage(fixture.target, 'doomed')).rejects.toThrow()

    expect(fixture.courseIds()).toEqual(['doomed'])
    expect(fixture.condemned()).toEqual([])
  })

  it('records the course name and the exact session ids in the marker', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed', name: 'Basement 3-gate' })],
      sessions: [
        makeSession({ id: 's1', courseId: 'doomed' }),
        makeSession({ id: 's2', courseId: 'other' }),
      ],
      failDeleteSessionIds: ['s1'],
    })

    await expect(deleteCourseFromStorage(fixture.target, 'doomed')).rejects.toThrow()

    expect(fixture.markers()).toEqual([
      { courseId: 'doomed', courseName: 'Basement 3-gate', sessionIds: ['s1'] },
    ])
  })

  it('leaves a readable marker and the course standing when a crash lands between INTENT and COMMIT', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed', name: 'Basement 3-gate' })],
      sessions: [
        makeSession({ id: 's1', courseId: 'doomed' }),
        makeSession({ id: 's2', courseId: 'doomed' }),
      ],
      failDeleteSessionIds: ['s2'],
    })

    await expect(deleteCourseFromStorage(fixture.target, 'doomed')).rejects.toMatchObject({
      name: 'StorageError',
      kind: 'write-failed',
    })

    expect(fixture.courseIds()).toEqual(['doomed'])
    expect(fixture.sessionIds()).toEqual(['s2'])
    expect(fixture.markers()).toEqual([
      { courseId: 'doomed', courseName: 'Basement 3-gate', sessionIds: ['s1', 's2'] },
    ])

    // …and the next launch finishes it.
    fixture.failing.clear()
    const outcomes = await resumePendingDeletionsFromStorage(fixture.target)

    expect(outcomes).toEqual([
      {
        kind: 'completed',
        courseId: 'doomed',
        courseName: 'Basement 3-gate',
        sessionsDeleted: 2,
      },
    ])
    expect(fixture.courseIds()).toEqual([])
    expect(fixture.sessionIds()).toEqual([])
    expect(fixture.markers()).toEqual([])
  })

  it('clears lastCourseId only when it pointed at the deleted course', async () => {
    const pointingHere = makeTarget({
      courses: [makeCourse({ id: 'doomed' })],
      settings: { lastCourseId: 'doomed' },
    })
    await deleteCourseFromStorage(pointingHere.target, 'doomed')
    expect(pointingHere.settings().lastCourseId).toBeUndefined()

    const pointingElsewhere = makeTarget({
      courses: [makeCourse({ id: 'doomed' }), makeCourse({ id: 'kept' })],
      settings: { lastCourseId: 'kept' },
    })
    await deleteCourseFromStorage(pointingElsewhere.target, 'doomed')
    expect(pointingElsewhere.settings().lastCourseId).toBe('kept')
  })

  it('sweeps sessions referencing an unknown course id without throwing (the retry path)', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'kept' })],
      sessions: [
        makeSession({ id: 's1', courseId: 'gone' }),
        makeSession({ id: 's2', courseId: 'kept' }),
      ],
    })

    const result = await deleteCourseFromStorage(fixture.target, 'gone')

    expect(result).toEqual({ sessionsDeleted: 1 })
    expect(fixture.sessionIds()).toEqual(['s2'])
    expect(fixture.courseIds()).toEqual(['kept'])
    expect(fixture.markers()).toEqual([])
  })

  it('is idempotent: a second delete of the same course resolves and changes nothing', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed' })],
      sessions: [makeSession({ id: 's1', courseId: 'doomed' })],
    })

    await deleteCourseFromStorage(fixture.target, 'doomed')
    const second = await deleteCourseFromStorage(fixture.target, 'doomed')

    expect(second).toEqual({ sessionsDeleted: 0 })
    expect(fixture.courseIds()).toEqual([])
    expect(fixture.sessionIds()).toEqual([])
    expect(fixture.markers()).toEqual([])
  })

  it('touches nothing when loadCourses rejects — read-before-destroy', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed' })],
      sessions: [makeSession({ id: 's1', courseId: 'doomed' })],
    })
    const unreadable: DeleteTarget = {
      ...fixture.target,
      loadCourses: () =>
        Promise.reject(new StorageError('unsupported-version', 'written by a newer app')),
    }

    await expect(deleteCourseFromStorage(unreadable, 'doomed')).rejects.toMatchObject({
      kind: 'unsupported-version',
    })

    // Nothing written, nothing removed — and the course never even condemned:
    // a cascade that cannot read must not so much as refuse a pilot's write.
    expect(fixture.log).toEqual([])
    expect(fixture.condemned()).toEqual([])
    expect(fixture.sessionIds()).toEqual(['s1'])
  })

  it('commits from a re-read, so a course created mid-cascade survives', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed' })],
      sessions: [makeSession({ id: 's1', courseId: 'doomed' })],
    })
    const racy: DeleteTarget = {
      ...fixture.target,
      deleteSession: async (id) => {
        await fixture.target.deleteSession(id)
        const data = await fixture.target.loadCourses()
        await fixture.target.saveCourses({
          courses: [...data.courses, makeCourse({ id: 'created-during' })],
          settings: data.settings,
        })
      },
    }

    await deleteCourseFromStorage(racy, 'doomed')

    expect(fixture.courseIds()).toEqual(['created-during'])
  })
})

describe('resumePendingDeletionsFromStorage', () => {
  it('resolves [] when nothing is pending', async () => {
    const fixture = makeTarget({ courses: [makeCourse()] })

    expect(await resumePendingDeletionsFromStorage(fixture.target)).toEqual([])
    // One read to find no marker, and not one thing beyond it: no scan, no
    // condemn, no write.
    expect(fixture.log).toEqual(['loadCourses'])
  })

  it('deletes only the recorded session ids', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed', name: 'Basement' })],
      sessions: [
        makeSession({ id: 's1', courseId: 'doomed' }),
        makeSession({ id: 's2', courseId: 'other' }),
      ],
      settings: {
        pendingCourseDeletions: [
          { courseId: 'doomed', courseName: 'Basement', sessionIds: ['s1'] },
        ],
      },
    })

    const outcomes = await resumePendingDeletionsFromStorage(fixture.target)

    expect(outcomes).toEqual([
      { kind: 'completed', courseId: 'doomed', courseName: 'Basement', sessionsDeleted: 1 },
    ])
    expect(fixture.sessionIds()).toEqual(['s2'])
    expect(fixture.courseIds()).toEqual([])
  })

  it('SCANS FOR STRAYS BEFORE CONDEMNING, re-scans after, and only then deletes', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed', name: 'Basement' })],
      sessions: [makeSession({ id: 's1', courseId: 'doomed' })],
      settings: {
        pendingCourseDeletions: [
          { courseId: 'doomed', courseName: 'Basement', sessionIds: ['s1'] },
        ],
      },
    })

    await resumePendingDeletionsFromStorage(fixture.target)

    // THE ORDERING IS THE SAFETY PROPERTY. The resume is fire-and-forget at
    // startup, the course is still LISTED while it runs (the INTENT write keeps
    // it present on purpose), and the stray scan is a full body scan taking
    // real time: a pilot can arm a flight inside that window. Condemn first and
    // that arm is REFUSED — so no stray ever appears, so flown-since never
    // fires, so the resume happily deletes the course being flown. The scan
    // must come first, and it is re-run once the condemn has made the answer
    // stable, because a session file created mid-scan is invisible to it.
    expect(fixture.log).toEqual([
      'loadCourses',
      'listSessions',
      'condemn:doomed',
      'listSessions',
      'deleteSession:s1',
      'loadCourses',
      'saveCourses courses=[] pending=[]',
      'commit:doomed',
      'listSessions',
    ])
    expect(fixture.condemned()).toEqual(['doomed'])
    expect(fixture.committed()).toEqual(['doomed'])
  })

  it('ABANDONS a session that lands after the stray scan but before the condemn — the re-scan catches it', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed', name: 'Basement' })],
      sessions: [makeSession({ id: 'old', courseId: 'doomed' })],
      settings: {
        pendingCourseDeletions: [
          { courseId: 'doomed', courseName: 'Basement', sessionIds: ['old'] },
        ],
      },
    })
    // The pilot arms a flight while the first scan is running. OPFS collects the
    // directory's names before it reads the bodies, so the session file is on
    // disk but invisible to that scan's result — model exactly that: the
    // summaries come back without it, and it is on disk immediately afterwards.
    let armed = false
    const armsDuringTheScan: DeleteTarget = {
      ...fixture.target,
      listSessions: async () => {
        const summaries = await fixture.target.listSessions()
        if (!armed) {
          armed = true
          fixture.sessions.set('armed', makeSession({ id: 'armed', courseId: 'doomed' }))
        }
        return summaries
      },
    }

    const outcomes = await resumePendingDeletionsFromStorage(armsDuringTheScan)

    expect(outcomes).toEqual([
      { kind: 'abandoned', courseId: 'doomed', courseName: 'Basement', reason: 'flown-since' },
    ])
    expect(fixture.courseIds()).toEqual(['doomed'])
    expect(fixture.sessionIds()).toEqual(['old', 'armed'])
    expect(fixture.markers()).toEqual([])
    // Released again, or the flight that just saved this course could not save
    // another lap on it.
    expect(fixture.condemned()).toEqual([])
    expect(fixture.committed()).toEqual([])
  })

  it('RELEASES the course when a resume entry fails: the course survives and stays flyable', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed', name: 'Basement' })],
      sessions: [makeSession({ id: 's1', courseId: 'doomed' })],
      settings: {
        pendingCourseDeletions: [
          { courseId: 'doomed', courseName: 'Basement', sessionIds: ['s1'] },
        ],
      },
      failDeleteSessionIds: ['s1'],
    })

    expect(await resumePendingDeletionsFromStorage(fixture.target)).toEqual([])

    expect(fixture.courseIds()).toEqual(['doomed'])
    expect(fixture.condemned()).toEqual([])
  })

  it('ABANDONS when the course was flown again since the interrupted delete', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed', name: 'Basement' })],
      sessions: [
        makeSession({ id: 'old', courseId: 'doomed' }),
        makeSession({ id: 'flown-since', courseId: 'doomed' }),
      ],
      settings: {
        lastCourseId: 'doomed',
        pendingCourseDeletions: [
          { courseId: 'doomed', courseName: 'Basement', sessionIds: ['old'] },
        ],
      },
    })

    const outcomes = await resumePendingDeletionsFromStorage(fixture.target)

    expect(outcomes).toEqual([
      { kind: 'abandoned', courseId: 'doomed', courseName: 'Basement', reason: 'flown-since' },
    ])
    expect(fixture.courseIds()).toEqual(['doomed'])
    expect(fixture.sessionIds()).toEqual(['old', 'flown-since'])
    expect(fixture.settings().lastCourseId).toBe('doomed')
    expect(fixture.markers()).toEqual([])
    expect(fixture.log.some((entry) => entry.startsWith('deleteSession'))).toBe(false)
    // Abandoning KEEPS the course, so the guard has to let go of it again —
    // the pilot who flew it since must be able to fly it again in this tab.
    expect(fixture.condemned()).toEqual([])
  })

  it('resumes every marker without one commit reverting another', async () => {
    const fixture = makeTarget({
      courses: [
        makeCourse({ id: 'a', name: 'Alpha' }),
        makeCourse({ id: 'b', name: 'Bravo' }),
        makeCourse({ id: 'c', name: 'Charlie' }),
      ],
      sessions: [
        makeSession({ id: 'a1', courseId: 'a' }),
        makeSession({ id: 'b1', courseId: 'b' }),
        makeSession({ id: 'b2', courseId: 'b' }),
        makeSession({ id: 'c1', courseId: 'c' }),
      ],
      settings: {
        pendingCourseDeletions: [
          { courseId: 'a', courseName: 'Alpha', sessionIds: ['a1'] },
          { courseId: 'b', courseName: 'Bravo', sessionIds: ['b1', 'b2'] },
        ],
      },
    })

    const outcomes = await resumePendingDeletionsFromStorage(fixture.target)

    expect(outcomes).toEqual([
      { kind: 'completed', courseId: 'a', courseName: 'Alpha', sessionsDeleted: 1 },
      { kind: 'completed', courseId: 'b', courseName: 'Bravo', sessionsDeleted: 2 },
    ])
    expect(fixture.courseIds()).toEqual(['c'])
    expect(fixture.sessionIds()).toEqual(['c1'])
    expect(fixture.markers()).toEqual([])
  })

  it('keeps a failed entry pending, still finishes the others, and never rejects', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'a', name: 'Alpha' }), makeCourse({ id: 'b', name: 'Bravo' })],
      sessions: [
        makeSession({ id: 'a1', courseId: 'a' }),
        makeSession({ id: 'b1', courseId: 'b' }),
      ],
      settings: {
        pendingCourseDeletions: [
          { courseId: 'a', courseName: 'Alpha', sessionIds: ['a1'] },
          { courseId: 'b', courseName: 'Bravo', sessionIds: ['b1'] },
        ],
      },
      failDeleteSessionIds: ['a1'],
    })

    const outcomes = await resumePendingDeletionsFromStorage(fixture.target)

    expect(outcomes).toEqual([
      { kind: 'completed', courseId: 'b', courseName: 'Bravo', sessionsDeleted: 1 },
    ])
    expect(fixture.courseIds()).toEqual(['a'])
    expect(fixture.sessionIds()).toEqual(['a1'])
    expect(fixture.markers()).toEqual([
      { courseId: 'a', courseName: 'Alpha', sessionIds: ['a1'] },
    ])
  })

  it('never rejects when courses.json cannot be read at all', async () => {
    const unreadable: DeleteTarget = {
      loadCourses: () =>
        Promise.reject(new StorageError('unsupported-version', 'written by a newer app')),
      listSessions: () => Promise.resolve([]),
      saveCourses: () => Promise.reject(new Error('must not write')),
      deleteSession: () => Promise.reject(new Error('must not delete')),
      condemnCourse: () => {
        throw new Error('must not condemn: no marker was ever read')
      },
      releaseCourse: () => {
        throw new Error('must not release')
      },
      commitCourseDeletion: () => {
        throw new Error('must not commit')
      },
    }

    expect(await resumePendingDeletionsFromStorage(unreadable)).toEqual([])
  })

  it('clears lastCourseId when completing a resumed cascade that owned it', async () => {
    const fixture = makeTarget({
      courses: [makeCourse({ id: 'doomed', name: 'Basement' })],
      sessions: [makeSession({ id: 's1', courseId: 'doomed' })],
      settings: {
        lastCourseId: 'doomed',
        pendingCourseDeletions: [
          { courseId: 'doomed', courseName: 'Basement', sessionIds: ['s1'] },
        ],
      },
    })

    await resumePendingDeletionsFromStorage(fixture.target)

    expect(fixture.settings()).toEqual({ speechEnabled: true })
  })
})
