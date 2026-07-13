// The crossing state machine (plan 04 items 1–3): consumes FrameSamples,
// emits CrossingEvents. Pure TS with injectable-clock discipline — all timing
// derives from FrameSample.captureTimeMs (no Date.now/performance.now, ever)
// and every window is milliseconds, never frame counts, so dropped frames and
// thermal throttling perturb nothing semantically. The normative behavior is
// docs/specs/detection.md "Crossing detector"; the synthetic suite
// (crossing-detector.test.ts over synthetic-sequences.ts) is its executable
// form.

import type { FrameSample } from './types'
import type { FrameSource } from './frame-source'
import type { CrossingDirection, CrossingEvent } from './crossing-events'
import { DEFAULT_DETECTION_TUNABLES } from './types'

export interface CrossingDetectorConfig {
  // Normalized strip energy (hot pixels / strip pixels) at which a strip
  // becomes hot. detection.md: auto-suggested from background noise
  // (trigger-suggest.ts), user-adjustable.
  triggerLevel: number
  // A hot strip stays hot until its level falls below
  // hysteresisRatio × triggerLevel, so flutter around the trigger level
  // cannot re-trigger hot transitions.
  hysteresisRatio: number
  // A candidate starts only when a strip within the outermost entryZoneStrips
  // strips (on either side) goes hot from a quiet detector state.
  entryZoneStrips: number
  // Tolerated regression of the leading edge (in strips) before the candidate
  // aborts as not-a-wave.
  maxBackstepStrips: number
  // A candidate completing faster than this is rejected as implausible.
  // Default 0 (disabled): same-frame all-hot is handled by transient
  // rejection, not a minimum.
  minTraversalMs: number
  // A candidate expires (emitting nothing) after this long without reaching
  // the far entry zone.
  maxTraversalMs: number
  // A completed crossing must have seen at least this many distinct strips
  // hot during the candidate.
  minParticipatingStrips: number
  // If at least this fraction of nonzero-pixel strips goes hot within a
  // single frame, the frame is a global transient (AE/AWB step, lighting
  // change), not a wave: cancel any candidate and hold off new ones.
  transientStripFraction: number
  // Candidate starts are suppressed for this long after a global transient.
  transientHoldoffMs: number
  // crossingInProgress (which freezes the EMA background via
  // DetectionPipeline.setPause) is hard-capped at this many ms per candidate,
  // so a parked/crashed drone cannot freeze the background forever.
  maxPauseMs: number
}

export const DEFAULT_CROSSING_DETECTOR_CONFIG: CrossingDetectorConfig = {
  triggerLevel: DEFAULT_DETECTION_TUNABLES.triggerLevel,
  hysteresisRatio: 0.5,
  entryZoneStrips: 2,
  maxBackstepStrips: 1,
  minTraversalMs: 0,
  maxTraversalMs: 1500,
  minParticipatingStrips: 3,
  transientStripFraction: 0.7,
  transientHoldoffMs: 300,
  maxPauseMs: 2000,
}

function assertConfig(condition: boolean, message: string): void {
  if (!condition) throw new Error(`CrossingDetector config: ${message}`)
}

function validateConfig(config: CrossingDetectorConfig): CrossingDetectorConfig {
  assertConfig(
    Number.isFinite(config.triggerLevel) && config.triggerLevel > 0,
    `triggerLevel must be a finite number > 0, got ${config.triggerLevel}`,
  )
  assertConfig(
    config.hysteresisRatio > 0 && config.hysteresisRatio <= 1,
    `hysteresisRatio must be in (0, 1], got ${config.hysteresisRatio}`,
  )
  assertConfig(
    Number.isInteger(config.entryZoneStrips) && config.entryZoneStrips >= 1,
    `entryZoneStrips must be a positive integer, got ${config.entryZoneStrips}`,
  )
  assertConfig(
    Number.isInteger(config.maxBackstepStrips) && config.maxBackstepStrips >= 0,
    `maxBackstepStrips must be a non-negative integer, got ${config.maxBackstepStrips}`,
  )
  assertConfig(config.minTraversalMs >= 0, `minTraversalMs must be ≥ 0, got ${config.minTraversalMs}`)
  assertConfig(
    config.maxTraversalMs > 0 && config.maxTraversalMs >= config.minTraversalMs,
    `maxTraversalMs must be > 0 and ≥ minTraversalMs, got ${config.maxTraversalMs}`,
  )
  assertConfig(
    Number.isInteger(config.minParticipatingStrips) && config.minParticipatingStrips >= 1,
    `minParticipatingStrips must be a positive integer, got ${config.minParticipatingStrips}`,
  )
  assertConfig(
    config.transientStripFraction > 0 && config.transientStripFraction <= 1,
    `transientStripFraction must be in (0, 1], got ${config.transientStripFraction}`,
  )
  assertConfig(
    config.transientHoldoffMs >= 0,
    `transientHoldoffMs must be ≥ 0, got ${config.transientHoldoffMs}`,
  )
  assertConfig(config.maxPauseMs > 0, `maxPauseMs must be > 0, got ${config.maxPauseMs}`)
  return config
}

