/// <reference types="node" />

// End-to-end detection path (plan 04 items 2–3, 5): pixels → DetectionPipeline
// (reducer + ring buffer) → CrossingDetector, wired through
// attachDetectorToPipeline so crossingInProgress drives the EMA pause exactly
// as the /lab test mode will.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CrossingEvent } from './crossing-events'
import type { FrameSample } from './types'
import {
  CrossingDetector,
  attachDetectorToPipeline,
  type PausableFrameSource,
} from './crossing-detector'
import { DetectionPipeline } from './pipeline'
import { SyntheticSource } from './synthetic-source'
import { ClipSource } from './clip-source'
import { decodeClip } from './clip-format'
import { parseAnnotation } from './annotation'

function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../../../${relative}`, import.meta.url))
}

// The Phase 3 fixture-style scene (fixtures.test.ts): one blob fly-through
// over a quiet noisy background with timestamp jitter and a dropped frame.
function fixtureStyleSource(): SyntheticSource {
  return new SyntheticSource({
    width: 64,
    height: 36,
    frameCount: 31,
    backgroundLevel: 32,
    frameJitterMs: (f) => (f % 3) * 0.7,
    isFrameDropped: (f) => f === 20,
    noise: (x, y, f) => ((x * 31 + y * 17 + f * 13) % 5) - 2,
    blob: { widthPx: 6, intensity: 240, speedPxPerFrame: 3, direction: 1, startFrame: 2 },
  })
}

const NOMINAL_INTERVAL_MS = 1000 / 60
const MAX_JITTER_MS = 1.4
// ±1 camera frame is the spec'd accuracy bound. The pixel ground truth
// anchors on the blob CENTER reaching the midpoint while the detector stamps
// the leading EDGE reaching the center boundary — one frame apart for this
// blob geometry, inside the bound.
const ONE_FRAME_TOLERANCE_MS = NOMINAL_INTERVAL_MS + MAX_JITTER_MS

describe('SyntheticSource → DetectionPipeline → CrossingDetector', () => {
  it('detects the fixture-style crossing within ±1 frame of pixel ground truth', () => {
    const source = fixtureStyleSource()
    const groundTruth = source.groundTruth
    expect(groundTruth?.crossingFrameIndex).toBe(14)

    const pipeline = new DetectionPipeline(source)
    const detector = new CrossingDetector()
    const events: CrossingEvent[] = []
    attachDetectorToPipeline(pipeline, detector, (event) => events.push(event))
    source.pumpAll()
    pipeline.stop()

    expect(events).toHaveLength(1)
    expect(events[0].direction).toBe('ltr')
    expect(Math.abs(events[0].timestampMs - (groundTruth?.crossingTimeMs ?? NaN))).toBeLessThanOrEqual(
      ONE_FRAME_TOLERANCE_MS,
    )
    expect(detector.crossingInProgress).toBe(false)
  })
})

describe('hovering blob through the real wiring (EMA-pause contract, end-to-end)', () => {
  it('stays hot while paused, then the maxPauseMs cap releases and the EMA absorbs it', () => {
    // 60×24 px → 12 strips of 5 columns (120 px each). A stationary 5-px blob
    // parks over strip 0 (the entry zone) from frame 5 onward and never
    // leaves. Hand math at default tunables (τ ≈ 325 ms → alphaEff ≈ 0.05 per
    // 60 fps frame; diff threshold 25; blob 240 over background 32):
    // - frame 5 processes UNPAUSED (the pause lands next frame), absorbing 5%:
    //   ema ≈ 42.4, remaining diff ≈ 197.6 — strip 0 fully hot (120 pixels),
    //   candidate starts, setPause(true).
    // - Unpaused, the diff would fall to the threshold after
    //   ceil(ln(197.6/25) / (1/60s ÷ τ)) ≈ 41 more frames — around frame 46.
    // - The pause freezes the EMA until the maxPauseMs cap (500 ms ≈ 30
    //   frames, released around frame 35), so strip 0 must STILL be fully hot
    //   at frame 60 and only cool ≈ 41 frames after the release (~frame 76).
    const source = new SyntheticSource({
      width: 60,
      height: 24,
      frameCount: 110,
      backgroundLevel: 32,
      blob: {
        widthPx: 5,
        intensity: 240,
        speedPxPerFrame: 0,
        direction: 1,
        startFrame: 5,
        startCenterX: 2,
      },
    })
    const pipeline = new DetectionPipeline(source)
    const samples: FrameSample[] = []
    const pauses: boolean[] = []
    const recording: PausableFrameSource = {
      start: (onSample) =>
        pipeline.start((s) => {
          samples.push(s)
          onSample(s)
        }),
      stop: () => pipeline.stop(),
      setPause: (paused) => {
        pauses.push(paused)
        pipeline.setPause(paused)
      },
    }
    const detector = new CrossingDetector({ maxTraversalMs: 60_000, maxPauseMs: 500 })
    const events: CrossingEvent[] = []
    attachDetectorToPipeline(recording, detector, (event) => events.push(event))
    source.pumpAll()
    pipeline.stop()

    expect(events).toHaveLength(0) // a hover never completes a crossing
    const fullStrip = 5 * 24
    const stripZero = samples.map((s) => s.energies[0])
    expect(stripZero[4]).toBe(0)
    expect(stripZero[5]).toBe(fullStrip) // blob appears
    expect(pauses[4]).toBe(false)
    expect(pauses[5]).toBe(true) // candidate start engages the pause
    expect(pauses[30]).toBe(true) // elapsed ≈ 417 ms ≤ maxPauseMs 500
    expect(pauses[40]).toBe(false) // elapsed ≈ 583 ms → cap released the pause
    expect(stripZero[60]).toBe(fullStrip) // frozen background: hot well past the unpaused absorption point (~frame 46)
    expect(stripZero[samples.length - 1]).toBe(0) // after release the EMA absorbed the parked blob
    expect(detector.crossingInProgress).toBe(false)
  })
})

describe('committed fixture clip → DetectionPipeline → CrossingDetector', () => {
  it('finds the annotated crossing at frame 14 ±1 with the annotated direction', () => {
    const clipBytes = new Uint8Array(readFileSync(repoPath('fixtures/clips/synthetic-crossing-64x36.cwclip')))
    const annotation = parseAnnotation(
      readFileSync(repoPath('fixtures/annotations/synthetic-crossing-64x36.json'), 'utf8'),
    )
    expect(annotation.crossings).toHaveLength(1)
    const annotated = annotation.crossings[0]

    const { header, frames } = decodeClip(clipBytes)
    const source = new ClipSource(frames)
    const pipeline = new DetectionPipeline(source)
    const detector = new CrossingDetector()
    const events: CrossingEvent[] = []
    attachDetectorToPipeline(pipeline, detector, (event) => events.push(event))
    source.pumpAll()
    pipeline.stop()

    expect(events).toHaveLength(1)
    expect(events[0].direction).toBe(annotated.direction)
    // Map the event timestamp back to its clip frame: capture timestamps are
    // the clip's exact recorded values, passed through unchanged.
    const detectedFrameIndex = header.captureTimesMs.indexOf(events[0].timestampMs)
    expect(detectedFrameIndex).toBeGreaterThanOrEqual(0)
    expect(Math.abs(detectedFrameIndex - annotated.frameIndex)).toBeLessThanOrEqual(1)
  })
})
