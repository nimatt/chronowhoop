import { describe, expect, test } from 'vitest'
import type { Course, Lap, Session, SessionDetectionConfig } from '../domain/types'
import type { CrossingEvent } from '../detection/crossing-events'
import type { DetectionTunables } from '../detection/types'
import { DEFAULT_DETECTION_TUNABLES } from '../detection/types'
import { DEFAULT_CROSSING_DETECTOR_CONFIG } from '../detection/crossing-detector'
import { SessionEngine, type SessionEngineCallbacks } from './session-engine'

const course: Course = {
  id: 'course-1',
  name: 'Basement 3-gate',
  direction: 'ltr',
  minLapTimeMs: 3000,
  createdAt: '2026-07-12T09:30:00Z',
}

const tunables: DetectionTunables = { ...DEFAULT_DETECTION_TUNABLES, roi: { x: 0, y: 0, width: 1, height: 1 } }
const detectionConfig: SessionDetectionConfig = {
  tunables,
  detector: DEFAULT_CROSSING_DETECTOR_CONFIG,
}

const ltr = (timestampMs: number): CrossingEvent => ({ timestampMs, direction: 'ltr' })
const rtl = (timestampMs: number): CrossingEvent => ({ timestampMs, direction: 'rtl' })

interface Recorded {
  laps: { lap: Lap; session: Session }[]
  testCrossings: CrossingEvent[]
  armedStarts: number[]
}

function makeEngine(options: { nowMs?: () => number } = {}) {
  const recorded: Recorded = { laps: [], testCrossings: [], armedStarts: [] }
  const callbacks: SessionEngineCallbacks = {
    onLap: (lap, session) => recorded.laps.push({ lap, session }),
    onTestCrossing: (event) => recorded.testCrossings.push(event),
    onArmedStarted: (timestampMs) => recorded.armedStarts.push(timestampMs),
  }
  let idCounter = 0
  const engine = new SessionEngine({
    now: options.nowMs ?? (() => Date.parse('2026-07-12T10:05:00Z')),
    generateId: () => `session-${++idCounter}`,
    callbacks,
  })
  return { engine, recorded }
}

describe('mode transitions', () => {
  test('starts idle with no session', () => {
    const { engine } = makeEngine()
    expect(engine.mode).toBe('idle')
    expect(engine.session).toBeNull()
    expect(engine.inProgressLap).toBeNull()
  })

  test('startTest enters test mode without creating a session', () => {
    const { engine } = makeEngine()
    engine.startTest(course)
    expect(engine.mode).toBe('test')
    expect(engine.session).toBeNull()
  })

  test('arm creates a storage.md-shaped session', () => {
    const { engine } = makeEngine()
    engine.arm(course, detectionConfig, 'new props, 300mah')
    expect(engine.mode).toBe('armed')
    expect(engine.session).toEqual({
      id: 'session-1',
      courseId: 'course-1',
      startedAt: '2026-07-12T10:05:00.000Z',
      note: 'new props, 300mah',
      detectionConfig,
      laps: [],
    })
  })

  test('arm defaults note to empty string', () => {
    const { engine } = makeEngine()
    engine.arm(course, detectionConfig)
    expect(engine.session?.note).toBe('')
  })

  test('arm deep-snapshots the detection config (later mutation does not leak in)', () => {
    const { engine } = makeEngine()
    const live: SessionDetectionConfig = structuredClone(detectionConfig)
    engine.arm(course, live)
    live.tunables.triggerLevel = 0.9
    live.tunables.roi.x = 0.5
    live.detector.maxPauseMs = 1
    expect(engine.session?.detectionConfig.tunables.triggerLevel).toBe(tunables.triggerLevel)
    expect(engine.session?.detectionConfig.tunables.roi.x).toBe(0)
    expect(engine.session?.detectionConfig.detector.maxPauseMs).toBe(
      DEFAULT_CROSSING_DETECTOR_CONFIG.maxPauseMs,
    )
  })

  test('stop from armed goes to stopped and retains the session', () => {
    const { engine } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(1000))
    engine.onCrossing(ltr(5000))
    engine.stop()
    expect(engine.mode).toBe('stopped')
    expect(engine.session?.laps).toHaveLength(1)
  })

  test('stop from test returns to idle (nothing to retain)', () => {
    const { engine } = makeEngine()
    engine.startTest(course)
    engine.stop()
    expect(engine.mode).toBe('idle')
    expect(engine.session).toBeNull()
  })

  test('stop in idle/stopped is a no-op', () => {
    const { engine } = makeEngine()
    engine.stop()
    expect(engine.mode).toBe('idle')
    engine.arm(course, detectionConfig)
    engine.stop()
    engine.stop()
    expect(engine.mode).toBe('stopped')
  })

  test('stop with zero laps retains the empty session', () => {
    const { engine } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.stop()
    expect(engine.session?.laps).toEqual([])
  })

  test('re-arm after stop creates a NEW session object', () => {
    const { engine } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(4000))
    engine.stop()
    const first = engine.session
    engine.arm(course, detectionConfig)
    expect(engine.session).not.toBe(first)
    expect(engine.session?.id).toBe('session-2')
    expect(engine.session?.laps).toEqual([])
    expect(first?.laps).toHaveLength(1)
  })

  test('test → armed transition resets state (test crossings leak nothing)', () => {
    const { engine, recorded } = makeEngine()
    engine.startTest(course)
    engine.onCrossing(ltr(100))
    engine.onCrossing(ltr(200))
    engine.arm(course, detectionConfig)
    expect(engine.session?.laps).toEqual([])
    expect(engine.inProgressLap).toBeNull()
    // The clock has not started: the next valid crossing starts it, no lap.
    engine.onCrossing(ltr(300))
    expect(recorded.armedStarts).toEqual([300])
    expect(recorded.laps).toEqual([])
  })
})

