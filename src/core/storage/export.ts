// Export assembly helpers (plan 06 item 6, logic half): turn an ExportEnvelope
// into a named JSON Blob ready for download.
// This module is pure assembly + filename — no side effects, and (plan 09 item
// 6) it does NOT source the envelope itself: the envelope must come from
// CoursesRepo.exportAll(), inside the courses.json critical section, or a
// cascade committing mid-scan tears it. Recording
// settings.lastExportAt is the UI layer's job (through CoursesRepo, after the
// export has actually been delivered), so the setting reflects a completed
// export, not an assembled blob. Browser delivery itself (anchor click /
// share sheet) also stays UI-side — the export button uses the shared
// downloadBlob helper (src/ui/shared/download.ts) with this module's blob +
// filename.
//
// Decisions:
// - Pretty-printed JSON (2-space): the export is the user's backup and the
//   v1 cross-device path; files are small (text laps), inspectability wins.
// - The filename timestamp is LOCAL time of the envelope's exportedAt
//   instant — the name is for the human who just exported.
// - Seconds, not just minutes (plan 09 item 5): deletion actively encourages
//   export → delete → export inside one minute, and two exports sharing a
//   filename let an overwriting share target replace the user's only undo
//   file with a post-delete snapshot.

import type { ExportEnvelope } from './schema'

export function buildExportFilename(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `chronowhoop-export-${date}-${time}.json`
}

export interface ExportBlobResult {
  blob: Blob
  filename: string
  // The envelope's own exportedAt — what the UI records as
  // settings.lastExportAt after delivery, so name, content, and setting
  // always agree.
  exportedAt: string
}

export function exportEnvelopeToBlob(envelope: ExportEnvelope): ExportBlobResult {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
  const filename = buildExportFilename(new Date(envelope.exportedAt))
  return { blob, filename, exportedAt: envelope.exportedAt }
}
