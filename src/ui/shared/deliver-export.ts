// Export delivery (plan 07 item 1): the share sheet where the platform offers
// one (phones), the anchor download everywhere else. Decisions:
// - canShare({ files }) is the capability probe — some platforms expose
//   share() but refuse files; those fall back to download.
// - Cancelling the share sheet (AbortError) is a user decision, not an error:
//   reported as 'cancelled' so callers record nothing.
// - Any other share() failure falls back to the anchor download — the user
//   asked for their data; a flaky share target must not block the export.

import { downloadBlob } from './download'

export type ExportDelivery = 'shared' | 'downloaded' | 'cancelled'

// Structural navigator seam: headless test browsers (and desktop Linux
// Chromium) have no Web Share API, so tests inject a fake instead of patching
// the real navigator.
export interface ShareCapableNavigator {
  canShare?(data: { files: File[] }): boolean
  share?(data: { files: File[] }): Promise<void>
}

export async function deliverExport(
  blob: Blob,
  filename: string,
  nav: ShareCapableNavigator = navigator,
): Promise<ExportDelivery> {
  const file = new File([blob], filename, { type: 'application/json' })
  if (nav.share !== undefined && nav.canShare?.({ files: [file] }) === true) {
    try {
      await nav.share({ files: [file] })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
    }
  }
  downloadBlob(filename, blob)
  return 'downloaded'
}
