// Anchor+Blob download delivery, shared by the /lab recorders (plan 03 item 7)
// and the product export button (plan 06 item 6; Web Share API with files is
// Phase 7 polish). The object URL is revoked in a fresh task, not
// synchronously: Safari aborts a download whose blob URL is revoked within
// the click task itself.

export function downloadBlob(
  filename: string,
  data: Uint8Array | string | Blob,
  type = 'application/octet-stream',
): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
