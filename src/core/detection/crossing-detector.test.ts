// The executable form of detection.md "Crossing detector" (plan 04 items 1,
// 2, 5): every normative decision in the spec is pinned here against
// synthetic strip-energy sequences with mathematically-known ground truth.

import { describe, expect, it } from 'vitest'
import type { CrossingEvent } from './crossing-events'
import type { FrameSample } from './types'
import {
  CrossingDetector,
  DEFAULT_CROSSING_DETECTOR_CONFIG,
  attachDetectorToPipeline,
  type PausableFrameSource,
} from './crossing-detector'
import { generateSyntheticSequence, type SyntheticSequenceOptions } from './synthetic-sequences'
import { seededLcg } from './synthetic-source'

const INTERVAL = 1000 / 60

function runDetector(
  detector: CrossingDetector,
  samples: readonly FrameSample[],
): { events: CrossingEvent[]; cip: boolean[] } {
  const events: CrossingEvent[] = []
  const cip: boolean[] = []
  for (const sample of samples) {
    events.push(...detector.onSample(sample))
    cip.push(detector.crossingInProgress)
  }
  return { events, cip }
}

function risingEdges(cip: readonly boolean[]): number {
  let edges = 0
  let previous = false
  for (const value of cip) {
    if (value && !previous) edges++
    previous = value
  }
  return edges
}

function sequence(options: Partial<SyntheticSequenceOptions> = {}) {
  return generateSyntheticSequence({ stripCount: 12, frameCount: 40, ...options })
}

// Hand-built sample from normalized levels (1000 px per strip).
function sample(captureTimeMs: number, levels: readonly number[], pixels = 1000): FrameSample {
  return {
    captureTimeMs,
    energies: Uint32Array.from(levels.map((level) => Math.round(level * pixels))),
    stripPixelCounts: Uint32Array.from(levels.map(() => pixels)),
  }
}

describe('CrossingDetector — clean crossings', () => {
  it('detects a left-to-right wave with the center-boundary timestamp', () => {
    const { samples, groundTruth } = sequence({
      waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 }],
    })
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(1)
    expect(events[0].direction).toBe('ltr')
    // Ground truth: leading edge reaches strip floor(12/2) = 6 at frame 11.
    expect(groundTruth[0]?.crossingFrameIndex).toBe(11)
    expect(events[0].timestampMs).toBe(groundTruth[0]?.crossingTimeMs)
  })

  it('detects a right-to-left wave symmetrically', () => {
    const { samples, groundTruth } = sequence({
      waves: [{ direction: 'rtl', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 }],
    })
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(1)
    expect(events[0].direction).toBe('rtl')
    expect(events[0].timestampMs).toBe(groundTruth[0]?.crossingTimeMs)
  })

  it.each([2, 3, 3.5, 4])('tolerates race-speed strip-skipping (%s strips/frame)', (speed) => {
    const { samples, groundTruth } = sequence({
      waves: [{ direction: 'ltr', speedStripsPerFrame: speed, widthStrips: 2, startFrame: 5 }],
    })
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(1)
    expect(events[0].timestampMs).toBe(groundTruth[0]?.crossingTimeMs)
  })

  it('detects a slow crossing (0.25 strips/frame) well inside maxTraversalMs', () => {
    const { samples, groundTruth } = sequence({
      frameCount: 80,
      waves: [{ direction: 'ltr', speedStripsPerFrame: 0.25, widthStrips: 1, startFrame: 5 }],
    })
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(1)
    expect(events[0].timestampMs).toBe(groundTruth[0]?.crossingTimeMs)
  })

  it('reports both directions correctly across sequential crossings', () => {
    const { samples } = sequence({
      frameCount: 80,
      waves: [
        { direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 },
        { direction: 'rtl', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 45 },
      ],
    })
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events.map((event) => event.direction)).toEqual(['ltr', 'rtl'])
  })

  it('stamps the center-boundary frame for even and odd strip counts', () => {
    // Even N = 12: boundary between strips 5 and 6 — first frame the leading
    // edge occupies strip 6. Odd N = 13: entry into center strip 6.
    for (const stripCount of [12, 13]) {
      const { samples } = sequence({
        stripCount,
        frameCount: 30,
        waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 1, startFrame: 0 }],
      })
      const { events } = runDetector(new CrossingDetector(), samples)
      expect(events).toHaveLength(1)
      expect(events[0].timestampMs).toBe(samples[6].captureTimeMs)
    }
  })

  it('holds crossingInProgress from candidate start through completion, then releases', () => {
    const { samples } = sequence({
      waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 }],
    })
    const { cip } = runDetector(new CrossingDetector(), samples)
    // Candidate starts at frame 5 (entry strip goes hot), completes at frame
    // 15 (leading edge reaches the far entry zone, strip 10).
    expect(cip.slice(0, 5)).toEqual([false, false, false, false, false])
    expect(cip.slice(5, 15).every(Boolean)).toBe(true)
    expect(cip.slice(15).some(Boolean)).toBe(false)
  })
})

