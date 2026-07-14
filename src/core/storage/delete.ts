// Shared course-deletion cascade (plan 09 item 3, docs/specs/storage.md): both
// Storage implementations delegate here, so the ordering invariant below is
// literally the same code in both and cannot drift — the same reason
// importIntoStorage (import.ts) exists.
//
// ADR 0010 gives per-file atomicity only: there is no multi-file transaction,
// so the only thing left to choose is WHICH crash state a cascade can leave
// behind. The two-phase intent marker makes that state self-describing and
// self-healing — see deleteCourseFromStorage.

import type { AppSettings, PendingCourseDeletion } from './schema'
import type {
  CoursesData,
  DeleteCourseResult,
  ResumeOutcome,
  SessionSummary,
} from './storage'

// The subset of Storage a cascade needs; implementations pass themselves.
export interface DeleteTarget {
  loadCourses(): Promise<CoursesData>
  listSessions(): Promise<SessionSummary[]>
  saveCourses(data: CoursesData): Promise<void>
  deleteSession(id: string): Promise<void>

  // THE COURSE HALF OF THE RESURRECTION GUARD (ADR 0011 decision 5), driven
  // from the cascade rather than from Storage.deleteCourse — because BOTH
  // entry points end in the same COMMIT, and a guard bolted to only one of
  // them is absent exactly where it is hardest to notice.
  //
  // The three calls are deliberately distinct, and the distinction is the
  // whole safety property: CONDEMNING ONLY REFUSES; ONLY A COMMITTED DELETION
  // MAY DESTROY.
  //
  // condemnCourse — a deletion of this course is IN FLIGHT and may still fail
  //   or be abandoned. No NEW session of it may be created (saveSession
  //   rejects 'not-found'), and that is ALL it may do: an in-flight deletion
  //   has destroyed nothing yet, so nothing may be destroyed on its behalf.
  // releaseCourse — the deletion did not commit (the cascade failed, or the
  //   resume abandoned it). The course is standing and must be flyable again:
  //   leaving it condemned would make every session flown on it reject
  //   'not-found' for the rest of the tab's life, and the persister — which
  //   retries 'write-failed' and nothing else — would silently stop saving
  //   laps.
  // commitCourseDeletion — the COMMIT write landed. The course is now
  //   DEFINITIVELY GONE, which is the first moment at which a session file of
  //   it may be destroyed rather than merely refused: from here on, a write
  //   that was already in flight and lands anyway has its file removed, since
  //   a readable session file whose course is gone is the one state this whole
  //   phase exists to forbid. Never released — the course does not come back
  //   (except through importAll, which re-admits the ids it restores).
  condemnCourse(id: string): void
  releaseCourse(id: string): void
  commitCourseDeletion(id: string): void
}

// courses.json transforms. Total, pure, immutable: never mutate the input —
// callers hold the snapshot they read and a mutation here would corrupt it.

function withSettings(data: CoursesData, pending: PendingCourseDeletion[]): CoursesData {
  const settings = { ...data.settings }
  // Absent, not empty, when nothing is pending (schema.ts): a leftover [] would
  // be a marker file that says "a deletion is in flight" for the rest of time.
  if (pending.length > 0) settings.pendingCourseDeletions = pending
  else delete settings.pendingCourseDeletions
  return { courses: [...data.courses], settings }
}

function pendingDeletions(data: CoursesData): PendingCourseDeletion[] {
  return data.settings.pendingCourseDeletions ?? []
}

// Records the marker, replacing any earlier marker for the same course rather
// than appending a second one. An earlier marker's ids are either already
// deleted (which is why they are not in the fresh listSessions() the new one
// was built from) or still live and therefore in the new list too — so nothing
// is lost, and one course keeps one work list and produces one resume notice.
export function withPendingDeletion(
  data: CoursesData,
  pending: PendingCourseDeletion,
): CoursesData {
  const others = pendingDeletions(data).filter((entry) => entry.courseId !== pending.courseId)
  return withSettings(data, [...others, pending])
}

// Abandons the marker (resume's flown-since path): the work list goes, the
// course and its sessions stay.
export function withoutPendingDeletion(data: CoursesData, courseId: string): CoursesData {
  return withoutPendingDeletions(data, [courseId])
}

