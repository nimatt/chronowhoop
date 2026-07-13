// Session-semantics layer (plan 04 item 7): the state machine above crossing
// events that implements product.md's session lifecycle. Pure TS — crossing
// timestamps arrive on the events (capture-time domain); the only wall-clock
// need (Lap.completedAt, Session.startedAt) goes through the injected clock.
// No Date.now()/performance.now() in here, ever.
//
// Decided semantics (tests pin each; see also the notes file):
// - Direction filter: crossings not matching course.direction are ignored in
//   every mode.
// - Test mode: every correct-direction crossing emits onTestCrossing — no
//   min-lap-time debounce (product.md, Test mode) — and records nothing.
// - Armed debounce: measured from the last ACCEPTED crossing; ignored
//   crossings do not reset the window. Boundary is inclusive: a crossing
//   exactly minLapTimeMs after the previous accepted one completes a lap.
// - discardLastLap: targets the most recent lap regardless of status — flips
//   it to 'discarded' and returns true, or returns false (no-op) when there
//   is no lap or it is already discarded. It never reaches past an already-
//   discarded last lap to an earlier valid one. The in-progress lap's timing
//   is unaffected. Allowed while armed or stopped.
// - stop(): drops the in-progress lap and goes to 'stopped'; the session
//   object (in-memory) retains its laps. Stopping test mode returns to
//   'idle' — test mode has no session to retain.
// - arm() always creates a NEW session object (re-arming after stop starts a
//   fresh session); the detection config is deep-copied so later live-tuning
//   by the caller cannot mutate the snapshot.

import type { CrossingEvent } from '../detection/crossing-events'
import type { Course, Lap, Session, SessionDetectionConfig } from '../domain/types'

export type SessionMode = 'idle' | 'test' | 'armed' | 'stopped'

// Wall clock for completedAt/startedAt. May return a Date or epoch
// milliseconds; either is rendered to an ISO string.
export type WallClock = () => Date | number

export interface SessionEngineCallbacks {
  // A lap was completed while armed (Phase 5: announcer + lap table).
  onLap?: (lap: Lap, session: Session) => void
  // A correct-direction crossing in test mode (Phase 5 / lab: feedback beep —
  // audio is the caller's concern).
  onTestCrossing?: (event: CrossingEvent) => void
  // The first valid crossing while armed started the clock (completes no lap).
  onArmedStarted?: (timestampMs: number) => void
}

export interface InProgressLap {
  startedAtMs: number
  elapsedMs(nowMs: number): number
}

export interface SessionEngineOptions {
  now: WallClock
  // Session IDs; defaults to crypto.randomUUID (storage.md).
  generateId?: () => string
  callbacks?: SessionEngineCallbacks
}

export class SessionEngine {
  #now: WallClock
  #generateId: () => string
  #callbacks: SessionEngineCallbacks
  #mode: SessionMode = 'idle'
  #course: Course | null = null
  #session: Session | null = null
  #lastAcceptedCrossingMs: number | null = null

  constructor(options: SessionEngineOptions) {
    this.#now = options.now
    this.#generateId = options.generateId ?? (() => crypto.randomUUID())
    this.#callbacks = options.callbacks ?? {}
  }

  get mode(): SessionMode {
    return this.#mode
  }

  // The in-memory, storage.md-shaped session: created by arm(), retained
  // (with its laps) after stop(), replaced by the next arm(). Null in idle
  // and test modes.
  get session(): Session | null {
    return this.#session
  }

  // For the UI clock: non-null once the armed clock has started, until the
  // session is stopped. Between crossings it is the lap currently being
  // timed; elapsedMs takes a capture-domain "now" (same domain as crossing
  // timestamps).
  get inProgressLap(): InProgressLap | null {
    if (this.#mode !== 'armed' || this.#lastAcceptedCrossingMs === null) return null
    const startedAtMs = this.#lastAcceptedCrossingMs
    return { startedAtMs, elapsedMs: (nowMs: number) => nowMs - startedAtMs }
  }

  // Test mode records nothing, so it takes no detection config — the caller
  // runs detection however it likes and just feeds crossings in.
  startTest(course: Course): void {
    this.#mode = 'test'
    this.#course = course
    this.#session = null
    this.#lastAcceptedCrossingMs = null
  }

  arm(course: Course, detectionConfig: SessionDetectionConfig, note = ''): void {
    this.#mode = 'armed'
    this.#course = course
    this.#lastAcceptedCrossingMs = null
    this.#session = {
      id: this.#generateId(),
      courseId: course.id,
      startedAt: this.#nowIso(),
      note,
      detectionConfig: structuredClone(detectionConfig),
      laps: [],
    }
  }

  stop(): void {
    if (this.#mode === 'armed') {
      this.#mode = 'stopped'
      this.#lastAcceptedCrossingMs = null
    } else if (this.#mode === 'test') {
      this.#mode = 'idle'
      this.#course = null
    }
  }

  discardLastLap(): boolean {
    const laps = this.#session?.laps
    if (laps === undefined || laps.length === 0) return false
    const last = laps[laps.length - 1]
    if (last.status === 'discarded') return false
    last.status = 'discarded'
    return true
  }

  onCrossing(event: CrossingEvent): void {
    if (this.#course === null) return
    if (event.direction !== this.#course.direction) return

    if (this.#mode === 'test') {
      this.#callbacks.onTestCrossing?.(event)
      return
    }
    if (this.#mode !== 'armed' || this.#session === null) return

    if (this.#lastAcceptedCrossingMs === null) {
      this.#lastAcceptedCrossingMs = event.timestampMs
      this.#callbacks.onArmedStarted?.(event.timestampMs)
      return
    }

    const durationMs = event.timestampMs - this.#lastAcceptedCrossingMs
    if (durationMs < this.#course.minLapTimeMs) return

    const lap: Lap = {
      n: this.#session.laps.length + 1,
      durationMs,
      completedAt: this.#nowIso(),
      status: 'valid',
    }
    this.#session.laps.push(lap)
    this.#lastAcceptedCrossingMs = event.timestampMs
    this.#callbacks.onLap?.(lap, this.#session)
  }

  #nowIso(): string {
    const value = this.#now()
    return (typeof value === 'number' ? new Date(value) : value).toISOString()
  }
}
