import { describe, expect, it } from 'vitest'
import { CrossingDetector } from '../../core/detection/crossing-detector'
import { generateSyntheticSequence } from '../../core/detection/synthetic-sequences'
import { DEFAULT_DETECTION_TUNABLES, type FrameSample } from '../../core/detection/types'
import type { Course, Lap } from '../../core/domain/types'
import { SessionEngine } from '../../core/session/session-engine'
import {
  MIN_DETECTOR_TRIGGER_LEVEL,
  attachDetectorToCaptureSession,
  detectorTriggerLevel,
} from './detector-attachment'

// Stub capture session: a real listener registry (so detach is observable)
// plus a setPipelinePause recorder (so the pause seam is proven reached, not
// assumed).
function stubCaptureSession() {
  let listeners: Array<(sample: FrameSample) => void> = []
  const pauseCalls: boolean[] = []
  return {
    session: {
      addSampleListener(listener: (sample: FrameSample) => void) {
        listeners = [...listeners, listener]
        return () => {
          listeners = listeners.filter((candidate) => candidate !== listener)
        }
      },
      setPipelinePause(paused: boolean) {
        pauseCalls.push(paused)
      },
    },
    pump(samples: readonly FrameSample[]) {
      for (const sample of samples) {
        for (const listener of [...listeners]) listener(sample)
      }
    },
    pauseCalls,
    listenerCount: () => listeners.length,
  }
}

const COURSE: Course = {
  id: 'attach-test',
  name: 'Attach test',
  direction: 'ltr',
  minLapTimeMs: 1000,
  createdAt: new Date(0).toISOString(),
}

// Two ltr fly-throughs over 16 strips at 20 ms cadence. Generator ground
// truth: the crossing stamps at the first frame whose leading edge reaches
// strip 8, i.e. 20·(startFrame + 8) ms — 200 and 1760.
function twoWaveSequence() {
  const sequence = generateSyntheticSequence({
    stripCount: 16,
    frameCount: 130,
    frameIntervalMs: 20,
    waves: [
      { direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 3, startFrame: 2 },
      { direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 3, startFrame: 80 },
    ],
  })
  const [first, second] = sequence.groundTruth
  if (!first || !second) throw new Error('synthetic waves must both reach the center')
  return { samples: sequence.samples, first, second }
}

function armedRig() {
  const laps: Lap[] = []
  let armedStartedAtMs: number | null = null
  const engine = new SessionEngine({
    now: () => 0,
    callbacks: {
      onLap: (lap) => laps.push(lap),
      onArmedStarted: (timestampMs) => (armedStartedAtMs = timestampMs),
    },
  })
  const detector = new CrossingDetector({ triggerLevel: 0.5 })
  engine.arm(COURSE, { tunables: DEFAULT_DETECTION_TUNABLES, detector: detector.config })
  return { engine, detector, laps, armedStartedAt: () => armedStartedAtMs }
}

describe('attachDetectorToCaptureSession', () => {
  it('feeds session samples through a real detector into the engine and drives the pause seam', () => {
    const stub = stubCaptureSession()
    const { engine, detector, laps, armedStartedAt } = armedRig()
    const detach = attachDetectorToCaptureSession(stub.session, detector, (event) =>
      engine.onCrossing(event),
    )

    const { samples, first, second } = twoWaveSequence()
    stub.pump(samples)

    expect(armedStartedAt()).toBe(first.crossingTimeMs)
    expect(laps.map((lap) => lap.durationMs)).toEqual([
      second.crossingTimeMs - first.crossingTimeMs,
    ])
    // The EMA pause reached the session: paused during the candidates,
    // unpaused after the last wave completed.
    expect(stub.pauseCalls).toContain(true)
    expect(stub.pauseCalls.at(-1)).toBe(false)

    detach()
    expect(stub.listenerCount()).toBe(0)

    // A detached detector sees nothing: replaying the whole sequence adds no
    // laps — the "arm() stops attaching and the suite stays green" hole.
    stub.pump(samples)
    expect(laps.length).toBe(1)
  })

  it('detach mid-candidate un-pauses the EMA the detector left paused', () => {
    const { samples, first } = twoWaveSequence()
    const preCrossing = samples.filter((sample) => sample.captureTimeMs < first.crossingTimeMs)

    const stub = stubCaptureSession()
    const { engine, detector } = armedRig()
    const detach = attachDetectorToCaptureSession(stub.session, detector, (event) =>
      engine.onCrossing(event),
    )

    // Stop pumping mid-candidate: the detector has paused the EMA and nothing
    // will un-pause it — the un-pause must come from detach itself.
    stub.pump(preCrossing)
    expect(detector.crossingInProgress).toBe(true)
    expect(stub.pauseCalls.at(-1)).toBe(true)

    detach()
    expect(stub.pauseCalls.at(-1)).toBe(false)
    expect(stub.listenerCount()).toBe(0)
  })

  it('detector.reset() mid-candidate drops the in-flight crossing (the arm-from-test-mode fix)', () => {
    const { samples, first } = twoWaveSequence()
    const preCrossing = samples.filter((sample) => sample.captureTimeMs < first.crossingTimeMs)
    const rest = samples.filter((sample) => sample.captureTimeMs >= first.crossingTimeMs)

    // Control: pumped straight through, the first wave completes a crossing.
    {
      const stub = stubCaptureSession()
      const { engine, detector, armedStartedAt } = armedRig()
      attachDetectorToCaptureSession(stub.session, detector, (event) => engine.onCrossing(event))
      stub.pump(preCrossing)
      expect(detector.crossingInProgress).toBe(true)
      stub.pump(rest)
      expect(armedStartedAt()).toBe(first.crossingTimeMs)
    }

    // With a reset between (what fly's arm() does when the detector was
    // already attached in test mode), the pre-arm candidate must NOT complete
    // and start the armed clock.
    {
      const stub = stubCaptureSession()
      const { engine, detector, laps, armedStartedAt } = armedRig()
      attachDetectorToCaptureSession(stub.session, detector, (event) => engine.onCrossing(event))
      stub.pump(preCrossing)
      expect(detector.crossingInProgress).toBe(true)
      detector.reset()
      stub.pump(rest)
      expect(armedStartedAt()).not.toBe(first.crossingTimeMs)
      expect(laps).toEqual([])
    }
  })
})

describe('detectorTriggerLevel', () => {
  it('clamps to the smallest level CrossingDetector accepts', () => {
    expect(detectorTriggerLevel(0)).toBe(MIN_DETECTOR_TRIGGER_LEVEL)
    expect(detectorTriggerLevel(0.4)).toBe(0.4)
    expect(() => new CrossingDetector({ triggerLevel: detectorTriggerLevel(0) })).not.toThrow()
  })
})
