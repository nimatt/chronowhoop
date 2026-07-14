// Backup-nudge decision (plan 07 item 3, logic half; docs/specs/storage.md):
// after a stopped session the UI asks this pure predicate whether to gently
// prompt for an export. Definition (07 notes): nudge when unexported data
// exists — at least one session started after lastExportAt (any session at
// all when nothing was ever exported) — AND the last export is not recent
// (none ever, or older than 7 days).

import type { IsoDateString } from '../domain/types'
import type { SessionSummary } from './storage'

export const RECENT_EXPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface UnexportedSessionsInput {
  sessionSummaries: ReadonlyArray<Pick<SessionSummary, 'startedAt'>>
  // settings.lastExportAt; absent until the first export.
  lastExportAt?: IsoDateString
}

export interface BackupNudgeInput extends UnexportedSessionsInput {
  // Injected clock: the current time as epoch milliseconds (Date.now()).
  now: number
}

// The single definition of "unexported", deliberately without a recency
// clause (plan 09 item 5). The delete-confirmation screen warns "not backed
// up" over the doomed sessions, and reusing shouldNudgeBackup there would
// stay silent for the pilot who exported on Monday, flew ten sessions on
// Saturday and deletes on Sunday — exactly the person the warning exists for.
// The nudge wants "unexported AND stale"; the delete warning wants
// "unexported", full stop.
export function hasUnexportedSessions({
  sessionSummaries,
  lastExportAt,
}: UnexportedSessionsInput): boolean {
  if (lastExportAt === undefined) return sessionSummaries.length > 0
  const exportedAt = Date.parse(lastExportAt)
  return sessionSummaries.some((session) => Date.parse(session.startedAt) > exportedAt)
}

export function shouldNudgeBackup({ sessionSummaries, lastExportAt, now }: BackupNudgeInput): boolean {
  if (!hasUnexportedSessions({ sessionSummaries, lastExportAt })) return false
  if (lastExportAt === undefined) return true
  return now - Date.parse(lastExportAt) > RECENT_EXPORT_MAX_AGE_MS
}
