// Capture-API access lives inside the detection module (detection.md, ADR
// 0009) — the lint seam bans the MediaStreamTrackProcessor identifier
// elsewhere, so the capability gate's default lookup is exported from here,
// mirroring how the OPFS probe lives in src/core/storage.
export function defaultMediaStreamTrackProcessor(): unknown {
  return (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor
}
