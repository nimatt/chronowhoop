import type { CrossingDirection, CrossingEvent } from '../../core/detection/crossing-events'
import type { Lap } from '../../core/domain/types'
import type { CaptureSession } from '../shared/capture-session'

// The product timer flow: setup (camera + ROI + trigger calibration) → test
// (beep per valid crossing, records nothing) → armed (laps + announcements) →
// stopped (session-end lap table). Phase 5 is amnesia by design — nothing
// here persists; reload evaporates the session.
export type FlyPhase = 'setup' | 'test' | 'armed' | 'stopped'

export type StopCause = 'manual' | 'camera-lost'

// The armed screen's running-clock base. Crossing timestamps live in the
// capture-time domain (VideoFrame timestamps), which has no defined relation
// to performance.now(), so the clock cannot tick from the crossing timestamp
// directly. Instead performance.now() is recorded when the crossing EVENT
// arrives (onArmedStarted/onLap fire synchronously inside sample processing),
// and the display ticks as performance.now() − arrivalPerfMs. Approximation:
// the displayed clock lags the true lap clock by the capture→event latency
// (≲ one frame interval + pipeline cost) and each lap rebases, so the error
// never accumulates — glanceable-display precision, while lap DURATIONS stay
// pure capture-domain (SessionEngine never sees this base).
export interface ArmedClockBase {
  crossingTimestampMs: number
  arrivalPerfMs: number
}

// Extends the shared capture-session seam so the shared calibration
// components (RoiOverlay, energy bars, trigger suggest) compose unchanged;
// adds the session flow on top. Created per Fly.svelte mount, torn down on
// unmount.
export interface FlySession extends CaptureSession {
  readonly phase: FlyPhase
  // Ephemeral inline course fields (no persisted courses until Phase 6).
  readonly direction: CrossingDirection
  readonly minLapTimeMs: number
  readonly testCrossingCount: number
  // Lap-level reactive mirror of "the armed clock is running" (the first
  // valid crossing arrived); the per-frame clock itself reads armedClockBase.
  readonly clockStarted: boolean
  // Lap-level reactive snapshot of the in-memory session's laps (re-copied on
  // lap completion and discard; records are computed from it, never stored).
  readonly laps: readonly Lap[]
  readonly stopCause: StopCause | null
  // True after the page was hidden while armed: detection was interrupted and
  // laps during the gap were not detected. Dismissable.
  readonly interruptionNotice: boolean
  readonly audioPrimed: boolean
  readonly audioError: string | null

  setDirection(direction: CrossingDirection): void
  setMinLapTimeMs(ms: number): void

  startTestMode(): void
  stopTestMode(): void
  arm(): void
  stopSession(): void
  discardLastLap(): void
  // stopped → setup, keeping the camera running.
  newSession(): void
  dismissInterruption(): void
  primeAudio(): Promise<void>

  // Non-reactive read for the armed screen's rAF loop (never $state — the
  // per-frame bridge rule). Null while armed until the first valid crossing.
  armedClockBase(): ArmedClockBase | null

  // Test seam (browser tests): feeds a crossing event straight into the
  // session engine, bypassing camera/detector — driving real optical
  // crossings through a captureStream is too flaky for CI. Not used by
  // product code.
  injectCrossing(event: CrossingEvent): void
}
