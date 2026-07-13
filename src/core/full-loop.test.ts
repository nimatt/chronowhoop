// Full-loop CI test (plan 05 item 8, ADR 0009: no GPU leg — both variants run
// in plain node): pixels/energies → detector → SessionEngine → records →
// Announcer, the exact chain the armed screen wires. Everything is
// deterministic — 20 ms frame intervals and integer segment offsets keep every
// timestamp an integer, so assertions are exact equality, and the FakeSpeaker
// settles only when the test says so (no timers anywhere).
//
// Clip variant (canonical): synthetic luma segments → encodeClip → decodeClip
// → ClipSource → DetectionPipeline (reducer + EMA pause) →
// attachDetectorToPipeline → CrossingDetector → SessionEngine → Announcer.
// Energy variant (fast twin): generateSyntheticSequence strip energies →
// CrossingDetector directly → the same SessionEngine + Announcer rig.

import { describe, expect, test } from 'vitest'
import {
  Announcer,
  computeAnnouncementRecords,
  type Speaker,
  type SpeakerHandle,
} from './announcer/announcer'
import { decodeClip, encodeClip } from './detection/clip-format'
import { ClipSource } from './detection/clip-source'
import {
  CrossingDetector,
  DEFAULT_CROSSING_DETECTOR_CONFIG,
  attachDetectorToPipeline,
  type CrossingDetectorConfig,
} from './detection/crossing-detector'
import type { CrossingEvent } from './detection/crossing-events'
import { DetectionPipeline } from './detection/pipeline'
import { generateSyntheticSequence } from './detection/synthetic-sequences'
import { SyntheticSource } from './detection/synthetic-source'
import {
  DEFAULT_DETECTION_TUNABLES,
  type DetectionTunables,
  type LumaFrame,
} from './detection/types'
import type { Course, Lap, SessionDetectionConfig } from './domain/types'
import { sessionRecords } from './records/records'
import { SessionEngine } from './session/session-engine'

const FRAME_INTERVAL_MS = 20

// The hand math below depends on these values, so they are pinned here rather
// than inherited from defaults that may be retuned later.
const TUNABLES: DetectionTunables = {
  ...DEFAULT_DETECTION_TUNABLES,
  stripCount: 12,
  threshold: 25,
  triggerLevel: 0.1,
}

const DETECTOR_CONFIG: CrossingDetectorConfig = {
  ...DEFAULT_CROSSING_DETECTOR_CONFIG,
  triggerLevel: 0.1,
  hysteresisRatio: 0.5,
  entryZoneStrips: 2,
  minParticipatingStrips: 3,
  maxTraversalMs: 1500,
}

const DETECTION_CONFIG: SessionDetectionConfig = {
  tunables: TUNABLES,
  detector: DETECTOR_CONFIG,
}

function courseFixture(): Course {
  return {
    id: 'course-full-loop',
    name: 'Full-loop test course',
    direction: 'ltr',
    minLapTimeMs: 3000,
    createdAt: '2026-07-13T09:00:00.000Z',
  }
}

// Speaker fake with test-controlled settle timing: nothing settles until the
// test calls settleNext(), so an utterance stays in flight across as many lap
// events as the test wants — that is how the queue policy is exercised.
class FakeSpeaker implements Speaker {
  readonly spoken: string[] = []
  readonly #settlers: (() => void)[] = []

  speak(text: string): SpeakerHandle {
    this.spoken.push(text)
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    this.#settlers.push(settle)
    return { settled }
  }

  get inFlightCount(): number {
    return this.#settlers.length
  }

  async settleNext(): Promise<void> {
    const settle = this.#settlers.shift()
    if (!settle) throw new Error('nothing in flight to settle')
    settle()
    await Promise.resolve()
  }
}

interface SessionRig {
  engine: SessionEngine
  announcer: Announcer
  speaker: FakeSpeaker
  laps: Lap[]
  armedStarts: number[]
}