export function withoutPendingDeletions(
  data: CoursesData,
  courseIds: readonly string[],
): CoursesData {
  const abandoned = new Set(courseIds)
  return withSettings(
    data,
    pendingDeletions(data).filter((entry) => !abandoned.has(entry.courseId)),
  )
}

// The markers an IMPORT must abandon (returned as course ids, the key a marker
// is identified by).
//
// An import is a statement that this data should exist — and it is the only
// undo this product has: the delete screen tells the user to export a backup,
// and the restore path after a cascade that failed half-way is to re-import
// that file. A marker naming a course (or a session) the envelope carries
// would survive that restore untouched, and the NEXT LAUNCH would replay the
// interrupted cascade over the data the user just put back: the marker's
// recorded ids are exactly what the import restored, so not one stray exists
// and the flown-since rule does not fire. Course and sessions destroyed a
// second time, silently.
//
// Abandoning is the safe default: it costs the user a re-confirmation of a
// deletion they can still perform (against a blast radius restated from live
// data), where completing it costs them the data they explicitly restored.
export function pendingDeletionsTouchedBy(
  data: CoursesData,
  courseIds: ReadonlySet<string>,
  sessionIds: ReadonlySet<string>,
): string[] {
  return pendingDeletions(data)
    .filter(
      (entry) =>
        courseIds.has(entry.courseId) || entry.sessionIds.some((id) => sessionIds.has(id)),
    )
    .map((entry) => entry.courseId)
}

// Markers are INSTANCE-AND-DISK state, not user data: a marker says "a
// destruction of this course is in flight in this store". An export file is a
// snapshot of the user's data, human-inspectable by design, and must not
// advertise an in-flight destruction of a course it also carries — nor hand
// that instruction to whatever store the file is imported into.
export function settingsForExport(settings: AppSettings): AppSettings {
  const exported = { ...settings }
  delete exported.pendingCourseDeletions
  return exported
}

// THE COMMIT. It does all three things at once — drops the course, drops its
// marker, and clears lastCourseId when it pointed here — precisely so the
// commit is ONE write: a cascade has exactly one point at which it becomes
// true, and no crash can land between "course gone" and "marker gone".
export function withoutCourse(data: CoursesData, courseId: string): CoursesData {
  const next = withoutPendingDeletion(data, courseId)
  if (next.settings.lastCourseId === courseId) delete next.settings.lastCourseId
  return { courses: next.courses.filter((course) => course.id !== courseId), settings: next.settings }
}

