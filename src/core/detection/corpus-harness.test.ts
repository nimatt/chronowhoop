// Pins for the corpus harness's SCORING semantics (Phase 4 mutation-audit
// follow-up): synthetic in-memory CorpusEntries — SyntheticSource pixels →
// encodeClip — with hand-written annotations, so every match/tolerance/tier
// rule in detection.md "Corpus match tolerance" is asserted against
// hand-computed expectations, independent of the committed fixtures
// (corpus.test.ts stays the CI gate over fixtures/).

import { describe, expect, it } from 'vitest'
import type { CrossingEvent } from './crossing-events'
import type { LumaFrame } from './types'
import {
  ANNOTATION_FORMAT_VERSION,
  type ClipAnnotation,
  type ClipCrossing,
  type ClipTier,
} from './annotation'
import { decodeClip, encodeClip } from './clip-format'
import { ClipSource } from './clip-source'
import { DetectionPipeline } from './pipeline'
import { CrossingDetector, attachDetectorToPipeline } from './crossing-detector'
import { SyntheticSource, type SyntheticSourceOptions } from './synthetic-source'
import { runCorpus, type CorpusEntry, type CorpusRunConfig } from './corpus-harness'

function makeClipBytes(options: SyntheticSourceOptions): Uint8Array {
  const source = new SyntheticSource(options)
  const frames: LumaFrame[] = []
  source.start((frame) => frames.push(frame))
  source.pumpAll()
  return encodeClip(frames)
}

// 60×24 px → 12 strips of exactly 5 columns (120 px each). A 5-px blob hops
// one full strip per 10 ms frame: strip k is fully hot (120/120 = 1.0
// normalized) on frame 3 + k. Hand-derived detector trajectory at defaults:
// candidate starts on frame 3 (strip 0, entry zone), the leading edge reaches
// the center boundary (strip 6 = floor(12/2)) on frame 9, and the far entry
// zone (strip 10) on frame 13 — exactly one event
// { timestampMs: 90, direction: 'ltr' }. Uniform 10 ms pacing → the median
// frame interval (the match tolerance) is exactly 10 ms.
const CROSSING_CLIP: SyntheticSourceOptions = {
  width: 60,
  height: 24,
  frameCount: 20,
  frameIntervalMs: 10,
  backgroundLevel: 32,
  blob: { widthPx: 5, intensity: 240, speedPxPerFrame: 5, direction: 1, startFrame: 2 },
}
const EMITTED_TIME_MS = 90
const EMITTED_FRAME_INDEX = 9

// Same geometry with a 1-px blob (startCenterX 2 → column 5k + 2 on frame
// 2 + k): each occupied strip reads 24/120 = 0.2 normalized — above the 0.1
// default trigger, below 0.3. Candidate starts on frame 2, center boundary on
// frame 8, completes on frame 12 → one event { timestampMs: 80, direction:
// 'ltr' } iff the detector's EFFECTIVE triggerLevel is ≤ 0.2.
const FAINT_CLIP: SyntheticSourceOptions = {
  ...CROSSING_CLIP,
  blob: {
    widthPx: 1,
    intensity: 240,
    speedPxPerFrame: 5,
    direction: 1,
    startFrame: 2,
    startCenterX: 2,
  },
}
const FAINT_FRAME_INDEX = 8

const crossingClipBytes = makeClipBytes(CROSSING_CLIP)
const faintClipBytes = makeClipBytes(FAINT_CLIP)

function annotation(tier: ClipTier, crossings: ClipCrossing[]): ClipAnnotation {
  return { formatVersion: ANNOTATION_FORMAT_VERSION, tier, crossings }
}

function runOne(
  clipBytes: Uint8Array,
  ann: ClipAnnotation,
  config?: CorpusRunConfig,
): ReturnType<typeof runCorpus>[number] {
  const entry: CorpusEntry = { name: 'synthetic', clipBytes, annotation: ann }
  return runCorpus([entry], config)[0]
}

describe('corpus harness — synthetic clip anchor', () => {
  it('the crossing clip emits exactly one ltr event at 90 ms (hand-computed above)', () => {
    const { frames } = decodeClip(crossingClipBytes)
    const source = new ClipSource(frames)
    const pipeline = new DetectionPipeline(source)
    const events: CrossingEvent[] = []
    attachDetectorToPipeline(pipeline, new CrossingDetector(), (event) => events.push(event))
    source.pumpAll()
    pipeline.stop()
    expect(events).toEqual([{ timestampMs: EMITTED_TIME_MS, direction: 'ltr' }])
  })
})