// The onLap hookup the armed screen mirrors: compute the announcement records
// from the session's lap list, format, announce. This is also the Phase 6
// seam: the plan's future never-block test wraps this onLap with a
// slow-storage fake (a persist call whose promise the test controls) and
// asserts lap emission and announcements never wait on it.
function createArmedSessionRig(course: Course): SessionRig {
  const speaker = new FakeSpeaker()
  const announcer = new Announcer(speaker)
  const laps: Lap[] = []
  const armedStarts: number[] = []
  const engine = new SessionEngine({
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    generateId: () => 'session-full-loop',
    callbacks: {
      onLap: (lap, session) => {
        laps.push(lap)
        announcer.announceLap(lap, computeAnnouncementRecords(session.laps, lap))
      },
      onArmedStarted: (timestampMs) => armedStarts.push(timestampMs),
    },
  })
  engine.arm(course, DETECTION_CONFIG)
  return { engine, announcer, speaker, laps, armedStarts }
}

// One 40-frame fly-through segment (64×36 px, 12 strips, 20 ms cadence,
// background 32): a 6 px blob at intensity 200 enters at frame 2 moving +3
// px/frame. Painted columns at frame f are [3f−12, 3f−7], so with strip
// boundaries at x = ceil(16s/3) (strip 6 starts at x=32, strip 10 at x=54):
// - frame 3: columns 0–2 appear → strip 0 hot → ltr candidate starts;
// - frame 13: column 32 goes hot → leading edge reaches strip 6 = ⌊12/2⌋, the
//   center boundary → the crossing timestamp is startTimeMs + 13·20 = +260 ms
//   (pixel ground truth — blob CENTER at the midpoint — is frame 14; the
//   detector stamps the leading EDGE, one frame earlier for this geometry);
// - frame 21: column 54 hot → far entry zone (strip 10) → completion;
// - frame 25: last blob column (x=63) leaves; frame 26 is fully quiet →
//   re-armed with 13 background frames to spare before the segment ends.
// Each segment starts and ends at the bare background level, so concatenated
// segments keep EMA continuity without re-seeding (the ≥13 s gap between
// segments is dt-clamped to 1000 ms and background equals background anyway).
function crossingSegmentFrames(startTimeMs: number): LumaFrame[] {
  const source = new SyntheticSource({
    width: 64,
    height: 36,
    frameCount: 40,
    frameIntervalMs: FRAME_INTERVAL_MS,
    startTimeMs,
    backgroundLevel: 32,
    blob: { widthPx: 6, intensity: 200, speedPxPerFrame: 3, direction: 1, startFrame: 2 },
  })
  const frames: LumaFrame[] = []
  source.start((frame) => frames.push(frame))
  source.pumpAll()
  return frames
}

const SEGMENT_CROSSING_OFFSET_MS = 13 * FRAME_INTERVAL_MS

