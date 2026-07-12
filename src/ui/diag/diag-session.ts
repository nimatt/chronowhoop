import type { CameraService, CameraState } from '../../core/camera/camera-service'

// Shared state for the /diag probe panels: one CameraService, the preview
// <video> element (owned by CameraPanel), the acquired GPUDevice (owned by
// GpuPanel), and the frame loop's latest fps measurement (owned by
// FrameLoopPanel, consumed by ReadbackPanel's latency verdict). The reactive
// implementation is the rune module next door, diag-session.svelte.ts.
export interface DiagSession {
  readonly camera: CameraService
  readonly cameraState: CameraState
  video: HTMLVideoElement | null
  device: GPUDevice | null
  measuredFps: number | null
  destroy(): void
}
