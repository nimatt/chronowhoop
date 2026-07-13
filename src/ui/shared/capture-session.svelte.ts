import {
  CameraService,
  type CameraMediaDevicesLike,
  type CameraState,
} from '../../core/camera/camera-service'
import { CameraSource } from '../../core/detection/camera-source'
import { DetectionPipeline } from '../../core/detection/pipeline'
import { teeSource } from '../../core/detection/tee'
import {
  DEFAULT_DETECTION_TUNABLES,
  type DetectionTunables,
  type FrameSample,
  type LumaFrame,
  type NormalizedRect,
} from '../../core/detection/types'
import {
  createWakeLockService,
  type WakeLockService,
  type WakeLockState,
} from '../../core/wake-lock/wake-lock'
import type { CaptureSession } from './capture-session'

export interface CaptureSessionOptions {
  // Test seam: the browser test injects a mediaDevices whose getUserMedia
  // resolves to a canvas captureStream; production uses the real one.
  mediaDevices?: CameraMediaDevicesLike
  // Called synchronously inside startCapture, BEFORE anything is awaited, so
  // it still runs in the user-gesture context of the Start click (the fly
  // screen unlocks audio here — gesture-gated APIs would fail after an await).
  onStartGesture?: () => void
  // Called after an EXTERNAL camera death (track ended, permission revoked)
  // has torn capture down — never on deliberate stopCapture(). The fly screen
  // auto-stops its session here.
  onCameraFailure?: () => void
  // Called after updateTunables applied a partial to the pipeline (the fly
  // screen forwards triggerLevel to its live detector).
  onTunablesUpdated?: (partial: Partial<Omit<DetectionTunables, 'roi'>>) => void
}

// Created per screen mount — navigating away tears everything down (camera,
// pipeline, wake lock) and a revisit starts fresh.
export function createCaptureSession(options: CaptureSessionOptions = {}): CaptureSession {
  const camera = options.mediaDevices
    ? new CameraService(options.mediaDevices)
    : new CameraService()
  let cameraState = $state<CameraState>(camera.state)
  let tunables = $state<DetectionTunables>({
    ...DEFAULT_DETECTION_TUNABLES,
    roi: { ...DEFAULT_DETECTION_TUNABLES.roi },
  })
  let captureRunning = $state(false)
  let captureError = $state<string | null>(null)
  let wakeLockState = $state<WakeLockState>('released')

  // Capture-session resources. cameraSource and pipeline are retained after
  // stopCapture() (frozen stats, exportable ring) until the next start;
  // CameraSource is single-use so every start builds a fresh chain.
  let cameraSource: CameraSource | null = null
  let pipeline: DetectionPipeline | null = null
  let wakeLock: WakeLockService | null = null
  // Bumped per wake-lock creation: a disposed session's late async transition
  // (dispose() → 'released') must not clobber the next session's state.
  let wakeLockGeneration = 0
  let starting = false

  // Deliberately non-reactive registries (per-frame fan-out): plain arrays,
  // replaced wholesale on unsubscribe.
  let frameListeners: Array<(frame: LumaFrame) => void> = []
  let sampleListeners: Array<(sample: FrameSample) => void> = []

  const unsubscribeCamera = camera.subscribe((next) => {
    cameraState = next
    // The stream can die outside our stop path (track ended, permission
    // revoked) — CameraService reports that as a failure state, never 'idle'
    // ('idle' is reserved for deliberate stop(), and stopCapture() clears
    // captureRunning before camera.stop() anyway), so this fires exactly for
    // external deaths: tear down capture + wake lock, keep the camera error
    // state visible, and record why capture stopped.
    if (captureRunning && 'error' in next) {
      captureError = `capture stopped: camera ${next.status} (${next.error.kind}): ${next.error.message}`
      teardownCapture()
      options.onCameraFailure?.()
    }
  })

  async function startCapture(): Promise<void> {
    if (captureRunning || starting) return
    starting = true
    captureError = null
    options.onStartGesture?.()
    try {
      const state = await camera.start()
      if (state.status !== 'active') return
      const track = state.stream.getVideoTracks()[0]
      if (!track) {
        captureError = 'active stream has no video track'
        camera.stop()
        return
      }
      const source = new CameraSource(track, { roi: tunables.roi })
      const tee = teeSource(source, (frame) => {
        for (const listener of frameListeners) listener(frame)
      })
      const nextPipeline = new DetectionPipeline(tee, tunables)
      nextPipeline.start((sample) => {
        for (const listener of sampleListeners) listener(sample)
      })
      cameraSource = source
      pipeline = nextPipeline

      // Wake lock per capture session, created here in the gesture handler
      // (never at render time — the WakeLockPanel lesson: a boundary-caught
      // render crash must not leak its visibilitychange listener). Held for
      // the whole camera-active flow (product.md: long calibration must not
      // dim the screen).
      const generation = ++wakeLockGeneration
      wakeLock = createWakeLockService({
        onTransition: (transition) => {
          if (generation === wakeLockGeneration) wakeLockState = transition.state
        },
      })
      void wakeLock.acquire()
      captureRunning = true
    } catch (error) {
      captureError = error instanceof Error ? error.message : String(error)
      camera.stop()
    } finally {
      starting = false
    }
  }

  // Shared by manual stop and the external-death subscriber. Does NOT touch
  // the camera: the death path must leave the failure state visible, so only
  // stopCapture() (the deliberate path) returns the camera to idle.
  function teardownCapture(): void {
    captureRunning = false
    pipeline?.stop()
    const lock = wakeLock
    wakeLock = null
    void lock?.dispose()
  }

  function stopCapture(): void {
    teardownCapture()
    camera.stop()
  }

  function setRoi(roi: NormalizedRect): void {
    tunables = { ...tunables, roi: { ...roi } }
    cameraSource?.setRoi(roi)
    pipeline?.updateTunables({ roi })
    // The EMA background belongs to the old crop; a moved ROI must not diff
    // against it.
    pipeline?.resetBackground()
  }

  function updateTunables(partial: Partial<Omit<DetectionTunables, 'roi'>>): void {
    tunables = { ...tunables, ...partial }
    pipeline?.updateTunables(partial)
    options.onTunablesUpdated?.(partial)
  }

  return {
    camera,
    get cameraState() {
      return cameraState
    },
    get tunables() {
      return tunables
    },
    get captureRunning() {
      return captureRunning
    },
    get captureError() {
      return captureError
    },
    get wakeLockState() {
      return wakeLockState
    },
    startCapture,
    stopCapture,
    setRoi,
    updateTunables,
    setPipelinePause(paused) {
      pipeline?.setPause(paused)
    },
    resetBackground() {
      pipeline?.resetBackground()
    },
    cameraStats: () => cameraSource?.stats() ?? null,
    ringBuffer: () => pipeline?.ringBuffer ?? null,
    addFrameListener(listener) {
      frameListeners = [...frameListeners, listener]
      return () => {
        frameListeners = frameListeners.filter((candidate) => candidate !== listener)
      }
    },
    addSampleListener(listener) {
      sampleListeners = [...sampleListeners, listener]
      return () => {
        sampleListeners = sampleListeners.filter((candidate) => candidate !== listener)
      }
    },
    destroy() {
      stopCapture()
      unsubscribeCamera()
      frameListeners = []
      sampleListeners = []
    },
  }
}
