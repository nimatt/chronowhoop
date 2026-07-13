import { Announcer, computeAnnouncementRecords } from '../../core/announcer/announcer'
import { getAudioService } from '../../core/audio/audio-service'
import type { CameraMediaDevicesLike } from '../../core/camera/camera-service'
import { CrossingDetector } from '../../core/detection/crossing-detector'
import type { CrossingDirection, CrossingEvent } from '../../core/detection/crossing-events'
import type { Lap, SessionDetectionConfig } from '../../core/domain/types'
import { SessionEngine } from '../../core/session/session-engine'
import { errorText } from '../diag/format'
import { createCaptureSession } from '../shared/capture-session.svelte'
import {
  attachDetectorToCaptureSession,
  detectorTriggerLevel,
} from '../shared/detector-attachment'
import type { ArmedClockBase, FlyPhase, FlySession, StopCause } from './fly-session'
import { createQuickCourse, DEFAULT_MIN_LAP_TIME_MS, wallClock } from './quick-course'

export interface FlySessionOptions {
  // Test seam: the browser test injects a mediaDevices whose getUserMedia
  // resolves to a canvas captureStream; production uses the real one.
  mediaDevices?: CameraMediaDevicesLike
}

// Created per mount of Fly.svelte — navigating away tears everything down
// (camera, pipeline, detector, wake lock) and a revisit starts fresh. The
// session data itself is in-memory only (Phase 5 amnesia by design).
//
// Composes the shared capture session (camera → source → tee → pipeline +
// wake lock) and layers the product timer flow on top: engine + announcer +
// detector attachment + interruption handling.
export function createFlySession(options: FlySessionOptions = {}): FlySession {
  const audio = getAudioService()
  const announcer = new Announcer(audio)

  let phase = $state<FlyPhase>('setup')
  let direction = $state<CrossingDirection>('ltr')
  let minLapTimeMs = $state(DEFAULT_MIN_LAP_TIME_MS)
  let testCrossingCount = $state(0)
  let clockStarted = $state(false)
  let laps = $state<Lap[]>([])
  let stopCause = $state<StopCause | null>(null)
  let interruptionNotice = $state(false)
  let audioPrimed = $state(audio.primed)
  let audioError = $state<string | null>(null)

  // Detection wiring, alive while phase is 'test' or 'armed'.
  let detector: CrossingDetector | null = null
  let detachDetection: (() => void) | null = null

  // Non-reactive by design: read per rAF tick by the armed screen.
  let clockBase: ArmedClockBase | null = null
  // Set on visibilitychange→hidden while armed; promoted to the reactive
  // interruptionNotice when the page becomes visible again.
  let pendingInterruption = false

  const capture = createCaptureSession({
    mediaDevices: options.mediaDevices,
    // The Start-camera gesture also unlocks audio (beeps + speech).
    // Best-effort: a priming failure surfaces as a retryable warning, never
    // blocks the camera.
    onStartGesture: () => void primeAudio(),
    // External stream death (track ended, permission revoked): product.md
    // says while armed this auto-stops the session with its laps retained;
    // the failure stays visible via cameraState + captureError. While in test
    // mode it falls back to setup.
    onCameraFailure: () => {
      if (phase === 'armed') {
        stopSession('camera-lost')
      } else if (phase === 'test') {
        stopTestMode()
      }
    },
    // The tunables slider applies live to the pipeline; the detector follows.
    onTunablesUpdated: (partial) => {
      if (partial.triggerLevel !== undefined) {
        detector?.updateConfig({ triggerLevel: detectorTriggerLevel(partial.triggerLevel) })
      }
    },
  })

  const engine = new SessionEngine({
    now: wallClock,
    callbacks: {
      onArmedStarted(timestampMs) {
        clockBase = { crossingTimestampMs: timestampMs, arrivalPerfMs: performance.now() }
        clockStarted = true
      },
      onLap(lap, session) {
        // inProgressLap.startedAtMs is the crossing that completed this lap
        // and started the next one — the new clock base.
        const startedAtMs = engine.inProgressLap?.startedAtMs
        if (startedAtMs !== undefined) {
          clockBase = { crossingTimestampMs: startedAtMs, arrivalPerfMs: performance.now() }
        }
        laps = session.laps.map((each) => ({ ...each }))
        announcer.announceLap(lap, computeAnnouncementRecords(session.laps, lap))
      },
      onTestCrossing() {
        audio.beep()
        testCrossingCount += 1
      },
    },
  })

  const makeCourse = () => createQuickCourse(direction, minLapTimeMs)

  function attachDetection(): void {
    if (detachDetection !== null) return
    const nextDetector = new CrossingDetector({
      triggerLevel: detectorTriggerLevel(capture.tunables.triggerLevel),
    })
    const detach = attachDetectorToCaptureSession(capture, nextDetector, (event) =>
      engine.onCrossing(event),
    )
    detector = nextDetector
    detachDetection = () => {
      detach()
      detector = null
      detachDetection = null
    }
  }

  function primeAudio(): Promise<void> {
    return audio.primeOnGesture().then(
      () => {
        audioPrimed = true
        audioError = null
      },
      (error: unknown) => {
        audioError = errorText(error)
      },
    )
  }

  function startTestMode(): void {
    if (phase !== 'setup' || !capture.captureRunning) return
    testCrossingCount = 0
    engine.startTest(makeCourse())
    attachDetection()
    phase = 'test'
  }

  function stopTestMode(): void {
    if (phase !== 'test') return
    detachDetection?.()
    engine.stop()
    phase = 'setup'
  }

  function arm(): void {
    if ((phase !== 'setup' && phase !== 'test') || !capture.captureRunning) return
    attachDetection()
    // Arming from test mode reuses the already-attached detector: a candidate
    // begun in test mode must not carry into the armed session and start its
    // clock. (A freshly attached detector is already quiet — reset is a no-op
    // then.)
    detector!.reset()
    const detectionConfig: SessionDetectionConfig = {
      tunables: { ...capture.tunables, roi: { ...capture.tunables.roi } },
      detector: detector!.config,
    }
    engine.arm(makeCourse(), detectionConfig)
    laps = []
    clockBase = null
    clockStarted = false
    stopCause = null
    interruptionNotice = false
    pendingInterruption = false
    phase = 'armed'
  }

  function stopSession(cause: StopCause = 'manual'): void {
    if (phase !== 'armed') return
    engine.stop()
    detachDetection?.()
    clockBase = null
    stopCause = cause
    phase = 'stopped'
  }

  function discardLastLap(): void {
    const session = engine.session
    if (session === null) return
    if (engine.discardLastLap()) {
      // Announcer stays silent; records recompute from the snapshot.
      laps = session.laps.map((each) => ({ ...each }))
    }
  }

  function newSession(): void {
    if (phase !== 'stopped') return
    laps = []
    stopCause = null
    interruptionNotice = false
    pendingInterruption = false
    testCrossingCount = 0
    phase = 'setup'
  }

  // product.md interruption decision: page hidden while armed → detection is
  // interrupted (camera frames stop); timing continues, missed crossings are
  // simply missed; a dismissable notice shows on return.
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      if (phase === 'armed') pendingInterruption = true
    } else if (pendingInterruption) {
      pendingInterruption = false
      interruptionNotice = true
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  return {
    // The shared capture surface, delegated. Reactive fields go through
    // getters so the capture session's $state stays live; the methods are
    // closure-based and safe to alias.
    camera: capture.camera,
    get cameraState() {
      return capture.cameraState
    },
    get tunables() {
      return capture.tunables
    },
    get captureRunning() {
      return capture.captureRunning
    },
    get captureError() {
      return capture.captureError
    },
    get wakeLockState() {
      return capture.wakeLockState
    },
    startCapture: capture.startCapture,
    stopCapture: capture.stopCapture,
    setRoi: capture.setRoi,
    updateTunables: capture.updateTunables,
    setPipelinePause: capture.setPipelinePause,
    cameraStats: capture.cameraStats,
    ringBuffer: capture.ringBuffer,
    addFrameListener: capture.addFrameListener,
    addSampleListener: capture.addSampleListener,

    get phase() {
      return phase
    },
    get direction() {
      return direction
    },
    get minLapTimeMs() {
      return minLapTimeMs
    },
    get testCrossingCount() {
      return testCrossingCount
    },
    get clockStarted() {
      return clockStarted
    },
    get laps() {
      return laps
    },
    get stopCause() {
      return stopCause
    },
    get interruptionNotice() {
      return interruptionNotice
    },
    get audioPrimed() {
      return audioPrimed
    },
    get audioError() {
      return audioError
    },
    setDirection(next: CrossingDirection) {
      if (phase === 'setup') direction = next
    },
    setMinLapTimeMs(ms: number) {
      if (phase === 'setup' && Number.isFinite(ms) && ms >= 0) minLapTimeMs = ms
    },
    startTestMode,
    stopTestMode,
    arm,
    stopSession: () => stopSession('manual'),
    discardLastLap,
    newSession,
    dismissInterruption() {
      interruptionNotice = false
    },
    primeAudio,
    armedClockBase: () => clockBase,
    injectCrossing(event: CrossingEvent) {
      engine.onCrossing(event)
    },
    destroy() {
      detachDetection?.()
      engine.stop()
      capture.destroy()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    },
  }
}