describe('CrossingDetector — robustness', () => {
  it('survives seeded random frame loss with an exact drop-aware timestamp', () => {
    const dropRng = seededLcg(3)
    const drops = Array.from({ length: 60 }, () => dropRng() < 0.2)
    // The wave's entry-zone transitions happen on frames 5–7; the seed must
    // leave at least one of them delivered or the scenario is unsolvable.
    expect(drops[5] && drops[6] && drops[7]).toBe(false)
    const { samples, groundTruth } = sequence({
      frameCount: 60,
      isFrameDropped: (f) => drops[f],
      waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 }],
    })
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(1)
    // Ground truth is drop-aware: the first DELIVERED frame at/after the
    // center boundary. The detector must stamp exactly that frame.
    expect(events[0].timestampMs).toBe(groundTruth[0]?.crossingTimeMs)
  })

  it('is robust to capture-timestamp jitter', () => {
    const { samples, groundTruth } = sequence({
      timestampJitterMs: (f) => ((f % 5) - 2) * 1.5,
      waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 }],
    })
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(1)
    expect(events[0].timestampMs).toBe(groundTruth[0]?.crossingTimeMs)
  })

  it('detects exactly once through a sub-trigger noise floor', () => {
    const { samples, groundTruth } = sequence({
      frameCount: 60,
      noiseLevel: 0.08,
      rng: seededLcg(7),
      waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 }],
    })
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(1)
    expect(events[0].timestampMs).toBe(groundTruth[0]?.crossingTimeMs)
  })

  it('hysteresis: flutter between exit and trigger levels cannot re-trigger', () => {
    // Strip 0 enters hot at 0.12, then oscillates 0.06/0.12 — always above
    // the exit level 0.5 × 0.1 = 0.05, so it stays one continuous hot state:
    // one candidate, zero events.
    const levels = (v: number) => [v, ...Array<number>(11).fill(0)]
    const samples = [
      sample(0, levels(0)),
      ...Array.from({ length: 20 }, (_, k) =>
        sample((k + 1) * INTERVAL, levels(k % 2 === 0 ? 0.12 : 0.06)),
      ),
      sample(21 * INTERVAL, levels(0)),
      sample(22 * INTERVAL, levels(0)),
    ]
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
    expect(risingEdges(cip)).toBe(1)
  })

  it('hysteresis boundary: dips below the exit level do start new candidates', () => {
    // 0.03 < exit level 0.05: the strip fully cools each dip, so each rise is
    // a fresh entry-zone transition — several candidates, still zero events.
    const levels = (v: number) => [v, ...Array<number>(11).fill(0)]
    const samples = Array.from({ length: 20 }, (_, k) =>
      sample(k * INTERVAL, levels(k % 2 === 0 ? 0.12 : 0.03)),
    )
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
    expect(risingEdges(cip)).toBeGreaterThan(1)
  })
})

