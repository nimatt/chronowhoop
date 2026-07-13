import { describe, expect, it } from 'vitest'
import { summarizeSession } from '../../core/storage/storage'
import { makeLap, makeSession } from '../../core/storage/storage-contract'
import { computeCourseStats } from './course-stats'

describe('computeCourseStats', () => {
  const older = makeSession({
    id: 's-old',
    courseId: 'c-1',
    startedAt: '2026-07-08T19:40:00.000Z',
    laps: [makeLap({ n: 1, durationMs: 15000 }), makeLap({ n: 2, durationMs: 14000 })],
  })
  const newer = makeSession({
    id: 's-new',
    courseId: 'c-1',
    startedAt: '2026-07-11T20:12:00.000Z',
    laps: [
      makeLap({ n: 1, durationMs: 13900 }),
      makeLap({ n: 2, durationMs: 12840 }),
      makeLap({ n: 3, durationMs: 14070 }),
    ],
  })
  const otherCourse = makeSession({
    id: 's-other',
    courseId: 'c-2',
    startedAt: '2026-07-06T18:00:00.000Z',
    laps: [makeLap({ n: 1, durationMs: 16000 })],
  })

  const loaderFor = (sessions: (typeof older)[]) => (id: string) =>
    Promise.resolve(sessions.find((session) => session.id === id))

  it('groups counts, last-flown, and all-time records per course', async () => {
    // Newest first, the listSessions contract.
    const summaries = [newer, older, otherCourse].map(summarizeSession)
    const stats = await computeCourseStats(summaries, loaderFor([older, newer, otherCourse]))

    const c1 = stats.get('c-1')
    expect(c1?.sessionCount).toBe(2)
    expect(c1?.lastFlownAt).toBe('2026-07-11T20:12:00.000Z')
    expect(c1?.records.bestLap?.durationMs).toBe(12840)
    expect(c1?.records.bestThreeConsecutive?.totalMs).toBe(13900 + 12840 + 14070)

    const c2 = stats.get('c-2')
    expect(c2?.sessionCount).toBe(1)
    expect(c2?.records.bestLap?.durationMs).toBe(16000)
    expect(c2?.records.bestThreeConsecutive).toBeUndefined()
  })

  it('skips unreadable sessions from the records but keeps them counted', async () => {
    const summaries = [newer, older].map(summarizeSession)
    const stats = await computeCourseStats(summaries, loaderFor([older]))

    const c1 = stats.get('c-1')
    expect(c1?.sessionCount).toBe(2)
    expect(c1?.lastFlownAt).toBe('2026-07-11T20:12:00.000Z')
    expect(c1?.records.bestLap?.durationMs).toBe(14000)
  })

  it('returns an empty map for no sessions', async () => {
    const stats = await computeCourseStats([], loaderFor([]))
    expect(stats.size).toBe(0)
  })
})