// A wave being tracked. Progress is direction-normalized: strip index for
// ltr, N−1−index for rtl, so 0 is always the origin edge and N−1 the far
// edge. furthestProgress is the furthest the leading edge has EVER advanced
// (per-frame dips within maxBackstepStrips are tolerated flutter).
interface Candidate {
  direction: CrossingDirection
  startTimeMs: number
  furthestProgress: number
  participating: Set<number>
  centerTimeMs: number | undefined
}

export class CrossingDetector {
  #config: CrossingDetectorConfig
  #hot = new Uint8Array(0)
  #candidate: Candidate | undefined
  // Set when a candidate ends by completion or backstep-abort: new candidates
  // wait until every strip is non-hot, so the tail of the same wave cannot
  // re-trigger. Expiry re-arms immediately (spec: partial-traversal reset).
  #awaitingQuiet = false
  #holdoffUntilMs = -Infinity
  #crossingInProgress = false

  constructor(config: Partial<CrossingDetectorConfig> = {}) {
    this.#config = validateConfig({ ...DEFAULT_CROSSING_DETECTOR_CONFIG, ...config })
  }

  get config(): CrossingDetectorConfig {
    return { ...this.#config }
  }

  // Drives DetectionPipeline.setPause (next-frame effect): true from candidate
  // start until completion/expiry/rejection, hard-capped at maxPauseMs.
  get crossingInProgress(): boolean {
    return this.#crossingInProgress
  }

  // Takes effect on the next sample. Hot states, any live candidate, and the
  // transient holdoff carry over (a triggerLevel change simply re-evaluates
  // hysteresis against the new levels next frame).
  updateConfig(partial: Partial<CrossingDetectorConfig>): void {
    this.#config = validateConfig({ ...this.#config, ...partial })
  }

  reset(): void {
    this.#hot.fill(0)
    this.#candidate = undefined
    this.#awaitingQuiet = false
    this.#holdoffUntilMs = -Infinity
    this.#crossingInProgress = false
  }

  // Strip-count agnostic: reads the strip count off each sample's arrays; a
  // count change resets all per-strip and candidate state (the time-based
  // transient holdoff survives — it models the camera, not the strips).
  onSample(sample: FrameSample): CrossingEvent[] {
    const { captureTimeMs: t, energies, stripPixelCounts } = sample
    const n = energies.length
    if (stripPixelCounts.length !== n) {
      throw new Error(
        `FrameSample arrays disagree: ${n} energies vs ${stripPixelCounts.length} stripPixelCounts`,
      )
    }
    if (this.#hot.length !== n) {
      this.#hot = new Uint8Array(n)
      this.#candidate = undefined
      this.#awaitingQuiet = false
    }

    const cfg = this.#config
    const exitLevel = cfg.triggerLevel * cfg.hysteresisRatio
    let nonzeroStrips = 0
    let anyHot = false
    const newlyHot: number[] = []
    for (let i = 0; i < n; i++) {
      const pixels = stripPixelCounts[i]
      if (pixels === 0) {
        // Zero-pixel strips are never hot (div-by-zero guard).
        this.#hot[i] = 0
        continue
      }
      nonzeroStrips++
      const level = energies[i] / pixels
      if (this.#hot[i]) {
        if (level < exitLevel) this.#hot[i] = 0
      } else if (level >= cfg.triggerLevel) {
        this.#hot[i] = 1
        newlyHot.push(i)
      }
      if (this.#hot[i]) anyHot = true
    }

    if (nonzeroStrips > 0 && newlyHot.length >= cfg.transientStripFraction * nonzeroStrips) {
      // Global transient: not a wave. Cancel and hold off; crossingInProgress
      // drops so the caller unpauses the EMA and it re-adapts.
      this.#candidate = undefined
      this.#holdoffUntilMs = t + cfg.transientHoldoffMs
      this.#crossingInProgress = false
      return []
    }

    if (this.#awaitingQuiet && !anyHot) this.#awaitingQuiet = false

    if (this.#candidate && t < this.#candidate.startTimeMs) {
      // Timestamp regression: clamp the candidate start down so elapsed time
      // never goes negative — a regressed clock must not extend the
      // maxTraversalMs expiry or the maxPauseMs anti-freeze cap.
      this.#candidate.startTimeMs = t
    }
    if (this.#candidate && t - this.#candidate.startTimeMs > cfg.maxTraversalMs) {
      this.#candidate = undefined
    }

    const events: CrossingEvent[] = []
    if (this.#candidate) {
      const event = this.#progressCandidate(this.#candidate, t, n)
      if (event) events.push(event)
    } else if (!this.#awaitingQuiet && t >= this.#holdoffUntilMs) {
      const direction = this.#candidateStartDirection(newlyHot, n)
      if (direction) {
        const candidate: Candidate = {
          direction,
          startTimeMs: t,
          furthestProgress: -1,
          participating: new Set(),
          centerTimeMs: undefined,
        }
        this.#candidate = candidate
        // The start frame runs the same progression step: leading edge,
        // participation, and (for degenerate geometries) center/completion.
        const event = this.#progressCandidate(candidate, t, n)
        if (event) events.push(event)
      }
    }

    this.#crossingInProgress =
      this.#candidate !== undefined && t - this.#candidate.startTimeMs <= cfg.maxPauseMs
    return events
  }

  // A newly-hot strip inside either entry zone starts a candidate; the strip
  // closest to its own edge wins, ltr winning exact ties (deterministic; the
  // simultaneous-blobs known limitation lives here).
  #candidateStartDirection(newlyHot: readonly number[], n: number): CrossingDirection | undefined {
    const entryZone = Math.min(this.#config.entryZoneStrips, n)
    let best: { direction: CrossingDirection; edgeDistance: number } | undefined
    for (const i of newlyHot) {
      const leftDistance = i
      const rightDistance = n - 1 - i
      if (leftDistance < entryZone && (best === undefined || leftDistance < best.edgeDistance)) {
        best = { direction: 'ltr', edgeDistance: leftDistance }
      }
      if (rightDistance < entryZone && (best === undefined || rightDistance < best.edgeDistance)) {
        best = { direction: 'rtl', edgeDistance: rightDistance }
      }
    }
    return best?.direction
  }

  #progressCandidate(candidate: Candidate, t: number, n: number): CrossingEvent | undefined {
    const cfg = this.#config
    let frameLeading = -1
    for (let i = 0; i < n; i++) {
      if (!this.#hot[i]) continue
      candidate.participating.add(i)
      const progress = candidate.direction === 'ltr' ? i : n - 1 - i
      if (progress > frameLeading) frameLeading = progress
    }
    if (frameLeading < 0) {
      // Wave vanished. All strips are non-hot, so the detector is already
      // quiet — re-armed immediately.
      this.#candidate = undefined
      return undefined
    }
    if (frameLeading < candidate.furthestProgress - cfg.maxBackstepStrips) {
      this.#candidate = undefined
      this.#awaitingQuiet = true
      return undefined
    }
    if (frameLeading > candidate.furthestProgress) candidate.furthestProgress = frameLeading
    if (candidate.centerTimeMs === undefined && candidate.furthestProgress >= Math.floor(n / 2)) {
      candidate.centerTimeMs = t
    }
    const entryZone = Math.min(cfg.entryZoneStrips, n)
    if (candidate.furthestProgress < n - entryZone) return undefined

    // Leading edge reached the far entry zone: the candidate ends here either
    // way; plausibility decides whether it emits.
    this.#candidate = undefined
    this.#awaitingQuiet = true
    if (t - candidate.startTimeMs < cfg.minTraversalMs) return undefined
    if (candidate.participating.size < cfg.minParticipatingStrips) return undefined
    return { timestampMs: candidate.centerTimeMs ?? t, direction: candidate.direction }
  }
}

export interface PausableFrameSource extends FrameSource {
  setPause(paused: boolean): void
}

// Composition helper for the /lab test-mode wiring: subscribes the detector
// to the pipeline's sample stream and drives the EMA pause from
// crossingInProgress. setPause is a direct same-thread parameter, so the
// pause lands on the NEXT processed frame (ADR 0009 amendment). Stop via
// pipeline.stop(), as usual.
export function attachDetectorToPipeline(
  pipeline: PausableFrameSource,
  detector: CrossingDetector,
  onCrossing: (event: CrossingEvent) => void,
): void {
  pipeline.start((sample) => {
    const events = detector.onSample(sample)
    pipeline.setPause(detector.crossingInProgress)
    for (const event of events) onCrossing(event)
  })
}