describe('full loop, clip variant: clip bytes → pipeline → detector → session → announcer', () => {
  // Scenario (5 same-direction fly-throughs; course minLapTime 3000 ms):
  //
  //   segment start | crossing (start+260) | session effect
  //   --------------|----------------------|--------------------------------
  //          2000   |        2260          | arms the clock (no lap)
  //         16000   |       16260          | lap 1: 14000 ms
  //         29000   |       29260          | lap 2: 13000 ms
  //         31000   |       31260          | 2000 ms < 3000 → debounced, and
  //                 |                      | it does NOT reset the window
  //         45000   |       45260          | lap 3: 45260−29260 = 16000 ms
  //
  // Announcements (Wave A semantics — the first valid lap is never "best"):
  //   lap 1 → "14 0", lap 2 → "best 13 0" (13000 < 14000),
  //   lap 3 → "16 0" (best-three is the FIRST-ever window → not announced).
  // The FakeSpeaker settles nothing while the clip pumps, so "14 0" is still
  // in flight when laps 2 and 3 land:
  //   "14 0" spoken-immediately; "best 13 0" queued; lap 3 arrives →
  //   "best 13 0" dropped-stale, "16 0" queued; settle → "16 0" spoken.
  test('lap semantics, debounce, discard, stop, and exact announcement decisions', async () => {
    const segmentStartsMs = [2000, 16000, 29000, 31000, 45000]
    const expectedCrossingsMs = segmentStartsMs.map((s) => s + SEGMENT_CROSSING_OFFSET_MS)

    const clipBytes = encodeClip(segmentStartsMs.flatMap(crossingSegmentFrames))
    const { header, frames } = decodeClip(clipBytes)
    expect(header.frameCount).toBe(5 * 40)

    const source = new ClipSource(frames)
    const pipeline = new DetectionPipeline(source, TUNABLES)
    const detector = new CrossingDetector(DETECTOR_CONFIG)
    const rig = createArmedSessionRig(courseFixture())
    const events: CrossingEvent[] = []
    attachDetectorToPipeline(pipeline, detector, (event) => {
      events.push(event)
      rig.engine.onCrossing(event)
    })
    source.pumpAll()
    pipeline.stop()

    // Every fly-through detected, exactly at start+260, direction ltr.
    expect(events).toEqual(
      expectedCrossingsMs.map((timestampMs) => ({ timestampMs, direction: 'ltr' })),
    )

    expect(rig.armedStarts).toEqual([2260])
    expect(rig.laps.map((lap) => lap.durationMs)).toEqual([14000, 13000, 16000])
    expect(rig.laps.map((lap) => lap.n)).toEqual([1, 2, 3])
    expect(rig.laps.map((lap) => lap.status)).toEqual(['valid', 'valid', 'valid'])

    // Arrival-time decisions, exact sequence ("14 0" in flight throughout).
    expect(rig.announcer.decisions).toEqual([
      { text: '14 0', action: 'spoken-immediately' },
      { text: 'best 13 0', action: 'queued' },
      { text: 'best 13 0', action: 'dropped-stale' },
      { text: '16 0', action: 'queued' },
    ])
    expect(rig.speaker.spoken).toEqual(['14 0'])
    await rig.speaker.settleNext() // "14 0" ends → pending "16 0" speaks
    expect(rig.speaker.spoken).toEqual(['14 0', '16 0'])
    await rig.speaker.settleNext()
    expect(rig.speaker.inFlightCount).toBe(0)

    // The last accepted crossing (45260) started lap 4's timing.
    const inProgress = rig.engine.inProgressLap
    expect(inProgress?.startedAtMs).toBe(45260)
    expect(inProgress?.elapsedMs(46500)).toBe(1240)

    const session = rig.engine.session
    expect(session).not.toBeNull()
    if (session === null) throw new Error('unreachable')
    expect(sessionRecords(session.laps)).toEqual({
      bestLap: session.laps[1],
      bestThreeConsecutive: {
        laps: [session.laps[0], session.laps[1], session.laps[2]],
        totalMs: 43000,
      },
    })

    // stop() drops the in-progress lap; completed laps are retained.
    rig.engine.stop()
    expect(rig.engine.mode).toBe('stopped')
    expect(rig.engine.inProgressLap).toBeNull()
    expect(session.laps).toHaveLength(3)

    // Discarding lap 3 breaks the only best-three window; best lap survives.
    expect(rig.engine.discardLastLap()).toBe(true)
    expect(session.laps[2].status).toBe('discarded')
    expect(sessionRecords(session.laps)).toEqual({
      bestLap: session.laps[1],
      bestThreeConsecutive: undefined,
    })
  })
})

