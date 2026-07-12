import type { FrameSample } from './types'

// The pipeline and everything above it consume this interface, never capture
// APIs directly (plan 03 item 1). Planned implementations:
// - CameraSource: MediaStreamTrackProcessor over the camera track, ROI crop in
//   copyTo, Y-plane luminance.
// - ClipSource: frame-exact replay of raw luma clips, honoring recorded
//   capture-timestamp gaps; pure TS, runs in node.
// - SyntheticSource: programmable moving blob with known ground-truth
//   crossing frames.
export interface FrameSource {
  start(onSample: (sample: FrameSample) => void): void
  stop(): void
}