describe('CrossingDetector — rejections', () => {
  it('partial traversal emits nothing and re-arms for the next wave', () => {
    const { samples, groundTruth } = sequence({
      frameCount: 80,
      waves: [
        { direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5, endFrame: 10 },
        { direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 40 },
      ],
    })
    expect(groundTruth[0]).toBeUndefined()
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(1)
    expect(events[0].timestampMs).toBe(groundTruth[1]?.crossingTimeMs)
    // The aborted candidate released the pause as soon as the wave vanished.
    expect(cip[5]).toBe(true)
    expect(cip.slice(12, 40).some(Boolean)).toBe(false)
  })

  it('rejects a completion that saw fewer than minParticipatingStrips strips', () => {
    // Width-1 wave at 11 strips/frame touches only strips 0 and 11: 2 < 3.
    const { samples } = sequence({
      waves: [{ direction: 'ltr', speedStripsPerFrame: 11, widthStrips: 1, startFrame: 5 }],
    })
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
  })

  it('rejects completions faster than a configured minTraversalMs', () => {
    const { samples } = sequence({
      waves: [{ direction: 'ltr', speedStripsPerFrame: 2, widthStrips: 2, startFrame: 5 }],
    })
    const detector = new CrossingDetector({ minTraversalMs: 500 })
    expect(runDetector(detector, samples).events).toHaveLength(0)
    // The same wave passes with the default (0, disabled).
    expect(runDetector(new CrossingDetector(), samples).events).toHaveLength(1)
  })

  it('ignores motion that starts outside the entry zones', () => {
    const { samples } = sequence({
      frameCount: 60,
      hovers: [{ strips: [5, 6], startFrame: 5 }],
    })
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
    expect(cip.some(Boolean)).toBe(false)
  })
})

describe('CrossingDetector — global-transient rejection', () => {
  it('an all-strips step produces no event and no pause', () => {
    const { samples } = sequence({ transient: { frameIndex: 10, durationFrames: 5 } })
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
    expect(cip.some(Boolean)).toBe(false)
  })

  it('cancels a live candidate and releases the pause so the EMA re-adapts', () => {
    const { samples } = sequence({
      frameCount: 60,
      waves: [{ direction: 'ltr', speedStripsPerFrame: 0.5, widthStrips: 2, startFrame: 5 }],
      transient: { frameIndex: 10 },
    })
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
    expect(cip[9]).toBe(true)
    expect(cip.slice(10).some(Boolean)).toBe(false)
  })

  it('holds off candidate starts for transientHoldoffMs, then recovers', () => {
    const { samples, groundTruth } = sequence({
      frameCount: 80,
      transient: { frameIndex: 8, durationFrames: 2 },
      waves: [
        // Enters during the ~433 ms holdoff (entry transitions ≤ frame 21):
        // suppressed, no event.
        { direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 10 },
        // Enters after the holdoff: detected normally.
        { direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 40 },
      ],
    })
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(1)
    expect(events[0].timestampMs).toBe(groundTruth[1]?.crossingTimeMs)
  })
})

describe('CrossingDetector — hover and max-pause', () => {
  it('a hover entering through the entry zone pauses until the candidate expires', () => {
    const { samples } = sequence({
      frameCount: 200,
      hovers: [{ strips: [0, 1, 2], startFrame: 5 }],
    })
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
    expect(cip[5]).toBe(true)
    expect(cip[94]).toBe(true) // elapsed ≈ 1483 ms < maxTraversalMs 1500
    expect(cip.slice(96).some(Boolean)).toBe(false) // expired
  })

  it('crossingInProgress is hard-capped at maxPauseMs even while the candidate lives', () => {
    const { samples } = sequence({
      frameCount: 200,
      hovers: [{ strips: [0, 1, 2], startFrame: 5 }],
    })
    const detector = new CrossingDetector({ maxTraversalMs: 60_000, maxPauseMs: 2000 })
    const { events, cip } = runDetector(detector, samples)
    expect(events).toHaveLength(0)
    expect(cip[120]).toBe(true) // elapsed ≈ 1917 ms ≤ maxPauseMs
    expect(cip.slice(130).some(Boolean)).toBe(false) // capped, candidate still alive
  })
})