describe('direction filter (every mode)', () => {
  test('wrong-direction crossing in test mode stays silent', () => {
    const { engine, recorded } = makeEngine()
    engine.startTest(course)
    engine.onCrossing(rtl(100))
    expect(recorded.testCrossings).toEqual([])
  })

  test('wrong direction never starts the armed clock', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(rtl(100))
    expect(recorded.armedStarts).toEqual([])
    expect(engine.inProgressLap).toBeNull()
  })

  test('wrong-direction crossing while a lap is running is ignored entirely', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(rtl(4000))
    expect(recorded.laps).toEqual([])
    engine.onCrossing(ltr(5000))
    expect(recorded.laps[0].lap.durationMs).toBe(5000)
  })

  test('an rtl course accepts rtl and ignores ltr', () => {
    const { engine, recorded } = makeEngine()
    engine.arm({ ...course, direction: 'rtl' }, detectionConfig)
    engine.onCrossing(ltr(0))
    expect(recorded.armedStarts).toEqual([])
    engine.onCrossing(rtl(100))
    expect(recorded.armedStarts).toEqual([100])
  })
})

describe('test mode', () => {
  test('every correct-direction crossing emits onTestCrossing — no debounce', () => {
    const { engine, recorded } = makeEngine()
    engine.startTest(course)
    const events = [ltr(0), ltr(200), ltr(250), ltr(10_000)]
    for (const event of events) engine.onCrossing(event)
    expect(recorded.testCrossings).toEqual(events)
  })

  test('test mode records nothing and starts no clock', () => {
    const { engine, recorded } = makeEngine()
    engine.startTest(course)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(5000))
    expect(engine.session).toBeNull()
    expect(engine.inProgressLap).toBeNull()
    expect(recorded.laps).toEqual([])
    expect(recorded.armedStarts).toEqual([])
  })
})

describe('armed lap semantics', () => {
  test('crossing before armed (idle) is ignored', () => {
    const { engine, recorded } = makeEngine()
    engine.onCrossing(ltr(0))
    engine.arm(course, detectionConfig)
    // The pre-arm crossing did not start the clock.
    expect(engine.inProgressLap).toBeNull()
    expect(recorded.armedStarts).toEqual([])
  })

  test('crossing after stop is ignored', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.stop()
    engine.onCrossing(ltr(5000))
    expect(recorded.laps).toEqual([])
    expect(engine.session?.laps).toEqual([])
  })

  test('first valid crossing starts the clock and completes no lap', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(1234))
    expect(recorded.armedStarts).toEqual([1234])
    expect(recorded.laps).toEqual([])
    expect(engine.session?.laps).toEqual([])
    expect(engine.inProgressLap?.startedAtMs).toBe(1234)
  })

  test('each subsequent valid crossing completes a lap and starts the next', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(14_320))
    engine.onCrossing(ltr(28_300))
    expect(engine.session?.laps.map((lap) => lap.durationMs)).toEqual([14_320, 13_980])
    expect(recorded.laps.map(({ lap }) => lap.n)).toEqual([1, 2])
    expect(engine.inProgressLap?.startedAtMs).toBe(28_300)
  })

  test('durations come from crossing timestamps; completedAt from the wall clock', () => {
    let wallMs = Date.parse('2026-07-12T10:06:02.310Z')
    const { engine, recorded } = makeEngine({ nowMs: () => wallMs })
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(500))
    engine.onCrossing(ltr(14_820))
    expect(recorded.laps[0].lap).toEqual({
      n: 1,
      durationMs: 14_320,
      completedAt: '2026-07-12T10:06:02.310Z',
      status: 'valid',
    })
    wallMs += 13_980
    engine.onCrossing(ltr(28_800))
    expect(recorded.laps[1].lap.completedAt).toBe('2026-07-12T10:06:16.290Z')
  })

  test('the wall clock may return a Date', () => {
    const engine = new SessionEngine({ now: () => new Date('2026-07-12T10:05:00Z') })
    engine.arm(course, detectionConfig)
    expect(engine.session?.startedAt).toBe('2026-07-12T10:05:00.000Z')
  })

  test('onLap receives the live session containing the lap', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(5000))
    expect(recorded.laps[0].session).toBe(engine.session)
    expect(recorded.laps[0].session.laps).toContain(recorded.laps[0].lap)
  })
})

