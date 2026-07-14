// The one product export flow, shared by Home's export button and the
// post-session backup nudge (plan 07 items 1+3): assemble the envelope,
// deliver it, then record settings.lastExportAt through CoursesRepo so the
// settings mirror (and the nudge predicate) updates with it.
//
// lastExportAt decisions:
// - Both deliveries count: a completed share AND a triggered anchor download.
//   The anchor path cannot observe a cancelled save dialog, so triggering the
//   download is the best available signal that the export reached the user.
// - A cancelled share sheet records nothing — the data never left the device,
//   so the nudge must keep firing.
// - Recording is fire-and-forget: the export already reached the user; a
//   stale lastExportAt only costs an extra nudge.
// - A read-only tab skips the recording entirely: the settings write would
//   fail and pollute the repo's shared lastError channel ("Storage error"
//   above a successful export notice). The nudge keeps firing there — honest,
//   since nothing was recorded.
//
// The envelope comes from CoursesRepo.exportAll (plan 09 item 6) — the
// courses.json critical section — and can no longer come from anywhere else:
// Storage.exportAll reads the course list and scans the session files as two
// unsynchronized reads, and a deletion cascade committing between them yields
// an envelope missing a course while still carrying its sessions, which
// re-import as orphans. The delete-confirm screen offers "Export backup first",
// so this is the export that has to be trustworthy. This module used to call
// storage.exportAll() through context.storage — an invariant violation the
// compiler happily allowed; the handle is now gone from StorageContext and the
// lint seam bans reaching for it again. The repo reports failure as null with
// lastError set; it never rejects.

import { exportEnvelopeToBlob } from '../../core/storage/export'
import type { StorageContext } from '../data/storage-context'
import { deliverExport } from './deliver-export'

export type ExportOutcome =
  | { kind: 'delivered'; filename: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string }

export async function runExport(context: StorageContext): Promise<ExportOutcome> {
  try {
    const envelope = await context.coursesRepo.exportAll()
    if (envelope === null) {
      return {
        kind: 'failed',
        message: context.coursesRepo.lastError?.message ?? 'the export could not be assembled',
      }
    }
    const { blob, filename, exportedAt } = exportEnvelopeToBlob(envelope)
    const delivery = await deliverExport(blob, filename)
    if (delivery === 'cancelled') return { kind: 'cancelled' }
    if (!context.liveReadOnly()) {
      void context.coursesRepo.updateSettings({ lastExportAt: exportedAt })
    }
    return { kind: 'delivered', filename }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

export interface ExportNotice {
  ok: boolean
  text: string
}

// The outcome→notice copy, shared by every runExport caller. null for
// 'cancelled': the user changed their mind — no notice.
export function exportOutcomeNotice(outcome: ExportOutcome): ExportNotice | null {
  if (outcome.kind === 'delivered') return { ok: true, text: `Exported ${outcome.filename}` }
  if (outcome.kind === 'failed') return { ok: false, text: `Export failed: ${outcome.message}` }
  return null
}