// Deletes the course AND every session whose courseId matches (cascade, not
// orphaning). THE ORDERING IS THE CONTRACT:
//
//   0. loadCourses() and listSessions() — read-before-destroy, and BEFORE the
//      condemn. Nothing is touched, and nothing is refused, until both reads
//      succeed: loadCourses can reject 'unsupported-version', and discovering
//      that after the session files were gone would strand condemned data in a
//      state no retry can finish (sessions destroyed, course still standing,
//      no marker to say so).
//   1. condemn the course — refuse-only — then write courses.json with the
//      course STILL PRESENT and the marker appended: the exact session ids,
//      captured now                                                [INTENT]
//   2. remove those session files
//   3. re-read courses.json, write it back without the course, without the
//      marker, and with lastCourseId cleared if it pointed here    [COMMIT]
//   4. only now that the course is definitively gone: arm the destructive half
//      of the guard and sweep any session file of it that landed anyway
//                                                                  [SWEEP]
//
// Idempotent: an unknown course id still sweeps sessions referencing it — that
// is the retry path after a cascade that died mid-flight.
//
// The doomed set comes from listSessions(), because SessionSummary already
// carries courseId. Honest caveat: listSessions() IS a readDocument scan on
// OPFS and DOES quarantine corrupt files as a side effect. That is unavoidable
// (it is the only thing that knows which course a session belongs to) and it
// triggers no scan the app would not otherwise do — but it is not free.
//
// A session file that cannot be READ is invisible to listSessions(), so it
// cannot be attributed to a course and SURVIVES the cascade as an orphan. That
// is documented, not fixed: its courseId lives in bytes we could not parse, so
// there is no honest way to condemn it.
export async function deleteCourseFromStorage(
  target: DeleteTarget,
  courseId: string,
): Promise<DeleteCourseResult> {
  // READ BEFORE CONDEMNING. Condemning refuses every new session of the course,
  // and these two reads are a full body scan taking real time — condemning
  // first would make a flight armed while they run fail to land at all, for a
  // deletion that may yet fail at its very first write.
  const existing = await target.loadCourses()
  const doomed = await sessionIdsOfCourse(target, courseId)
  const course = existing.courses.find((candidate) => candidate.id === courseId)

  const pending: PendingCourseDeletion = {
    courseId,
    // The course is already gone on an idempotent re-delete, and the marker
    // still has to be able to name something in the resume notice.
    courseName: course?.name ?? 'Unknown course',
    sessionIds: doomed,
  }

  target.condemnCourse(courseId)
  try {
    await target.saveCourses(withPendingDeletion(existing, pending)) // 1. INTENT
    for (const id of doomed) {
      await target.deleteSession(id) // 2.
    }
    // 3. COMMIT — RE-READ, never the pre-INTENT snapshot. Building the commit
    // write from `existing` would resurrect anything written since (that is
    // exactly the stale-snapshot hole importIntoStorage still has), and with
    // two markers pending each commit would revert the other one's.
    await target.saveCourses(withoutCourse(await target.loadCourses(), courseId))
  } catch (error) {
    // The COMMIT never landed, so the course is still standing and the pilot
    // can go on flying it — it must not stay condemned. Nothing beyond the ids
    // this cascade explicitly deleteSession'd has been destroyed, and that is
    // an invariant, not an accident: the destructive half of the guard is not
    // armed until commitCourseDeletion below.
    target.releaseCourse(courseId)
    throw error
  }

  return { sessionsDeleted: doomed.length + (await sweepAfterCommit(target, courseId)) }
}

function sessionIdsOfCourse(target: DeleteTarget, courseId: string): Promise<string[]> {
  return target
    .listSessions()
    .then((summaries) =>
      summaries.filter((summary) => summary.courseId === courseId).map((summary) => summary.id),
    )
}

// THE POST-COMMIT SWEEP — and note WHERE it is: after the COMMIT, never before.
//
// The forbidden state is a READABLE SESSION FILE WHOSE COURSE IS GONE, and the
// refuse-only guard cannot rule it out on its own: a saveSession that passed
// its pre-check a moment before condemnCourse can still be inside its write
// when the cascade runs, and land afterwards. Its session id is in no snapshot
// (it may never have been on disk at all), so no id-keyed compensation can name
// it.
//
// Destroying such a file is only defensible once the deletion has COMMITTED.
// Before that, the course may yet be standing — a quota failure on the INTENT
// write ends the cascade with nothing deleted — and destroying a live session's
// file on behalf of a deletion that never happened is a strictly worse bug than
// the ghost it prevents. So: commit first, and only then destroy what the
// commit orphaned.
//
// Ordering inside here matters too. commitCourseDeletion arms the implementation
// side of the compensation BEFORE the scan, so the two halves overlap with no
// gap: a write that lands before the scan is found by the scan; a write whose
// post-write check runs after the commit is removed by the implementation.
async function sweepAfterCommit(target: DeleteTarget, courseId: string): Promise<number> {
  target.commitCourseDeletion(courseId)
  const orphans = await sessionIdsOfCourse(target, courseId)
  for (const id of orphans) {
    await target.deleteSession(id)
  }
  return orphans.length
}

function outcomeNames(pending: PendingCourseDeletion): { courseId: string; courseName: string } {
  return { courseId: pending.courseId, courseName: pending.courseName }
}