describe('CrossingDetector — simultaneous blobs (documented known limitation)', () => {
  it('symmetric opposing blobs: instant completion is rejected on participation', () => {
    const { samples } = sequence({
      waves: [
        { direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 },
        { direction: 'rtl', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 },
      ],
    })
    // Frame 5 lights strips 0 and 11: the ltr tie-break candidate sees its
    // leading edge already in the far zone with only 2 participating strips —
    // rejected, and awaiting-quiet blocks the rest. Deterministic: no event.
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
  })

  it('an opposing blob completes a live candidate early in the candidate direction', () => {
    const { samples } = sequence({
      waves: [
        { direction: 'rtl', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 3 },
        { direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 },
      ],
    })
    // The single-wave tracker attributes the ltr blob's strips to the rtl
    // candidate: instant far-zone completion at frame 5 with the candidate's
    // direction. Deterministic; direction+debounce filtering and
    // discard-last-lap are the documented mitigation.
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(1)
    expect(events[0].direction).toBe('rtl')
    expect(events[0].timestampMs).toBe(samples[5].captureTimeMs)
  })
})

describe('CrossingDetector — lifecycle and guards', () => {
  it('reset() drops the live candidate and keeps detecting afterwards', () => {
    const { samples, groundTruth } = sequence({
      frameCount: 100,
      waves: [
        { direction: 'ltr', speedStripsPerFrame: 0.5, widthStrips: 2, startFrame: 5 },
        { direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 60 },
      ],
    })
    const detector = new CrossingDetector()
    const events: CrossingEvent[] = []
    samples.forEach((s, i) => {
      if (i === 15) {
        expect(detector.crossingInProgress).toBe(true)
        detector.reset()
        expect(detector.crossingInProgress).toBe(false)
      }
      events.push(...detector.onSample(s))
    })
    // The first wave's candidate died with reset (its remaining strips sit
    // mid-ROI, outside the entry zones); the second wave detects normally.
    expect(events).toHaveLength(1)
    expect(events[0].timestampMs).toBe(groundTruth[1]?.crossingTimeMs)
  })

  it('zero-pixel strips are never hot (div-by-zero guard)', () => {
    const detector = new CrossingDetector()
    const zeroPixelSample = (t: number): FrameSample => ({
      captureTimeMs: t,
      energies: Uint32Array.from([999, ...Array<number>(11).fill(0)]),
      stripPixelCounts: Uint32Array.from([0, ...Array<number>(11).fill(1000)]),
    })
    for (let f = 0; f < 10; f++) {
      expect(detector.onSample(zeroPixelSample(f * INTERVAL))).toHaveLength(0)
      expect(detector.crossingInProgress).toBe(false)
    }
  })

  it('still detects with a zero-pixel strip in the entry zone (enters via its neighbor)', () => {
    const { samples, groundTruth } = sequence({
      zeroPixelStrips: [0],
      waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 }],
    })
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(1)
    expect(events[0].timestampMs).toBe(groundTruth[0]?.crossingTimeMs)
  })

  it('a strip-count change resets per-strip state and keeps working', () => {
    const twelve = sequence({
      frameCount: 20,
      hovers: [{ strips: [0, 1], startFrame: 5 }],
    })
    const eight = generateSyntheticSequence({
      stripCount: 8,
      frameCount: 40,
      startTimeMs: 1000,
      waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 }],
    })
    const detector = new CrossingDetector()
    const first = runDetector(detector, twelve.samples)
    expect(first.cip[6]).toBe(true)
    const second = runDetector(detector, eight.samples)
    expect(second.events).toHaveLength(1)
    expect(second.events[0].timestampMs).toBe(eight.groundTruth[0]?.crossingTimeMs)
  })

  it('updateConfig takes effect on the next sample', () => {
    const wave = sequence({
      waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5, level: 0.2 }],
    })
    const detector = new CrossingDetector({ triggerLevel: 0.3 })
    expect(runDetector(detector, wave.samples).events).toHaveLength(0)
    detector.updateConfig({ triggerLevel: 0.1 })
    expect(runDetector(detector, wave.samples).events).toHaveLength(1)
  })

  it('validates config on construction and update', () => {
    expect(() => new CrossingDetector({ triggerLevel: 0 })).toThrow(/triggerLevel/)
    expect(() => new CrossingDetector({ hysteresisRatio: 0 })).toThrow(/hysteresisRatio/)
    expect(() => new CrossingDetector({ entryZoneStrips: 0 })).toThrow(/entryZoneStrips/)
    expect(() => new CrossingDetector({ transientStripFraction: 1.5 })).toThrow(
      /transientStripFraction/,
    )
    expect(() => new CrossingDetector({ minTraversalMs: 100, maxTraversalMs: 50 })).toThrow(
      /maxTraversalMs/,
    )
    const detector = new CrossingDetector()
    expect(() => detector.updateConfig({ maxPauseMs: -1 })).toThrow(/maxPauseMs/)
    expect(detector.config).toEqual(DEFAULT_CROSSING_DETECTOR_CONFIG)
  })

  it('rejects samples whose arrays disagree on strip count', () => {
    const detector = new CrossingDetector()
    expect(() =>
      detector.onSample({
        captureTimeMs: 0,
        energies: new Uint32Array(12),
        stripPixelCounts: new Uint32Array(11),
      }),
    ).toThrow(/disagree/)
  })
})

