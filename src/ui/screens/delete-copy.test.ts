import { describe, expect, it } from 'vitest'
import {
  DELETE_BACKUP_UNKNOWN_WARNING,
  deleteBackupWarning,
  deleteCourseBody,
  deleteCourseConfirmLabel,
  deleteCourseFailureNotice,
  deleteCourseTitle,
  deleteExportNotice,
  deleteSessionBody,
} from './delete-copy'

// Local wall-clock in, local wall-clock out — the same construction the
// fly-format tests use, so the expectation holds in any TZ.
const isoAt = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute).toISOString()

describe('deleteCourseTitle', () => {
  it('quotes the course name', () => {
    expect(deleteCourseTitle('Basement 3-gate')).toBe('Delete "Basement 3-gate"?')
  })
})

describe('deleteCourseBody', () => {
  it('states the full blast radius', () => {
    expect(deleteCourseBody({ sessionCount: 12, lapCount: 340 })).toBe(
      'This also deletes 12 sessions and 340 laps flown on this course. It cannot be undone.',
    )
  })

  it('says session and lap in the singular', () => {
    expect(deleteCourseBody({ sessionCount: 1, lapCount: 28 })).toBe(
      'This also deletes 1 session and 28 laps flown on this course. It cannot be undone.',
    )
    expect(deleteCourseBody({ sessionCount: 1, lapCount: 1 })).toBe(
      'This also deletes 1 session and 1 lap flown on this course. It cannot be undone.',
    )
  })

  it('says nothing has been flown when the course is empty', () => {
    expect(deleteCourseBody({ sessionCount: 0, lapCount: 0 })).toBe(
      'Nothing has been flown on this course yet. It cannot be undone.',
    )
  })

  // The bug this branch exists to prevent: an unloaded/failed sessions repo
  // has an empty summary list, and rendering "Nothing has been flown" from it
  // would destroy twelve sessions the user was told did not exist.
  it('never claims zero when the counts could not be obtained', () => {
    expect(deleteCourseBody(null)).toBe(
      'This also deletes every session and lap flown on this course. It cannot be undone.',
    )
  })
})

describe('deleteCourseConfirmLabel', () => {
  it('names the sessions it takes with the course', () => {
    expect(deleteCourseConfirmLabel({ sessionCount: 12, lapCount: 340 })).toBe(
      'Delete course and 12 sessions',
    )
    expect(deleteCourseConfirmLabel({ sessionCount: 1, lapCount: 28 })).toBe(
      'Delete course and 1 session',
    )
  })

  it('promises only the course with no sessions, or none it can vouch for', () => {
    expect(deleteCourseConfirmLabel({ sessionCount: 0, lapCount: 0 })).toBe('Delete course')
    expect(deleteCourseConfirmLabel(null)).toBe('Delete course')
  })
})

describe('deleteCourseFailureNotice', () => {
  // Progress made proves the intent marker landed (the cascade removes nothing
  // before writing it), so the deletion WILL complete itself on the next launch
  // — say so, or "the course is still here" reads as "you are safe", and the
  // user who shrugs and closes the app loses it anyway, unexported.
  it('contradicts the total the confirmation promised, and warns that the deletion resumes', () => {
    expect(deleteCourseFailureNotice({ sessionsDeleted: 7, sessionsDoomed: 12 })).toBe(
      'Deleted 7 of 12 sessions — the course is still here. Try again.' +
        ' If you leave it, the deletion finishes itself the next time the app opens.',
    )
  })

  // Nothing deleted: the marker may never have been written (the INTENT write is
  // itself a thing that can fail), so the resume is not promised.
  it('pluralises the doomed count, reports no progress honestly, and claims no resume', () => {
    expect(deleteCourseFailureNotice({ sessionsDeleted: 0, sessionsDoomed: 1 })).toBe(
      'Deleted 0 of 1 session — the course is still here. Try again.',
    )
  })

  it("carries the store's own words, so a futile retry can be recognised", () => {
    expect(
      deleteCourseFailureNotice({
        sessionsDeleted: 0,
        sessionsDoomed: 12,
        reason: 'quota exceeded',
      }),
    ).toBe(
      'Deleted 0 of 12 sessions — the course is still here. Try again.' +
        ' The store said: quota exceeded.',
    )
    expect(
      deleteCourseFailureNotice({ sessionsDeleted: 7, sessionsDoomed: 12, reason: 'disk went away' }),
    ).toBe(
      'Deleted 7 of 12 sessions — the course is still here. Try again.' +
        ' The store said: disk went away.' +
        ' If you leave it, the deletion finishes itself the next time the app opens.',
    )
  })

  // The survivors were counted by a refresh that FAILED (SessionsRepo keeps its
  // stale list), so "0 deleted" would be a fabricated count — and the one it
  // fabricates is the one that suppresses the resume sentence, on the sickest
  // store, where the marker is most likely already on disk. Unknown takes the
  // safe side: no number claimed, resume stated.
  it('claims no count, and still warns of the resume, when the progress is unknown', () => {
    expect(deleteCourseFailureNotice({ sessionsDeleted: null, sessionsDoomed: 12 })).toBe(
      'The course is still here, but we could not check how far the delete got' +
        ' — up to 12 sessions may already be gone. Try again.' +
        ' If you leave it, the deletion may finish itself the next time the app opens.',
    )
    expect(
      deleteCourseFailureNotice({
        sessionsDeleted: null,
        sessionsDoomed: 1,
        reason: 'disk went away',
      }),
    ).toBe(
      'The course is still here, but we could not check how far the delete got' +
        ' — up to 1 session may already be gone. Try again.' +
        ' The store said: disk went away.' +
        ' If you leave it, the deletion may finish itself the next time the app opens.',
    )
  })

  it('never reads an unknown progress as a progress of zero', () => {
    expect(deleteCourseFailureNotice({ sessionsDeleted: null, sessionsDoomed: 12 })).not.toContain(
      'Deleted 0',
    )
  })
})

