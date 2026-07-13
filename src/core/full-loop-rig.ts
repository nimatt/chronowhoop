// Shared test rig for the full-loop tests (extracted from full-loop.test.ts
// when plan 06 item 5's never-block proof needed a second consumer): the
// pixels → detector → SessionEngine → records → Announcer chain the armed
// screen wires, plus the canonical deterministic clip scenario. Not a test
// file itself — full-loop.test.ts pins the baseline semantics and
// full-loop-storage.test.ts replays the identical scenario with storage
// attached.

import {
  Announcer,
  announceCompletedLap,
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
import { SyntheticSource } from './detection/synthetic-source'
import {
  DEFAULT_DETECTION_TUNABLES,
  type DetectionTunables,
  type LumaFrame,
} from './detection/types'
import type { Course, Lap, Session, SessionDetectionConfig } from './domain/types'
import { SessionEngine } from './session/session-engine'

export const FRAME_INTERVAL_MS = 20

// The hand math below depends on these values, so they are pinned here rather
// than inherited from defaults that may be retuned later.
export const TUNABLES: DetectionTunables = {
  ...DEFAULT_DETECTION_TUNABLES,
  stripCount: 12,
  threshold: 25,
  triggerLevel: 0.1,
}

export const DETECTOR_CONFIG: CrossingDetectorConfig = {
  ...DEFAULT_CROSSING_DETECTOR_CONFIG,
  triggerLevel: 0.1,
  hysteresisRatio: 0.5,
  entryZoneStrips: 2,
  minParticipatingStrips: 3,
  maxTraversalMs: 1500,
}

export const DETECTION_CONFIG: SessionDetectionConfig = {
  tunables: TUNABLES,
  detector: DETECTOR_CONFIG,
}

export function courseFixture(): Course {
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
export class FakeSpeaker implements Speaker {
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

export interface SessionRig {
  engine: SessionEngine
  announcer: Announcer
  speaker: FakeSpeaker
  laps: Lap[]
  armedStarts: number[]
}

export interface SessionRigHooks {
  // The plan 06 never-block seam: invoked on every completed lap BEFORE the
  // announcement, exactly where the armed screen calls the persister — if the
  // hook blocked, threw, or awaited, the announcement decisions would diverge
  // from the hookless baseline and full-loop-storage.test.ts would fail.
  onLap?: (lap: Lap, session: Session) => void
}

// The onLap hookup the armed screen makes, via the SAME shared function
// (announceCompletedLap) — the rig cannot silently drift from the product
// wiring.
export function createArmedSessionRig(course: Course, hooks: SessionRigHooks = {}): SessionRig {
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
        hooks.onLap?.(lap, session)
        announceCompletedLap(announcer, lap, session.laps)
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
export function crossingSegmentFrames(startTimeMs: number): LumaFrame[] {
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

export const SEGMENT_CROSSING_OFFSET_MS = 13 * FRAME_INTERVAL_MS

// The canonical clip scenario (5 same-direction fly-throughs; course
// minLapTime 3000 ms) shared by the baseline and storage-variant tests:
//
//   segment start | crossing (start+260) | session effect
//   --------------|----------------------|--------------------------------
//          2000   |        2260          | arms the clock (no lap)
//         16000   |       16260          | lap 1: 14000 ms
//         29000   |       29260          | lap 2: 13000 ms
//         31000   |       31260          | 2000 ms < 3000 → debounced, and
//                 |                      | it does NOT reset the window
//         45000   |       45260          | lap 3: 45260−29260 = 16000 ms
export const CLIP_SEGMENT_STARTS_MS = [2000, 16000, 29000, 31000, 45000]

export interface ClipRunResult {
  frameCount: number
  events: CrossingEvent[]
}

// Encodes the canonical clip, decodes it back, and pumps it through pipeline
// → detector → the rig's SessionEngine. Fully synchronous and deterministic.
export function runCanonicalClip(rig: SessionRig): ClipRunResult {
  const clipBytes = encodeClip(CLIP_SEGMENT_STARTS_MS.flatMap(crossingSegmentFrames))
  const { header, frames } = decodeClip(clipBytes)
  const source = new ClipSource(frames)
  const pipeline = new DetectionPipeline(source, TUNABLES)
  const detector = new CrossingDetector(DETECTOR_CONFIG)
  const events: CrossingEvent[] = []
  attachDetectorToPipeline(pipeline, detector, (event) => {
    events.push(event)
    rig.engine.onCrossing(event)
  })
  source.pumpAll()
  pipeline.stop()
  return { frameCount: header.frameCount, events }
}
