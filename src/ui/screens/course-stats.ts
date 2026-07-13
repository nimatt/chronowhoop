// Per-course card stats for Home (mockup 01): session count, last-flown
// date, and ALL-TIME records. Records need lap bodies, so this is a full
// scan of every listed session — the v1 posture storage.md documents (no
// session index; data volumes are tiny). Unreadable (e.g. quarantined)
// sessions are skipped silently here; the course view reports them.

import type { IsoDateString, Session } from '../../core/domain/types'
import { courseRecords, type Records } from '../../core/records/records'
import type { SessionSummary } from '../../core/storage/storage'

export interface CourseStats {
  sessionCount: number
  lastFlownAt: IsoDateString | undefined
  records: Records
}

export async function computeCourseStats(
  summaries: readonly SessionSummary[],
  loadSession: (id: string) => Promise<Session | undefined>,
): Promise<ReadonlyMap<string, CourseStats>> {
  const grouped = new Map<
    string,
    { sessionCount: number; lastFlownAt: IsoDateString | undefined; sessions: Session[] }
  >()
  for (const summary of summaries) {
    const entry = grouped.get(summary.courseId) ?? {
      sessionCount: 0,
      lastFlownAt: undefined,
      sessions: [],
    }
    entry.sessionCount += 1
    // Summaries are newest first (the listSessions contract), so the first
    // one seen per course is the last flight.
    entry.lastFlownAt ??= summary.startedAt
    const session = await loadSession(summary.id)
    if (session !== undefined) entry.sessions.push(session)
    grouped.set(summary.courseId, entry)
  }
  return new Map(
    [...grouped].map(([courseId, entry]) => [
      courseId,
      {
        sessionCount: entry.sessionCount,
        lastFlownAt: entry.lastFlownAt,
        records: courseRecords(entry.sessions),
      },
    ]),
  )
}
