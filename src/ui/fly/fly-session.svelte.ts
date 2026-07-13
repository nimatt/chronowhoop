import { Announcer, announceCompletedLap } from '../../core/announcer/announcer'
import { getAudioService } from '../../core/audio/audio-service'
import type { CameraMediaDevicesLike } from '../../core/camera/camera-service'
import { CrossingDetector } from '../../core/detection/crossing-detector'
import type { CrossingEvent } from '../../core/detection/crossing-events'
import type { Course, Lap, SessionDetectionConfig } from '../../core/domain/types'
import { SessionEngine } from '../../core/session/session-engine'
import {
  createSessionPersister,
  type PersisterState,
} from '../../core/session/session-persister'
import type { Storage } from '../../core/storage/storage'
import { errorText } from '../diag/format'
import { createCaptureSession } from '../shared/capture-session.svelte'
import {
  attachDetectorToCaptureSession,
  detectorTriggerLevel,
} from '../shared/detector-attachment'
import type { ArmedClockBase, FlyPhase, FlySession, StopCause } from './fly-session'
import { wallClock } from './fly-session'

export interface FlySessionOptions {
  // The persisted course the flow runs against (loaded before creation).
  course: Course
  // Sessions are persisted through this seam via a SessionPersister:
  // file created at arm, rewritten per lap/discard/note edit, flushed on
  // stop. All persister calls are synchronous fire-and-forget — a slow or
  // failing write never delays lap timing or speech (plan 06 item 5).
  storage: Storage
  // The most recent session's detectionConfig snapshot for this course
  // (product.md prefill); absent → the shipped defaults.
  initialDetectionConfig?: SessionDetectionConfig
  // Read at announcement time (settings.speechEnabled); false skips the
  // announcer entirely. Test-mode beeps are unaffected — they are setup
  // feedback, not speech.
  speechEnabled?: () => boolean
  // Fired synchronously on arm (the fly screen records settings.lastCourseId
  // here, fire-and-forget).
  onArmed?: () => void
  // Test seam: the browser test injects a mediaDevices whose getUserMedia
  // resolves to a canvas captureStream; production uses the real one.
  mediaDevices?: CameraMediaDevicesLike
}

// Created per mount of FlyFlow.svelte — navigating away tears everything down
// (camera, pipeline, detector, wake lock) and a revisit starts fresh. The
// session DATA persists through the SessionPersister; the in-memory flow
// state does not.
//
// Composes the shared capture session (camera → source → tee → pipeline +
// wake lock) and layers the product timer flow on top: engine + announcer +
// persister + detector attachment + interruption handling.
export function createFlySession(options: FlySessionOptions): FlySession {
  const audio = getAudioService()
  const announcer = new Announcer(audio)
  const course = options.course
  const speechEnabled = options.speechEnabled ?? (() => true)

  let phase = $state<FlyPhase>('setup')
  let testCrossingCount = $state(0)
  let clockStarted = $state(false)
  let laps = $state<Lap[]>([])
  let note = $state('')
  let stopCause = $state<StopCause | null>(null)
  let interruptionNotice = $state(false)
  let audioPrimed = $state(audio.primed)
  let audioError = $state<string | null>(null)

  // Reactive mirror of the persister's state (low-frequency; the persister
  // itself never blocks the crossing path).
  let persisterState = $state<PersisterState>({ pending: false })
  const persister = createSessionPersister(options.storage, {
    onStateChange: (state) => {
      persisterState = state
    },
  })

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

  // Prefill (product.md setup step): the course's most recent session's
  // snapshot seeds the tunables; capture has not started yet, so setRoi /
  // updateTunables only update the reactive snapshot the next start reads.
  const prefillTunables = options.initialDetectionConfig?.tunables
  if (prefillTunables !== undefined) {
    const { roi, ...rest } = prefillTunables
    capture.setRoi(roi)
    capture.updateTunables(rest)
  }
  // The detector half of the snapshot seeds every detector this flow creates;
  // triggerLevel always tracks the live tunables slider instead.
  const detectorBase = options.initialDetectionConfig?.detector

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
        // Persist before announcing; both are synchronous, so neither can
        // delay the other. This persist-then-announce hookup is the one the
        // full-loop rig runs (announceCompletedLap is shared with
        // createArmedSessionRig): full-loop-storage.test.ts proves the
        // announcement decisions are byte-identical with no storage, a hung
        // storage, and a failing storage.
        persister.sessionUpdated(session)
        if (speechEnabled()) {
          announceCompletedLap(announcer, lap, session.laps)
        }
      },
      onTestCrossing() {
        audio.beep()
        testCrossingCount += 1
      },
    },
  })

  function attachDetection(): void {
    if (detachDetection !== null) return
    const triggerLevel = detectorTriggerLevel(capture.tunables.triggerLevel)
    let nextDetector: CrossingDetector
    try {
      nextDetector = new CrossingDetector({ ...(detectorBase ?? {}), triggerLevel })
    } catch {
      // A stored detector snapshot that fails the detector's own validation
      // (schema validation only checks finiteness) must not brick arming —
      // fall back to defaults.
      nextDetector = new CrossingDetector({ triggerLevel })
    }
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
    engine.startTest(course)
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
    // The persister coalesces globally (not per session id), so starting a
    // new session while the previous one still has unsaved data would drop
    // that tail. The UI disables Arm and explains; this guard makes the gate
    // authoritative. A hung storage keeps pending true forever — honest,
    // since the new session's writes would hang the same way.
    if (persister.state.pending) return
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
    // A stale queued announcement from the previous session must not leak
    // across the arm boundary.
    announcer.reset()
    engine.arm(course, detectionConfig)
    // The session file exists before the first crossing — a zero-lap crash
    // leaves a recoverable record (plan 06 item 5).
    persister.sessionStarted(engine.session!)
    options.onArmed?.()
    laps = []
    note = ''
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
    announcer.reset()
    // Fire-and-forget: the stopped panel reads persisterState (pending /
    // lastError) for the saved / unsaved-laps indicator; flush() never
    // rejects and must not be awaited here (never-block).
    void persister.flush()
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
      persister.sessionUpdated(session)
    }
  }

  function setNote(next: string): void {
    // Post-stop note editing (product.md session view / stopped panel). The
    // engine's session object is the single in-memory truth, so the note is
    // written onto it and persisted through the same persister path as laps —
    // the saved/unsaved indicator stays honest.
    if (phase !== 'stopped') return
    const session = engine.session
    if (session === null) return
    session.note = next
    note = next
    persister.sessionUpdated(session)
  }

  function newSession(): void {
    if (phase !== 'stopped') return
    laps = []
    note = ''
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
    course,
    get testCrossingCount() {
      return testCrossingCount
    },
    get clockStarted() {
      return clockStarted
    },
    get laps() {
      return laps
    },
    get note() {
      return note
    },
    get persisterState() {
      return persisterState
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
    startTestMode,
    stopTestMode,
    arm,
    stopSession: () => stopSession('manual'),
    discardLastLap,
    setNote,
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
      // A queued announcement must not speak over the next screen.
      announcer.reset()
      // Best-effort last write attempt on teardown; never awaited.
      void persister.flush()
      capture.destroy()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    },
  }
}
