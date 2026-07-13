// Backup-nudge decision (plan 07 item 3, logic half; docs/specs/storage.md):
// after a stopped session the UI asks this pure predicate whether to gently
// prompt for an export. Definition (07 notes): nudge when unexported data
// exists — at least one session started after lastExportAt (any session at
// all when nothing was ever exported) — AND the last export is not recent
// (none ever, or older than 7 days).

import type { IsoDateString } from '../domain/types'
import type { SessionSummary } from './storage'

export const RECENT_EXPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface BackupNudgeInput {
  sessionSummaries: ReadonlyArray<Pick<SessionSummary, 'startedAt'>>
  // settings.lastExportAt; absent until the first export.
  lastExportAt?: IsoDateString
  // Injected clock: the current time as epoch milliseconds (Date.now()).
  now: number
}

export function shouldNudgeBackup({ sessionSummaries, lastExportAt, now }: BackupNudgeInput): boolean {
  if (lastExportAt === undefined) return sessionSummaries.length > 0
  const exportedAt = Date.parse(lastExportAt)
  const hasUnexportedSession = sessionSummaries.some(
    (session) => Date.parse(session.startedAt) > exportedAt,
  )
  return hasUnexportedSession && now - exportedAt > RECENT_EXPORT_MAX_AGE_MS
}