// Boundary pins from the Phase 4 mutation audit: every windowed or fractional
// tunable is asserted at its exact spec'd boundary with hand-built samples
// (all expected values hand-computed in the comments — never read back from
// the implementation).

function hotStrips(indices: readonly number[], level = 0.8, stripCount = 12): number[] {
  const levels = Array<number>(stripCount).fill(0)
  for (const index of indices) levels[index] = level
  return levels
}

describe('CrossingDetector — backstep tolerance boundary', () => {
  it('a leading-edge dip of exactly maxBackstepStrips (1) is tolerated flutter', () => {
    const samples = [
      sample(0, hotStrips([])),
      sample(1 * INTERVAL, hotStrips([0])), // candidate ltr, furthest 0
      sample(2 * INTERVAL, hotStrips([2, 3])), // furthest 3
      sample(3 * INTERVAL, hotStrips([2])), // dip to 2 = furthest − 1 → tolerated
      sample(4 * INTERVAL, hotStrips([6, 7])), // furthest 7 ≥ 6 → center stamped here
      sample(5 * INTERVAL, hotStrips([10])), // far entry zone → completes
    ]
    const { events } = runDetector(new CrossingDetector(), samples)
    // Participation {0, 2, 3, 6, 7, 10} ≥ 3; center frame is index 4.
    expect(events).toEqual([{ timestampMs: 4 * INTERVAL, direction: 'ltr' }])
  })

  it('a dip of two strips aborts AND awaits quiet — a pre-quiet entry transition starts nothing', () => {
    const samples = [
      sample(0, hotStrips([])),
      sample(1 * INTERVAL, hotStrips([0])), // candidate ltr, furthest 0
      sample(2 * INTERVAL, hotStrips([2, 3])), // furthest 3
      sample(3 * INTERVAL, hotStrips([1])), // dip to 1 < 3 − 1 → abort + awaiting quiet
      sample(4 * INTERVAL, hotStrips([0, 1])), // strip 0 newly hot in the entry zone: must NOT start
      sample(5 * INTERVAL, hotStrips([6, 7])),
      sample(6 * INTERVAL, hotStrips([10])), // would complete a surviving candidate
    ]
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
    expect(cip).toEqual([false, true, true, false, false, false, false])
  })
})

