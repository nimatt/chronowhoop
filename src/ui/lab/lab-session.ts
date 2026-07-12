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

// The /lab panels' shared seam (created per Lab.svelte mount, torn down on
// unmount — the diag-session pattern). One capture session = one
// CameraSource → TeeSource → DetectionPipeline chain plus a screen wake lock;
// panels observe it through low-frequency reactive fields and register
// per-frame listeners that never touch reactive state.
export interface LabSession {
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