describe('armed debounce', () => {
  test('a crossing closer than minLapTimeMs is ignored', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(2999))
    expect(recorded.laps).toEqual([])
    expect(engine.inProgressLap?.startedAtMs).toBe(0)
  })

  test('boundary is inclusive: exactly minLapTimeMs completes a lap', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(3000))
    expect(recorded.laps.map(({ lap }) => lap.durationMs)).toEqual([3000])
  })

  test('the window is measured from the last ACCEPTED crossing — ignored crossings do not reset it', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(2000)) // ignored
    engine.onCrossing(ltr(2900)) // ignored — still measured from 0
    engine.onCrossing(ltr(3000)) // accepted: 3000 − 0 ≥ minLapTimeMs
    expect(recorded.laps.map(({ lap }) => lap.durationMs)).toEqual([3000])
    expect(engine.inProgressLap?.startedAtMs).toBe(3000)
  })

  test('debounce also applies right after the clock-starting crossing', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(1000))
    engine.onCrossing(ltr(2000))
    expect(recorded.laps).toEqual([])
    expect(engine.inProgressLap?.startedAtMs).toBe(1000)
  })
})

describe('discardLastLap', () => {
  test('with no laps (or no session) it is a no-op returning false', () => {
    const { engine } = makeEngine()
    expect(engine.discardLastLap()).toBe(false)
    engine.arm(course, detectionConfig)
    expect(engine.discardLastLap()).toBe(false)
    engine.onCrossing(ltr(0))
    expect(engine.discardLastLap()).toBe(false)
  })

  test('marks the most recent lap discarded and returns true', () => {
    const { engine } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(4000))
    engine.onCrossing(ltr(8000))
    expect(engine.discardLastLap()).toBe(true)
    expect(engine.session?.laps.map((lap) => lap.status)).toEqual(['valid', 'discarded'])
  })

  test('discarding twice is a no-op returning false — it never reaches an earlier valid lap', () => {
    const { engine } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(4000))
    engine.onCrossing(ltr(8000))
    expect(engine.discardLastLap()).toBe(true)
    expect(engine.discardLastLap()).toBe(false)
    expect(engine.session?.laps.map((lap) => lap.status)).toEqual(['valid', 'discarded'])
  })

  test('in-progress lap timing is unaffected by a discard', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(4000))
    engine.discardLastLap()
    expect(engine.inProgressLap?.startedAtMs).toBe(4000)
    engine.onCrossing(ltr(9500))
    expect(recorded.laps[1].lap).toMatchObject({ n: 2, durationMs: 5500, status: 'valid' })
  })

  test('lap numbering counts discarded laps', () => {
    const { engine } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(4000))
    engine.discardLastLap()
    engine.onCrossing(ltr(8000))
    expect(engine.session?.laps.map((lap) => [lap.n, lap.status])).toEqual([
      [1, 'discarded'],
      [2, 'valid'],
    ])
  })

  test('works after stop (session is retained)', () => {
    const { engine } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(4000))
    engine.stop()
    expect(engine.discardLastLap()).toBe(true)
    expect(engine.session?.laps[0].status).toBe('discarded')
  })
})

describe('inProgressLap', () => {
  test('null before the clock starts, after stop, and outside armed', () => {
    const { engine } = makeEngine()
    expect(engine.inProgressLap).toBeNull()
    engine.startTest(course)
    expect(engine.inProgressLap).toBeNull()
    engine.arm(course, detectionConfig)
    expect(engine.inProgressLap).toBeNull()
    engine.onCrossing(ltr(0))
    expect(engine.inProgressLap).not.toBeNull()
    engine.stop()
    expect(engine.inProgressLap).toBeNull()
  })

  test('elapsedMs is measured from the last accepted crossing', () => {
    const { engine } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(1000))
    expect(engine.inProgressLap?.elapsedMs(1750)).toBe(750)
    engine.onCrossing(ltr(6000))
    expect(engine.inProgressLap?.elapsedMs(6100)).toBe(100)
  })

  test('stop drops the in-progress lap without recording it', () => {
    const { engine, recorded } = makeEngine()
    engine.arm(course, detectionConfig)
    engine.onCrossing(ltr(0))
    engine.onCrossing(ltr(4000))
    engine.stop()
    expect(engine.session?.laps).toHaveLength(1)
    expect(recorded.laps).toHaveLength(1)
  })
})

describe('defaults', () => {
  test('session ids default to crypto.randomUUID', () => {
    const engine = new SessionEngine({ now: () => 0 })
    engine.arm(course, detectionConfig)
    expect(engine.session?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