describe('CrossingDetector — hysteresis boundaries', () => {
  it('a strip at exactly triggerLevel goes hot (≥, not >): a whole crossing at 0.1 emits', () => {
    const samples = [
      sample(0, hotStrips([])),
      sample(1 * INTERVAL, hotStrips([0], 0.1)), // candidate starts at exactly the trigger
      sample(2 * INTERVAL, hotStrips([3, 4], 0.1)),
      sample(3 * INTERVAL, hotStrips([6], 0.1)), // center boundary
      sample(4 * INTERVAL, hotStrips([10], 0.1)), // completes; participation {0,3,4,6,10}
    ]
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(cip[1]).toBe(true)
    expect(events).toEqual([{ timestampMs: 3 * INTERVAL, direction: 'ltr' }])
  })

  it('a hot strip at exactly hysteresisRatio × triggerLevel (0.05) stays hot', () => {
    const samples = [
      sample(0, hotStrips([])),
      sample(1 * INTERVAL, hotStrips([0])),
      ...Array.from({ length: 5 }, (_, k) => sample((k + 2) * INTERVAL, hotStrips([0], 0.05))),
    ]
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
    // One continuous hot state → the candidate never aborts as all-quiet.
    expect(cip.slice(1).every(Boolean)).toBe(true)
    expect(risingEdges(cip)).toBe(1)
  })

  it('flutter down to 0.055 (just above the 0.05 exit level) cannot re-trigger', () => {
    // Pins hysteresisRatio = 0.5 itself: at 0.6 the exit level would be 0.06
    // and each 0.055 dip would cool + re-arm the strip.
    const samples = [
      sample(0, hotStrips([])),
      ...Array.from({ length: 10 }, (_, k) =>
        sample((k + 1) * INTERVAL, hotStrips([0], k % 2 === 0 ? 0.12 : 0.055)),
      ),
    ]
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
    expect(risingEdges(cip)).toBe(1)
  })

  it('just below the exit level (0.049) cools the strip and re-arms a fresh entry candidate', () => {
    const samples = [
      sample(0, hotStrips([])),
      sample(1 * INTERVAL, hotStrips([0], 0.12)), // candidate 1
      sample(2 * INTERVAL, hotStrips([0], 0.049)), // cools → all-quiet abort
      sample(3 * INTERVAL, hotStrips([0], 0.12)), // fresh entry transition → candidate 2
    ]
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
    expect(cip).toEqual([false, true, false, true])
  })
})

describe('CrossingDetector — global-transient fraction boundary', () => {
  it('9 of 12 newly-hot strips rejects as a transient; 8 does not (ceil(0.7 × 12) = 9)', () => {
    const start = [sample(0, hotStrips([]))]
    const nine = runDetector(new CrossingDetector(), [
      ...start,
      sample(INTERVAL, hotStrips([0, 1, 2, 3, 4, 5, 6, 7, 8])),
    ])
    expect(nine.events).toHaveLength(0)
    expect(nine.cip[1]).toBe(false) // transient: no candidate despite the entry-zone strips
    const eight = runDetector(new CrossingDetector(), [
      ...start,
      sample(INTERVAL, hotStrips([0, 1, 2, 3, 4, 5, 6, 7])),
    ])
    expect(eight.cip[1]).toBe(true) // a wave: candidate starts from strip 0
  })

  it('the fraction compare is ≥: exactly fraction × strips rejects (0.5 × 12 = 6)', () => {
    const detector = () => new CrossingDetector({ transientStripFraction: 0.5 })
    const start = [sample(0, hotStrips([]))]
    const six = runDetector(detector(), [
      ...start,
      sample(INTERVAL, hotStrips([0, 1, 2, 3, 4, 5])),
    ])
    expect(six.cip[1]).toBe(false)
    const five = runDetector(detector(), [
      ...start,
      sample(INTERVAL, hotStrips([0, 1, 2, 3, 4])),
    ])
    expect(five.cip[1]).toBe(true)
  })

  it('zero-pixel strips are excluded from the denominator (10 nonzero → threshold 7)', () => {
    const zeroPixel = (t: number, hot: readonly number[]): FrameSample => {
      const levels = hotStrips(hot)
      return {
        captureTimeMs: t,
        energies: Uint32Array.from(levels.map((level, i) => (i === 6 || i === 7 ? 0 : Math.round(level * 1000)))),
        stripPixelCounts: Uint32Array.from(levels.map((_, i) => (i === 6 || i === 7 ? 0 : 1000))),
      }
    }
    // 8 newly hot ≥ 0.7 × 10 = 7 → transient (a 12-strip denominator would
    // put the threshold at 8.4 and wrongly start a candidate).
    const eight = runDetector(new CrossingDetector(), [
      zeroPixel(0, []),
      zeroPixel(INTERVAL, [0, 1, 2, 3, 4, 5, 8, 9]),
    ])
    expect(eight.cip[1]).toBe(false)
    // 6 newly hot < 7 → an ordinary candidate start.
    const six = runDetector(new CrossingDetector(), [
      zeroPixel(0, []),
      zeroPixel(INTERVAL, [0, 1, 2, 3, 4, 5]),
    ])
    expect(six.cip[1]).toBe(true)
  })
})