describe('full loop, energy variant: strip energies → detector → session → announcer', () => {
  // Waves at 2 strips/frame, width 3 (candidate starts the frame the leading
  // edge enters its entry strip; center boundary ⌊12/2⌋ = 6 is reached at
  // startFrame+3, i.e. crossing time = 20·(startFrame+3); completion at +5).
  //
  //   startFrame | direction | crossing | session effect
  //   -----------|-----------|----------|-----------------------------------
  //         97   |    ltr    |   2000   | arms the clock (no lap)
  //        797   |    ltr    |  16000   | lap 1: 14000 ms → "14 0"
  //        997   |    rtl    |  20000   | wrong direction → ignored entirely
  //       1422   |    ltr    |  28500   | lap 2: 12500 ms — beats 14000 →
  //              |           |          | "best 12 5"
  //       2072   |    ltr    |  41500   | lap 3: 13000 ms — not best, and
  //              |           |          | best-three is the first-ever
  //              |           |          | window → plain "13 0"
  //
  // Lap 2's duration (28500−16000) also pins that the ignored rtl crossing
  // neither completed a lap nor perturbed the timing window. Here the speaker
  // settles between laps, so every decision is spoken-immediately.
  test('wrong-direction wave ignored, best-lap improvement announced, exact texts', async () => {
    const wave = (startFrame: number, direction: 'ltr' | 'rtl') => ({
      direction,
      speedStripsPerFrame: 2,
      widthStrips: 3,
      startFrame,
    })
    const { samples, groundTruth } = generateSyntheticSequence({
      stripCount: 12,
      frameCount: 2100,
      frameIntervalMs: FRAME_INTERVAL_MS,
      waves: [wave(97, 'ltr'), wave(797, 'ltr'), wave(997, 'rtl'), wave(1422, 'ltr'), wave(2072, 'ltr')],
    })
    expect(groundTruth.map((truth) => truth?.crossingTimeMs)).toEqual([
      2000, 16000, 20000, 28500, 41500,
    ])

    const detector = new CrossingDetector(DETECTOR_CONFIG)
    const rig = createArmedSessionRig(courseFixture())
    const events: CrossingEvent[] = []
    let next = 0
    const feedUntil = (timeMs: number) => {
      while (next < samples.length && samples[next].captureTimeMs <= timeMs) {
        for (const event of detector.onSample(samples[next])) {
          events.push(event)
          rig.engine.onCrossing(event)
        }
        next++
      }
    }

    feedUntil(17000)
    expect(rig.speaker.spoken).toEqual(['14 0'])
    await rig.speaker.settleNext()

    feedUntil(30000)
    expect(rig.speaker.spoken).toEqual(['14 0', 'best 12 5'])
    await rig.speaker.settleNext()

    feedUntil(Infinity)
    expect(rig.speaker.spoken).toEqual(['14 0', 'best 12 5', '13 0'])
    await rig.speaker.settleNext()
    expect(rig.speaker.inFlightCount).toBe(0)

    // The detector reports the rtl crossing (exactly at ground truth); the
    // session's direction filter is what drops it.
    expect(events).toEqual([
      { timestampMs: 2000, direction: 'ltr' },
      { timestampMs: 16000, direction: 'ltr' },
      { timestampMs: 20000, direction: 'rtl' },
      { timestampMs: 28500, direction: 'ltr' },
      { timestampMs: 41500, direction: 'ltr' },
    ])

    expect(rig.armedStarts).toEqual([2000])
    expect(rig.laps.map((lap) => lap.durationMs)).toEqual([14000, 12500, 13000])
    expect(rig.announcer.decisions).toEqual([
      { text: '14 0', action: 'spoken-immediately' },
      { text: 'best 12 5', action: 'spoken-immediately' },
      { text: '13 0', action: 'spoken-immediately' },
    ])

    const session = rig.engine.session
    expect(session).not.toBeNull()
    if (session === null) throw new Error('unreachable')
    expect(sessionRecords(session.laps)).toEqual({
      bestLap: session.laps[1],
      bestThreeConsecutive: {
        laps: [session.laps[0], session.laps[1], session.laps[2]],
        totalMs: 39500,
      },
    })
  })
})
