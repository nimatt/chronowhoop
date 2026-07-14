// The delete-confirmation copy (plan 09 item 9), pure so every branch — the
// zero/one/many boundaries and the counts-we-could-not-get case — is unit
// tested rather than eyeballed on a screen. The screens pass plain data; this
// module never touches a repo.
//
// The one rule the whole file exists to enforce: state the blast radius
// honestly, and never state a number we do not have.

import {
  hasUnexportedSessions,
  type UnexportedSessionsInput,
} from '../../core/storage/backup-nudge'
import type { IsoDateString } from '../../core/domain/types'
import { formatDateTime, formatLapSeconds } from '../fly/fly-format'
import { exportOutcomeNotice, type ExportNotice, type ExportOutcome } from '../shared/export-action'
import { plural } from './course-format'

const UNDOABLE = 'It cannot be undone.'

export interface CourseBlastRadius {
  sessionCount: number
  // EVERY lap in those sessions — valid AND discarded. A discarded lap keeps
  // every byte: it stays in the session file and rides in the export
  // (docs/specs/product.md, "discard ≠ delete"), so the cascade destroys it
  // like any other. Counting only valid laps here would undersell what the
  // user is about to lose.
  lapCount: number
}

// null = the sessions repo has not answered (still loading, or lastError).
// Copy built from `null` says "every session and lap" and never "0 sessions":
// a count we could not obtain is not a count of zero, and the difference is a
// destroyed course the user thought was empty (plan 09 item 8's load gate).
export type CourseBlastRadiusOrUnknown = CourseBlastRadius | null

export function deleteCourseTitle(courseName: string): string {
  return `Delete "${courseName}"?`
}

export function deleteCourseBody(blastRadius: CourseBlastRadiusOrUnknown): string {
  if (blastRadius === null) {
    return `This also deletes every session and lap flown on this course. ${UNDOABLE}`
  }
  if (blastRadius.sessionCount === 0) {
    return `Nothing has been flown on this course yet. ${UNDOABLE}`
  }
  const sessions = plural(blastRadius.sessionCount, 'session')
  const laps = plural(blastRadius.lapCount, 'lap')
  return `This also deletes ${sessions} and ${laps} flown on this course. ${UNDOABLE}`
}

// "Delete course and 12 sessions" — the button says what it takes with it.
// With no sessions, or none we can vouch for, it promises only the course.
export function deleteCourseConfirmLabel(blastRadius: CourseBlastRadiusOrUnknown): string {
  if (blastRadius === null || blastRadius.sessionCount === 0) return 'Delete course'
  return `Delete course and ${plural(blastRadius.sessionCount, 'session')}`
}

// A cascade that threw leaves a partial state, and the confirmation screen
// already promised a total — so the failure has to be able to contradict it.
//
// `reason` is the store's own words (CoursesRepo.lastError.message). Without
// them, a quota-exceeded cascade reads as "Try again" with no hint that
// retrying is futile.
//
// THE RESUME SENTENCE. "The course is still here" reads as "nothing more will
// happen unless you act" — and that is false: the cascade wrote its intent
// marker before it removed a single file, so the next launch finishes the
// deletion at startup, before the user can export anything (the `flown-since`
// abandonment only saves someone who flies the course again, not someone who
// simply walks away). Any session actually deleted PROVES the marker landed —
// the cascade removes nothing before writing it — so that is exactly when the
// sentence is true, and it is claimed nowhere else.
//
// `sessionsDeleted: null` = the store could not be re-read after the failed
// cascade (SessionsRepo.refresh() keeps its STALE list on failure, so its
// survivor count is worthless), and the same rule as CourseBlastRadiusOrUnknown
// applies: a count we could not obtain is NOT a count of zero. Passing 0 there
// would drop the resume sentence exactly when a sick store makes the marker
// most likely to be on disk — so the unknown branch takes the safe side and
// says the deletion may resume, without claiming a number it does not have.
export function deleteCourseFailureNotice({
  sessionsDeleted,
  sessionsDoomed,
  reason,
}: {
  sessionsDeleted: number | null
  sessionsDoomed: number
  reason?: string
}): string {
  const doomed = plural(sessionsDoomed, 'session')
  const because = reason === undefined ? '' : ` The store said: ${reason}.`
  if (sessionsDeleted === null) {
    return (
      `The course is still here, but we could not check how far the delete got — up to ${doomed} may already be gone. Try again.${because}` +
      ' If you leave it, the deletion may finish itself the next time the app opens.'
    )
  }
  const resume =
    sessionsDeleted > 0
      ? ' If you leave it, the deletion finishes itself the next time the app opens.'
      : ''
  return `Deleted ${String(sessionsDeleted)} of ${doomed} — the course is still here. Try again.${because}${resume}`
}

