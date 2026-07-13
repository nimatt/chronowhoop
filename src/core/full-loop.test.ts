// Full-loop CI test (plan 05 item 8, ADR 0009: no GPU leg — both variants run
// in plain node): pixels/energies → detector → SessionEngine → records →
// Announcer, the exact chain the armed screen wires. Everything is
// deterministic — 20 ms frame intervals and integer segment offsets keep every
// timestamp an integer, so assertions are exact equality, and the FakeSpeaker
// settles only when the test says so (no timers anywhere).
//
// The rig (SessionEngine + Announcer wiring, fixtures, and the canonical clip
// scenario) lives in full-loop-rig.ts, shared with the plan 06 never-block
// storage variant (full-loop-storage.test.ts).
//
// Clip variant (canonical): synthetic luma segments → encodeClip → decodeClip
// → ClipSource → DetectionPipeline (reducer + EMA pause) →
// attachDetectorToPipeline → CrossingDetector → SessionEngine → Announcer.
// Energy variant (fast twin): generateSyntheticSequence strip energies →
// CrossingDetector directly → the same SessionEngine + Announcer rig.

import { describe, expect, test } from 'vitest'
import { CrossingDetector } from './detection/crossing-detector'
import type { CrossingEvent } from './detection/crossing-events'
import { generateSyntheticSequence } from './detection/synthetic-sequences'
import {
  CLIP_SEGMENT_STARTS_MS,
  DETECTOR_CONFIG,
  FRAME_INTERVAL_MS,
  SEGMENT_CROSSING_OFFSET_MS,
  courseFixture,
  createArmedSessionRig,
  runCanonicalClip,
} from './full-loop-rig'
import { sessionRecords } from './records/records'

describe('full loop, clip variant: clip bytes → pipeline → detector → session → announcer', () => {
  // Scenario: CLIP_SEGMENT_STARTS_MS in full-loop-rig.ts (5 same-direction
  // fly-throughs; course minLapTime 3000 ms — arms at 2260, laps of 14000,
  // 13000, 16000 ms, with the 31260 crossing debounced).
  //
  // Announcements (Wave A semantics — the first valid lap is never "best"):
  //   lap 1 → "14 0", lap 2 → "best 13 0" (13000 < 14000),
  //   lap 3 → "16 0" (best-three is the FIRST-ever window → not announced).
  // The FakeSpeaker settles nothing while the clip pumps, so "14 0" is still
  // in flight when laps 2 and 3 land:
  //   "14 0" spoken-immediately; "best 13 0" queued; lap 3 arrives →
  //   "best 13 0" dropped-stale, "16 0" queued; settle → "16 0" spoken.
  test('lap semantics, debounce, discard, stop, and exact announcement decisions', async () => {
    const expectedCrossingsMs = CLIP_SEGMENT_STARTS_MS.map((s) => s + SEGMENT_CROSSING_OFFSET_MS)

    const rig = createArmedSessionRig(courseFixture())
    const { frameCount, events } = runCanonicalClip(rig)
    expect(frameCount).toBe(5 * 40)

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
