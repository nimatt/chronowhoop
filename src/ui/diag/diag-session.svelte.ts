import { CameraService, type CameraState } from '../../core/camera/camera-service'
import type { DiagSession } from './diag-session'

// Created per mount of Diag.svelte — not as a module-level singleton — so
// navigating away tears everything down and a revisit starts fresh.
export function createDiagSession(): DiagSession {
  const camera = new CameraService()
  let cameraState = $state<CameraState>(camera.state)
  const unsubscribe = camera.subscribe((next) => {
    cameraState = next
  })
  let video = $state<HTMLVideoElement | null>(null)
  let device = $state<GPUDevice | null>(null)
  let measuredFps = $state<number | null>(null)

  return {
    camera,
    get cameraState() {
      return cameraState
    },
    get video() {
      return video
    },
    set video(element) {
      // measuredFps belongs to the camera it was measured on: a stop (null)
      // or restart (new element) must not leave a previous camera's rate
      // feeding ReadbackPanel's latency gate.
      if (element !== video) measuredFps = null
      video = element
    },
    get device() {
      return device
    },
    set device(next) {
      device = next
    },
    get measuredFps() {
      return measuredFps
    },
    set measuredFps(fps) {
      measuredFps = fps
    },
    destroy() {
      unsubscribe()
      camera.stop()
      device?.destroy()
      device = null
      video = null
    },
  }
}