describe('corpus harness — match tolerance', () => {
  it('matches an annotation exactly at the emitted frame', () => {
    const result = runOne(
      crossingClipBytes,
      annotation('must-pass', [{ frameIndex: EMITTED_FRAME_INDEX, direction: 'ltr' }]),
    )
    expect(result).toMatchObject({
      matched: 1,
      missed: 0,
      falsePositives: 0,
      pass: true,
      unexpectedPass: false,
    })
  })

  it('matches an annotation one frame off (|90 − 100| = 10 ≤ the 10 ms tolerance, inclusive)', () => {
    const result = runOne(
      crossingClipBytes,
      annotation('must-pass', [{ frameIndex: EMITTED_FRAME_INDEX + 1, direction: 'ltr' }]),
    )
    expect(result).toMatchObject({ matched: 1, missed: 0, falsePositives: 0, pass: true })
  })

  it('an annotation two frames off is a miss AND leaves a false positive (|90 − 110| = 20 > 10)', () => {
    const result = runOne(
      crossingClipBytes,
      annotation('must-pass', [{ frameIndex: EMITTED_FRAME_INDEX + 2, direction: 'ltr' }]),
    )
    expect(result).toMatchObject({ matched: 0, missed: 1, falsePositives: 1, pass: false })
  })

  it('a flipped-direction annotation never matches, even at the exact timestamp', () => {
    const result = runOne(
      crossingClipBytes,
      annotation('must-pass', [{ frameIndex: EMITTED_FRAME_INDEX, direction: 'rtl' }]),
    )
    expect(result).toMatchObject({ matched: 0, missed: 1, falsePositives: 1, pass: false })
  })

  it('an unannotated emitted event is a false positive and fails a must-pass clip on its own', () => {
    const result = runOne(crossingClipBytes, annotation('must-pass', []))
    expect(result).toMatchObject({ matched: 0, missed: 0, falsePositives: 1, pass: false })
  })

  it('the tolerance is the MEDIAN frame interval — one large timestamp gap cannot widen it', () => {
    // Same clip but the last frame arrives 1000 ms late: deltas are eighteen
    // 10s and one 1010 → median 10 (mean ≈ 62.6, max 1010). The crossing
    // trajectory is untouched, so the event is still { 90, ltr }.
    const gapClipBytes = makeClipBytes({
      ...CROSSING_CLIP,
      frameJitterMs: (f) => (f === 19 ? 1000 : 0),
    })
    const twoOff = runOne(
      gapClipBytes,
      annotation('must-pass', [{ frameIndex: EMITTED_FRAME_INDEX + 2, direction: 'ltr' }]),
    )
    expect(twoOff).toMatchObject({ matched: 0, missed: 1, falsePositives: 1, pass: false })
    const oneOff = runOne(
      gapClipBytes,
      annotation('must-pass', [{ frameIndex: EMITTED_FRAME_INDEX + 1, direction: 'ltr' }]),
    )
    expect(oneOff).toMatchObject({ matched: 1, missed: 0, falsePositives: 0, pass: true })
  })

  it('a single-frame clip runs with zero tolerance and simply misses its annotation', () => {
    // One frame → no consecutive deltas → tolerance 0 ms (documented: such a
    // clip cannot contain a detectable crossing anyway — the pipeline only
    // seeds its background).
    const oneFrameBytes = makeClipBytes({ ...CROSSING_CLIP, frameCount: 1, blob: undefined })
    const result = runOne(
      oneFrameBytes,
      annotation('must-pass', [{ frameIndex: 0, direction: 'ltr' }]),
    )
    expect(result).toMatchObject({ matched: 0, missed: 1, falsePositives: 0, pass: false })
  })

  it('rejects annotations whose frameIndex is out of clip range', () => {
    const oneFrameBytes = makeClipBytes({ ...CROSSING_CLIP, frameCount: 1, blob: undefined })
    expect(() =>
      runOne(oneFrameBytes, annotation('must-pass', [{ frameIndex: 5, direction: 'ltr' }])),
    ).toThrow(/out of range/)
  })
})

describe('corpus harness — tiers and the ratchet', () => {
  it('a fully-clean known-limitation clip reports unexpectedPass (promote it!)', () => {
    const result = runOne(
      crossingClipBytes,
      annotation('known-limitation', [{ frameIndex: EMITTED_FRAME_INDEX, direction: 'ltr' }]),
    )
    expect(result).toMatchObject({
      matched: 1,
      missed: 0,
      falsePositives: 0,
      pass: true,
      unexpectedPass: true,
    })
  })

  it('a partially-clean known-limitation clip neither fails the run nor ratchets', () => {
    const result = runOne(
      crossingClipBytes,
      annotation('known-limitation', [
        { frameIndex: EMITTED_FRAME_INDEX, direction: 'ltr' },
        { frameIndex: 3, direction: 'ltr' },
      ]),
    )
    expect(result).toMatchObject({
      matched: 1,
      missed: 1,
      falsePositives: 0,
      pass: true,
      unexpectedPass: false,
    })
  })
})

describe('corpus harness — detector triggerLevel precedence (detection.md Tunables)', () => {
  const faintAnnotation = annotation('must-pass', [
    { frameIndex: FAINT_FRAME_INDEX, direction: 'ltr' },
  ])

  it('detects the 0.2-level clip at the 0.1 default trigger', () => {
    const result = runOne(faintClipBytes, faintAnnotation)
    expect(result).toMatchObject({ matched: 1, missed: 0, falsePositives: 0, pass: true })
  })

  it('config.tunables.triggerLevel reaches the detector (0.3 > 0.2 → nothing detected)', () => {
    const result = runOne(faintClipBytes, faintAnnotation, { tunables: { triggerLevel: 0.3 } })
    expect(result).toMatchObject({ matched: 0, missed: 1, falsePositives: 0, pass: false })
  })

  it('an explicit config.detector.triggerLevel overrides the tunables value', () => {
    const result = runOne(faintClipBytes, faintAnnotation, {
      tunables: { triggerLevel: 0.3 },
      detector: { triggerLevel: 0.1 },
    })
    expect(result).toMatchObject({ matched: 1, missed: 0, falsePositives: 0, pass: true })
  })

  it('an explicit config.detector.triggerLevel also overrides the tunables default', () => {
    const result = runOne(faintClipBytes, faintAnnotation, { detector: { triggerLevel: 0.3 } })
    expect(result).toMatchObject({ matched: 0, missed: 1, falsePositives: 0, pass: false })
  })
})
