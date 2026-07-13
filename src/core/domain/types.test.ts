import { describe, expect, test } from 'vitest'
import type { Course, Lap, Session } from './types'

// Pins the domain types to docs/specs/storage.md: the spec's example JSON
// literals must parse into the types. The `satisfies` checks are the real
// assertions (a shape drift fails typecheck, including excess properties);
// the runtime expects just keep vitest from reporting empty tests.
//
// The `schemaVersion` envelope is a FILE-level concern (Phase 6) and is
// deliberately not part of the domain shapes.

describe('domain types match storage.md examples', () => {
  test('Course parses the courses.json example entry', () => {
    const course = JSON.parse(`
      {
        "id": "8f14e45f-ea11-4b2a-9c96-1a6f2e6f4a01",
        "name": "Basement 3-gate",
        "direction": "ltr",
        "minLapTimeMs": 3000,
        "createdAt": "2026-07-12T09:30:00Z"
      }
    `) as Course

    expect(course satisfies Course).toEqual({
      id: '8f14e45f-ea11-4b2a-9c96-1a6f2e6f4a01',
      name: 'Basement 3-gate',
      direction: 'ltr',
      minLapTimeMs: 3000,
      createdAt: '2026-07-12T09:30:00Z',
    } satisfies Course)
  })

  test('Lap parses the sessions/<id>.json example laps verbatim', () => {
    const laps = JSON.parse(`
      [
        { "n": 1, "durationMs": 14320, "completedAt": "2026-07-12T10:06:02.310Z", "status": "valid" },
        { "n": 2, "durationMs": 13980, "completedAt": "2026-07-12T10:06:16.290Z", "status": "discarded" }
      ]
    `) as Lap[]

    expect(laps satisfies Lap[]).toHaveLength(2)
    expect(laps[0].status).toBe('valid')
    expect(laps[1].status).toBe('discarded')
  })

  test('Session matches the sessions/<id>.json example shape', () => {
    const session = {
      id: '4dd1c33a-2c11-4b5e-8e9d-52a6f0b6f102',
      courseId: '8f14e45f-ea11-4b2a-9c96-1a6f2e6f4a01',
      startedAt: '2026-07-12T10:05:00Z',
      note: 'new props, 300mah',
      detectionConfig: {
        tunables: {
          roi: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
          stripCount: 12,
          triggerLevel: 0.4,
          emaTimeConstantMs: 325,
          threshold: 25,
        },
        detector: {
          triggerLevel: 0.4,
          hysteresisRatio: 0.5,
          entryZoneStrips: 2,
          maxBackstepStrips: 1,
          minTraversalMs: 0,
          maxTraversalMs: 1500,
          minParticipatingStrips: 3,
          transientStripFraction: 0.7,
          transientHoldoffMs: 300,
          maxPauseMs: 2000,
        },
      },
      laps: [
        { n: 1, durationMs: 14320, completedAt: '2026-07-12T10:06:02.310Z', status: 'valid' },
        { n: 2, durationMs: 13980, completedAt: '2026-07-12T10:06:16.290Z', status: 'discarded' },
      ],
    } satisfies Session

    const roundTripped = JSON.parse(JSON.stringify(session)) as Session
    expect(roundTripped satisfies Session).toEqual(session)
  })
})
