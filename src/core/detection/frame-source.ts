import type { FrameSample, LumaFrame } from './types'

// Capture sources emit working-resolution luma frames through this interface;
// the DetectionPipeline composes any LumaSource with the shared reducer and
// ring buffer (plan 03 item 1, staging-notes source decomposition).
// Implementations:
// - CameraSource: MediaStreamTrackProcessor over the camera track, ROI crop in
//   copyTo, Y-plane luminance.
// - ClipSource: frame-exact replay of raw luma clips, honoring recorded
//   capture-timestamp gaps; pure TS, runs in node.
// - SyntheticSource: programmable moving blob with known ground-truth
//   crossing frames.
// Emitted frames are owned by the consumer (see LumaFrame): sources must not
// reuse a frame's data buffer after emitting it.
export interface LumaSource {
  start(onFrame: (frame: LumaFrame) => void): void
  stop(): void
}

// The app-facing seam: everything above the detection module consumes this
// FrameSample stream, never capture APIs or LumaFrames directly.
// DetectionPipeline is the implementation.
export interface FrameSource {
  start(onSample: (sample: FrameSample) => void): void
  stop(): void
}