describe('deleteSessionBody', () => {
  it('states when it was flown, how many laps, and the best one', () => {
    expect(
      deleteSessionBody({ startedAt: isoAt(2026, 7, 12, 14, 30), lapCount: 28, bestLapMs: 14320 }),
    ).toBe('2026-07-12 14:30 — 28 laps, best 14.32 s. It cannot be undone.')
  })

  it('drops the best clause when the session has no valid lap', () => {
    expect(deleteSessionBody({ startedAt: isoAt(2026, 7, 12, 14, 30), lapCount: 3 })).toBe(
      '2026-07-12 14:30 — 3 laps. It cannot be undone.',
    )
    expect(deleteSessionBody({ startedAt: isoAt(2026, 7, 12, 14, 30), lapCount: 0 })).toBe(
      '2026-07-12 14:30 — 0 laps. It cannot be undone.',
    )
  })

  it('says lap in the singular', () => {
    expect(
      deleteSessionBody({ startedAt: isoAt(2026, 7, 12, 14, 30), lapCount: 1, bestLapMs: 9500 }),
    ).toBe('2026-07-12 14:30 — 1 lap, best 9.50 s. It cannot be undone.')
  })
})

describe('deleteBackupWarning', () => {
  const doomed = (...startedAt: string[]) => startedAt.map((iso) => ({ startedAt: iso }))

  it('warns hardest when nothing was ever exported', () => {
    expect(deleteBackupWarning({ sessionSummaries: doomed('2026-07-12T10:00:00.000Z') })).toBe(
      'Not backed up — you have never exported. An export file is the only way to get this back.',
    )
  })

  // Exported Monday, flew Saturday, deletes Sunday: shouldNudgeBackup's 7-day
  // recency clause would say nothing here. This must not.
  it('warns when part of the doomed set was flown after the last export', () => {
    expect(
      deleteBackupWarning({
        sessionSummaries: doomed('2026-07-06T18:00:00.000Z', '2026-07-11T18:00:00.000Z'),
        lastExportAt: '2026-07-07T09:00:00.000Z',
      }),
    ).toBe(
      'Not backed up — some of this was flown after your last export. An export file is the only way to get this back.',
    )
  })

  it('stays silent when every doomed session is in an export file', () => {
    expect(
      deleteBackupWarning({
        sessionSummaries: doomed('2026-07-06T18:00:00.000Z'),
        lastExportAt: '2026-07-07T09:00:00.000Z',
      }),
    ).toBeNull()
  })

  it('stays silent for an empty doomed set, exported or not', () => {
    expect(deleteBackupWarning({ sessionSummaries: [] })).toBeNull()
    expect(
      deleteBackupWarning({ sessionSummaries: [], lastExportAt: '2026-07-07T09:00:00.000Z' }),
    ).toBeNull()
  })

  // The screens use this whenever courses.json has not answered: warn, because a
  // repo that has not answered gets no say in suppressing a backup warning — but
  // claim neither "never exported" nor "flown since", because we cannot know.
  //
  // Nor "could not be read": `!loaded` covers the ordinary still-loading window
  // as well as a failed read, so naming the failure asserts one that may not have
  // happened — and where it HAS, the screen's error notice already prints the
  // store's words, so naming it here printed the cause twice.
  it('states the missing fact and names no cause at all', () => {
    expect(DELETE_BACKUP_UNKNOWN_WARNING).toBe(
      'Backup state unknown — we cannot confirm this session is in an export file. An export file is the only way to get this back.',
    )
    expect(DELETE_BACKUP_UNKNOWN_WARNING).not.toContain('never exported')
    expect(DELETE_BACKUP_UNKNOWN_WARNING).not.toContain('could not be read')
  })
})

describe('deleteExportNotice', () => {
  // "Delivered" is the anchor download being triggered — a cancelled save
  // dialog is invisible to us. The copy must not claim the file is on disk.
  const delivered = { kind: 'delivered', filename: 'chronowhoop-export-2026-07-12.json' } as const

  it('tells the user to check the file saved, and what it is for', () => {
    expect(deleteExportNotice(delivered, 'course')).toEqual({
      ok: true,
      text: 'Exported chronowhoop-export-2026-07-12.json. Check it saved — importing that file restores this course.',
    })
    expect(deleteExportNotice(delivered, 'session')).toEqual({
      ok: true,
      text: 'Exported chronowhoop-export-2026-07-12.json. Check it saved — importing that file restores this session.',
    })
  })

  it('reuses the shared copy for failure and cancellation', () => {
    expect(deleteExportNotice({ kind: 'failed', message: 'disk exploded' }, 'course')).toEqual({
      ok: false,
      text: 'Export failed: disk exploded',
    })
    expect(deleteExportNotice({ kind: 'cancelled' }, 'course')).toBeNull()
  })
})
