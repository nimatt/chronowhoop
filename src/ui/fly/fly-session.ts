import type { CrossingEvent } from '../../core/detection/crossing-events'
import type { Course, Lap } from '../../core/domain/types'
import type { PersisterState } from '../../core/session/session-persister'
import type { WallClock } from '../../core/session/session-engine'
import type { CaptureSession } from '../shared/capture-session'
import type { Orientation } from './orientation-binding'

// The product timer flow: setup (camera + ROI + trigger calibration) → test
// (beep per valid crossing, records nothing) → armed (laps + announcements) →
// stopped (session-end lap table). Since Phase 6 the flow is course-backed
// and persisted: every arm creates a session file (via SessionPersister)
// before the first crossing, rewritten after every lap and discard.
export type FlyPhase = 'setup' | 'test' | 'armed' | 'stopped'

export type StopCause = 'manual' | 'camera-lost'

// Lives here (plain TS) because svelte/prefer-svelte-reactivity bans raw
// `new Date()` in .svelte.ts modules; the SessionEngine clock is a plain
// wall-clock read, not reactive state.
export const wallClock: WallClock = () => new Date()

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
// adds the session flow on top. Created per FlyFlow.svelte mount (after the
// course has loaded), torn down on unmount.
export interface FlySession extends CaptureSession {
  readonly phase: FlyPhase
  // The persisted course this flow runs against (direction and min lap time
  // are the course's — edited via the course form, never inline here).
  readonly course: Course
  readonly testCrossingCount: number
  // Lap-level reactive mirror of "the armed clock is running" (the first
  // valid crossing arrived); the per-frame clock itself reads armedClockBase.
  readonly clockStarted: boolean
  // Lap-level reactive snapshot of the in-memory session's laps (re-copied on
  // lap completion and discard; records are computed from it, never stored).
  readonly laps: readonly Lap[]
  // The current session's note ('' at arm; editable after stop).
  readonly note: string
  // Live SessionPersister state: `pending`/`lastError` are the unsaved-laps
  // signal. Surfaced in the UI only after Stop (plan 06 item 5).
  readonly persisterState: PersisterState
  readonly stopCause: StopCause | null
  // True after the page was hidden while armed: detection was interrupted and
  // laps during the gap were not detected. Dismissable. Also raised when an
  // armed session's orientation is restored after a mismatch — same meaning:
  // crossings during the gap were lost.
  readonly interruptionNotice: boolean
  // The device orientation the running capture was started in (detection.md
  // "Orientation": the ROI is bound to it). Null while the camera is off.
  readonly boundOrientation: Orientation | null
  // True while the device has left the bound orientation: the UI shows a
  // rotate-back warning and detection is invalidated (the detector is
  // detached — crossings during the mismatch are lost) until restored.
  // Arming and test mode are refused while mismatched.
  readonly orientationMismatch: boolean
  readonly audioPrimed: boolean
  readonly audioError: string | null

  startTestMode(): void
  stopTestMode(): void
  // No-ops while the previous session's save is still pending (the persister
  // coalesces globally — arming then would drop the unsaved tail). The UI
  // disables Arm on persisterState.pending for the same reason.
  arm(): void
  stopSession(): void
  discardLastLap(): void
  // Post-stop note editing: updates the engine's session and persists it
  // through the same persister write path as laps.
  setNote(note: string): void
  // stopped → setup, keeping the camera running.
  newSession(): void
  dismissInterruption(): void
  primeAudio(): Promise<void>

  // Non-reactive read for the armed screen's rAF loop (never $state — the
  // per-frame bridge rule). Null while armed until the first valid crossing.
  armedClockBase(): ArmedClockBase | null

  // Test seam (browser tests): whether a crossing detector is currently
  // attached to the capture chain. Non-reactive — read it fresh after driving
  // an event. Lets tests observe the orientation invalidation EXECUTING
  // (detach on mismatch, re-attach on restore) rather than only the parallel
  // injectCrossing guard below.
  readonly detectionAttached: boolean

  // Test seam (browser tests): feeds a crossing event straight into the
  // session engine, bypassing camera/detector — driving real optical
  // crossings through a captureStream is too flaky for CI. Not used by
  // product code. Dropped while orientationMismatch, mirroring the detached
  // detector (no crossing can reach the engine during a mismatch).
  injectCrossing(event: CrossingEvent): void
}