// Finishes — or ABANDONS — every cascade interrupted between its INTENT and
// COMMIT writes, replaying ONLY the session ids the marker recorded.
//
// Never rejects. This runs at startup, where there is no one to retry it: a
// failed entry keeps its marker and is left for the next launch, and the other
// entries still get their turn. The invariant lives here rather than in the two
// implementations so it cannot hold in one and not the other.
export async function resumePendingDeletionsFromStorage(
  target: DeleteTarget,
): Promise<ResumeOutcome[]> {
  let markers: PendingCourseDeletion[]
  try {
    markers = pendingDeletions(await target.loadCourses())
  } catch {
    return []
  }

  const outcomes: ResumeOutcome[] = []
  for (const pending of markers) {
    try {
      outcomes.push(...(await resumeOne(target, pending)))
    } catch {
      // A failure BEFORE the COMMIT leaves the marker untouched — the next
      // launch tries again. After it, only the post-commit sweep can still
      // fail; the deletion itself has landed, so there is nothing to replay,
      // and the only cost is a missing notice.
    }
  }
  return outcomes
}

// FLOWN SINCE. Sessions exist on the course that the confirmation screen never
// counted, so the deletion is ABANDONED: the marker goes, the course and every
// session stay. This is the safety property that makes the marker sound —
// without it the marker would be an unbounded standing instruction ("delete
// course X, whenever") rather than a bounded work list, and walking away from a
// failed delete for a month would cost a month of flying.
async function abandon(
  target: DeleteTarget,
  pending: PendingCourseDeletion,
): Promise<ResumeOutcome[]> {
  await target.saveCourses(withoutPendingDeletion(await target.loadCourses(), pending.courseId))
  return [{ kind: 'abandoned', ...outcomeNames(pending), reason: 'flown-since' }]
}

function strayIdsOfCourse(
  target: DeleteTarget,
  pending: PendingCourseDeletion,
): Promise<string[]> {
  const recorded = new Set(pending.sessionIds)
  return sessionIdsOfCourse(target, pending.courseId).then((ids) =>
    ids.filter((id) => !recorded.has(id)),
  )
}

async function resumeOne(
  target: DeleteTarget,
  pending: PendingCourseDeletion,
): Promise<ResumeOutcome[]> {
  // THE STRAY CHECK RUNS BEFORE THE CONDEMN, and that ordering IS the safety
  // property. This runs unawaited at startup while the course is still LISTED
  // (the INTENT write keeps it present on purpose, so the fly screen still
  // offers it) and the scan below is a full body scan taking real time — a
  // pilot can tap that course and arm a flight inside this window. Condemn
  // first and that arm's saveSession is REFUSED: the session never lands, so
  // the scan finds no stray, so the flown-since rule does not fire, so the
  // resume completes and deletes the course the pilot is flying, with none of
  // that flight's laps saved. The session MUST be able to land and become a
  // stray. That is what the rule is for.
  if ((await strayIdsOfCourse(target, pending)).length > 0) return abandon(target, pending)

  target.condemnCourse(pending.courseId)
  try {
    // RE-CHECK, now that no new session of this course can be created. The scan
    // above reads a snapshot: a session file created while it ran is invisible
    // to its result (OPFS collects the directory's names first and reads the
    // bodies afterwards) but is very much on disk. That session must still be
    // able to abandon this deletion rather than be swept away by it — and now
    // that the course is condemned, this second scan is the last word.
    if ((await strayIdsOfCourse(target, pending)).length > 0) {
      // The course lives: un-condemn it first, so the flight that just made
      // this a stray can save its very next lap.
      target.releaseCourse(pending.courseId)
      return await abandon(target, pending)
    }

    // Exactly the recorded ids — never a set re-derived from live data.
    for (const id of pending.sessionIds) {
      await target.deleteSession(id)
    }
    // Each entry re-reads before its own commit write, so one entry's commit
    // cannot revert another's.
    await target.saveCourses(withoutCourse(await target.loadCourses(), pending.courseId))
  } catch (error) {
    // The marker survives for the next launch and the course is still standing:
    // releasing it is what keeps the pilot able to fly it in the meantime.
    target.releaseCourse(pending.courseId)
    throw error
  }

  const swept = await sweepAfterCommit(target, pending.courseId)
  return [
    {
      kind: 'completed',
      ...outcomeNames(pending),
      sessionsDeleted: pending.sessionIds.length + swept,
    },
  ]
}