export const DELETE_SESSION_TITLE = 'Delete this session?'
export const DELETE_SESSION_CONFIRM_LABEL = 'Delete session'

export interface SessionBlastRadius {
  startedAt: IsoDateString
  // All laps, valid and discarded — same honesty rule as CourseBlastRadius.
  lapCount: number
  // The session's best VALID lap; absent when it has none (every lap
  // discarded, or no laps at all), in which case the clause is dropped rather
  // than filled with an em dash.
  bestLapMs?: number
}

export function deleteSessionBody({ startedAt, lapCount, bestLapMs }: SessionBlastRadius): string {
  const laps = plural(lapCount, 'lap')
  const best = bestLapMs === undefined ? '' : `, best ${formatLapSeconds(bestLapMs)} s`
  return `${formatDateTime(startedAt)} — ${laps}${best}. ${UNDOABLE}`
}

// Evaluated over the DOOMED sessions only — "is what I am about to destroy in
// a file somewhere?", not "is the app backed up?". Hence hasUnexportedSessions
// and not shouldNudgeBackup: the nudge's 7-day recency clause would stay
// silent for the pilot who exported on Monday, flew on Saturday and deletes on
// Sunday — exactly the person this warning exists for (plan 09 item 5).
//
// null when every doomed session predates the last export: nothing to warn
// about, so no warning at all.
export function deleteBackupWarning({
  sessionSummaries,
  lastExportAt,
}: UnexportedSessionsInput): string | null {
  if (!hasUnexportedSessions({ sessionSummaries, lastExportAt })) return null
  const cause =
    lastExportAt === undefined
      ? 'you have never exported'
      : 'some of this was flown after your last export'
  return `Not backed up — ${cause}. An export file is the only way to get this back.`
}

// courses.json has not answered, so lastExportAt is unknowable. Never suppress
// the backup warning on the strength of a repo that has not answered (plan 09
// item 8's rule, which is not only about counts) — but name NO cause at all,
// not even the failure. This covers two states, and only one of them is an
// error: the ordinary "still loading" window (ensureLoaded races the session
// read, and the body renders the moment the session resolves) and a genuine
// failed read. Saying "could not be read" in the first would assert a failure
// that has not happened; in the second it would print the cause twice, since
// the screen's own `notice-error` already carries the store's words. Both
// warnings are about the same missing fact — is this in an export file? — so
// state exactly that and let the error notice speak about the error.
export const DELETE_BACKUP_UNKNOWN_WARNING =
  'Backup state unknown — we cannot confirm this session is in an export file. An export file is the only way to get this back.'

// The notice after "Export backup first" on a delete screen. Deliberately
// weaker than "saved": the anchor download path cannot observe a cancelled
// save dialog (export-action.ts), so 'delivered' means "we handed the file
// over", not "a file exists on disk". Standing between the user and a
// permanent delete, that gap has to be said out loud — hence "Check it saved"
// rather than a checkmark. Failure and cancellation reuse the shared copy.
export function deleteExportNotice(
  outcome: ExportOutcome,
  subject: 'course' | 'session',
): ExportNotice | null {
  if (outcome.kind !== 'delivered') return exportOutcomeNotice(outcome)
  return {
    ok: true,
    text: `Exported ${outcome.filename}. Check it saved — importing that file restores this ${subject}.`,
  }
}