describe('CrossingDetector — re-arm after expiry', () => {
  it('expiry re-arms immediately: a fresh entry transition starts a candidate while a strip is still hot', () => {
    const samples = [
      sample(0, hotStrips([0, 1, 5])), // candidate ltr (entry strip 0); strip 5 participates
      sample(1000, hotStrips([5])), // hover keeps strip 5 hot; candidate alive (1000 ≤ 1500)
      sample(1600, hotStrips([5])), // 1600 > maxTraversalMs 1500 → expires, nothing emitted
      sample(1700, hotStrips([5, 0])), // strip 0 newly hot: NEW candidate — no all-quiet frame ever
      sample(1717, hotStrips([5, 10])), // far zone → completes: participation {0, 5, 10}
    ]
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(cip).toEqual([true, true, false, true, false])
    // Center boundary first reached on the completion frame (furthest 10 ≥ 6).
    expect(events).toEqual([{ timestampMs: 1717, direction: 'ltr' }])
  })
})

describe('CrossingDetector — transient holdoff boundary', () => {
  // Transient at t = 100 → candidate starts suppressed until t = 400
  // (transientHoldoffMs 300, re-allowed exactly AT the boundary: the
  // implemented compare is inclusive ≥).
  const scenario = (entryTimeMs: number) => [
    sample(0, hotStrips([])),
    sample(100, hotStrips([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])), // global transient
    sample(150, hotStrips([])), // everything cools
    sample(entryTimeMs, hotStrips([0])), // entry-zone transition
  ]

  it.each([
    [399, false],
    [400, true],
    [401, true],
  ])('an entry transition at t=%i ms starts a candidate: %s', (entryTimeMs, started) => {
    const { cip } = runDetector(new CrossingDetector(), scenario(entryTimeMs))
    expect(cip[3]).toBe(started)
  })
})

describe('CrossingDetector — traversal and pause window operators', () => {
  it('a completion arriving exactly at maxTraversalMs still emits ("no older than")', () => {
    const samples = [
      sample(0, hotStrips([0])), // candidate ltr at t = 0
      sample(500, hotStrips([3, 4])),
      sample(1000, hotStrips([6])), // center boundary
      sample(1500, hotStrips([10])), // far zone at elapsed exactly 1500 = maxTraversalMs
    ]
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toEqual([{ timestampMs: 1000, direction: 'ltr' }])
  })

  it('crossingInProgress holds at exactly maxPauseMs elapsed and drops just after', () => {
    const detector = new CrossingDetector({ maxTraversalMs: 60_000 })
    const hover = hotStrips([0, 1, 2])
    const samples = [sample(0, hover), sample(1000, hover), sample(2000, hover), sample(2001, hover)]
    const { events, cip } = runDetector(detector, samples)
    expect(events).toHaveLength(0)
    expect(cip).toEqual([true, true, true, false]) // 2000 ≤ 2000 holds; 2001 > 2000 releases
  })
})

describe('CrossingDetector — participation minimum boundary', () => {
  it('a completion that saw exactly minParticipatingStrips (3) distinct strips emits', () => {
    const samples = [
      sample(0, hotStrips([0])), // candidate ltr
      sample(1 * INTERVAL, hotStrips([6])), // center boundary
      sample(2 * INTERVAL, hotStrips([10])), // completes; participation {0, 6, 10} = exactly 3
    ]
    const { events } = runDetector(new CrossingDetector(), samples)
    expect(events).toEqual([{ timestampMs: 1 * INTERVAL, direction: 'ltr' }])
  })
})

describe('CrossingDetector — entry-zone boundary', () => {
  it.each([
    [1, true], // inside the 2-strip left zone
    [2, false], // first strip outside it
    [10, true], // inside the right zone
    [9, false],
  ])('a quiet-state transition at strip %i starts a candidate: %s', (strip, started) => {
    const { cip } = runDetector(new CrossingDetector(), [sample(0, hotStrips([strip]))])
    expect(cip[0]).toBe(started)
  })
})

