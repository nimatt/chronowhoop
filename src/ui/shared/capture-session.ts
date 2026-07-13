import type { CameraService, CameraState } from '../../core/camera/camera-service'
import type { CameraSourceStats } from '../../core/detection/camera-source'
import type { RingBuffer } from '../../core/detection/ring-buffer'
import type {
  DetectionTunables,
  FrameSample,
  LumaFrame,
  NormalizedRect,
} from '../../core/detection/types'
import type { WakeLockState } from '../../core/wake-lock/wake-lock'

// The shared capture seam behind both the /lab panels and the /fly timer flow
// (created per screen mount, torn down on unmount — the diag-session pattern).
// One capture session = one CameraSource → TeeSource → DetectionPipeline chain
// plus a screen wake lock; consumers observe it through low-frequency reactive
// fields and register per-frame listeners that never touch reactive state.
export interface CaptureSession {
  readonly camera: CameraService
  readonly cameraState: CameraState
  // Live tunables snapshot (reactive; low-frequency).
  readonly tunables: DetectionTunables
  readonly captureRunning: boolean
  readonly captureError: string | null
  readonly wakeLockState: WakeLockState

  startCapture(): Promise<void>
  stopCapture(): void

  // Live ROI update: source crop + pipeline tunables snapshot.
  setRoi(roi: NormalizedRect): void
  updateTunables(partial: Partial<Omit<DetectionTunables, 'roi'>>): void

  // The EMA-pause seam for detector attachment: forwards to the running
  // pipeline's setPause (next-frame effect; no-op when capture is stopped).
  // Together with addSampleListener this is enough to satisfy the detector's
  // PausableFrameSource without handing out the pipeline itself (see
  // detector-attachment.ts).
  setPipelinePause(paused: boolean): void

  // Discards the pipeline's EMA background model (reseeded from the next
  // frame); no-op while capture is stopped. For callers that know the scene
  // the background was learned from is no longer valid — setRoi does this
  // internally, the fly flow's orientation-restore path calls it directly
  // (the background absorbed rotated frames during the mismatch).
  resetBackground(): void

  // Non-reactive reads for 1 Hz snapshots; both survive stopCapture() (the
  // last run's pipeline and source are retained until the next start) so the
  // ring clip stays exportable and the stats readout stays legible after a
  // pass.
  cameraStats(): CameraSourceStats | null
  ringBuffer(): RingBuffer | null

  // Per-frame fan-outs (the UI bridge rule: listeners draw to canvas / DOM
  // directly). Frame listeners run on the tee tap BEFORE the pipeline
  // processes the frame; sample listeners run on each emitted FrameSample.
  // Both return an unsubscribe function.
  addFrameListener(listener: (frame: LumaFrame) => void): () => void
  addSampleListener(listener: (sample: FrameSample) => void): () => void

  destroy(): void
}