describe('CrossingDetector — timestamp-regression clamp', () => {
  it('a regressed timestamp pulls the candidate start down: maxPauseMs counts from the regressed time', () => {
    const detector = new CrossingDetector({ maxTraversalMs: 60_000 })
    const hover = hotStrips([0, 1, 2])
    const samples = [
      sample(1000, hover), // candidate starts at t = 1000
      sample(500, hover), // regression → start clamped down to 500
      sample(2500, hover), // elapsed 2000 from the CLAMPED start → still ≤ maxPauseMs
      sample(2501, hover), // 2001 > 2000 → pause released (unclamped elapsed would be 1501)
    ]
    const { events, cip } = runDetector(detector, samples)
    expect(events).toHaveLength(0)
    expect(cip).toEqual([true, true, true, false])
  })

  it('the clamp also keeps maxTraversalMs from being extended by a regression', () => {
    const hover = hotStrips([0, 1, 2])
    const samples = [
      sample(1000, hover), // candidate starts at t = 1000
      sample(500, hover), // regression → start clamped down to 500
      sample(2100, hover), // elapsed 1600 from the clamped start > 1500 → expired
    ]
    const { events, cip } = runDetector(new CrossingDetector(), samples)
    expect(events).toHaveLength(0)
    expect(cip).toEqual([true, true, false])
  })
})

describe('CrossingDetector — dropped frames over the timestamp anchor', () => {
  it.each([[[11]], [[10, 11]]])(
    'stamps the first DELIVERED frame at/past the center boundary when frames %j drop',
    (droppedFrames) => {
      const dropped = new Set(droppedFrames)
      const { samples, groundTruth } = sequence({
        isFrameDropped: (f) => dropped.has(f),
        waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 }],
      })
      // Undropped, the leading edge reaches strip 6 = floor(12/2) on frame 11;
      // with frame 11 (and 10) dropped, the first delivered frame at/past the
      // boundary is 12 — hand-computed, and the generator must agree.
      expect(groundTruth[0]).toEqual({
        direction: 'ltr',
        crossingFrameIndex: 12,
        crossingTimeMs: 12 * INTERVAL,
      })
      const { events } = runDetector(new CrossingDetector(), samples)
      expect(events).toHaveLength(1)
      expect(events[0].timestampMs).toBe(12 * INTERVAL)
    },
  )
})

class FakePipeline implements PausableFrameSource {
  #onSample: ((sample: FrameSample) => void) | undefined
  readonly pauses: boolean[] = []

  start(onSample: (sample: FrameSample) => void): void {
    this.#onSample = onSample
  }

  stop(): void {
    this.#onSample = undefined
  }

  setPause(paused: boolean): void {
    this.pauses.push(paused)
  }

  emit(sample: FrameSample): void {
    if (!this.#onSample) throw new Error('emit before start')
    this.#onSample(sample)
  }
}

describe('attachDetectorToPipeline', () => {
  it('forwards samples, drives setPause from crossingInProgress, and emits crossings', () => {
    const { samples, groundTruth } = sequence({
      waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 }],
    })
    const pipeline = new FakePipeline()
    const detector = new CrossingDetector()
    const crossings: CrossingEvent[] = []
    attachDetectorToPipeline(pipeline, detector, (event) => crossings.push(event))
    for (const s of samples) pipeline.emit(s)

    expect(crossings).toHaveLength(1)
    expect(crossings[0].timestampMs).toBe(groundTruth[0]?.crossingTimeMs)
    // setPause is driven once per sample: engaged for the candidate frames
    // (5–14), released on the completion frame.
    expect(pipeline.pauses).toHaveLength(samples.length)
    expect(pipeline.pauses.slice(0, 5).some(Boolean)).toBe(false)
    expect(pipeline.pauses.slice(5, 15).every(Boolean)).toBe(true)
    expect(pipeline.pauses.slice(15).some(Boolean)).toBe(false)
  })
})
