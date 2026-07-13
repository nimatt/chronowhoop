import { describe, expect, it } from 'vitest'
import {
  defaultAppSettings,
  migrateToCurrent,
  migrations,
  parseCoursesFile,
  parseExportEnvelope,
  parseSessionFile,
  SCHEMA_VERSION,
  SchemaError,
  SchemaVersionError,
} from './schema'

function validCourseDoc() {
  return {
    id: '8f14e45f-ea11-4b2a-9c96-1a6f2e6f4a01',
    name: 'Basement 3-gate',
    direction: 'ltr',
    minLapTimeMs: 3000,
    createdAt: '2026-07-12T09:30:00Z',
  }
}

function validCoursesFileDoc() {
  return {
    schemaVersion: 1,
    courses: [validCourseDoc()],
    settings: { speechEnabled: true },
  }
}

function validSessionFileDoc() {
  return {
    schemaVersion: 1,
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
  }
}

function validEnvelopeDoc() {
  const { schemaVersion, ...session } = validSessionFileDoc()
  return {
    schemaVersion,
    exportedAt: '2026-07-12T18:00:00Z',
    courses: [validCourseDoc()],
    settings: { speechEnabled: false, lastExportAt: '2026-07-01T00:00:00Z', lastCourseId: 'c1' },
    sessions: [session],
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

describe('parseCoursesFile', () => {
  it('accepts the storage.md example shape', () => {
    const parsed = parseCoursesFile(validCoursesFileDoc())
    expect(parsed).toEqual(validCoursesFileDoc())
  })

  it('round-trips optional settings fields', () => {
    const doc = validCoursesFileDoc()
    doc.settings = asRecord({
      speechEnabled: false,
      lastExportAt: '2026-07-12T18:00:00Z',
      lastCourseId: 'c1',
    }) as typeof doc.settings
    expect(parseCoursesFile(doc).settings).toEqual({
      speechEnabled: false,
      lastExportAt: '2026-07-12T18:00:00Z',
      lastCourseId: 'c1',
    })
  })

  it('tolerates unknown extra keys without preserving them', () => {
    const doc = validCoursesFileDoc()
    asRecord(doc).futureTopLevelField = 42
    asRecord(doc.courses[0]).futureCourseField = 'x'
    asRecord(doc.settings).futureSetting = true
    const parsed = parseCoursesFile(doc)
    expect(parsed).toEqual(validCoursesFileDoc())
    expect('futureTopLevelField' in parsed).toBe(false)
  })

  it('rejects a non-object document', () => {
    expect(() => parseCoursesFile('[]')).toThrow(SchemaError)
    expect(() => parseCoursesFile(null)).toThrow(/^\$: expected object/)
  })

  it('rejects a missing or non-integer schemaVersion', () => {
    const { schemaVersion, ...withoutVersion } = validCoursesFileDoc()
    void schemaVersion
    expect(() => parseCoursesFile(withoutVersion)).toThrow(/\$\.schemaVersion/)
    expect(() => parseCoursesFile({ ...validCoursesFileDoc(), schemaVersion: 1.5 })).toThrow(
      /\$\.schemaVersion/,
    )
  })

  it('refuses documents newer than SCHEMA_VERSION with a SchemaVersionError', () => {
    const newer = { ...validCoursesFileDoc(), schemaVersion: SCHEMA_VERSION + 1 }
    expect(() => parseCoursesFile(newer)).toThrow(/newer than this app's schema/)
    expect(() => parseCoursesFile(newer)).toThrow(SchemaVersionError)
  })

  it('labels field errors with their path', () => {
    const badDirection = validCoursesFileDoc()
    badDirection.courses.push({ ...validCourseDoc(), direction: 'up' })
    expect(() => parseCoursesFile(badDirection)).toThrow(/\$\.courses\[1\]\.direction/)

    const negativeMinLap = validCoursesFileDoc()
    negativeMinLap.courses[0].minLapTimeMs = -1
    expect(() => parseCoursesFile(negativeMinLap)).toThrow(/\$\.courses\[0\]\.minLapTimeMs/)

    const badDate = validCoursesFileDoc()
    badDate.courses[0].createdAt = 'yesterday'
    expect(() => parseCoursesFile(badDate)).toThrow(/\$\.courses\[0\]\.createdAt.*ISO 8601/)

    const missingSpeech = validCoursesFileDoc()
    delete asRecord(missingSpeech.settings).speechEnabled
    expect(() => parseCoursesFile(missingSpeech)).toThrow(/\$\.settings\.speechEnabled/)
  })
})

describe('parseSessionFile', () => {
  it('accepts the storage.md example shape (flat, schemaVersion alongside)', () => {
    expect(parseSessionFile(validSessionFileDoc())).toEqual(validSessionFileDoc())
  })

  it('labels deep field errors with their path', () => {
    const negativeDuration = validSessionFileDoc()
    negativeDuration.laps[0].durationMs = -5
    expect(() => parseSessionFile(negativeDuration)).toThrow(/\$\.laps\[0\]\.durationMs/)

    const badStatus = validSessionFileDoc()
    badStatus.laps[1].status = 'deleted'
    expect(() => parseSessionFile(badStatus)).toThrow(/\$\.laps\[1\]\.status/)

    const zeroLapNumber = validSessionFileDoc()
    zeroLapNumber.laps[0].n = 0
    expect(() => parseSessionFile(zeroLapNumber)).toThrow(/\$\.laps\[0\]\.n/)

    const badRoi = validSessionFileDoc()
    asRecord(badRoi.detectionConfig.tunables.roi).x = 'left'
    expect(() => parseSessionFile(badRoi)).toThrow(/\$\.detectionConfig\.tunables\.roi\.x/)

    const missingDetectorField = validSessionFileDoc()
    delete asRecord(missingDetectorField.detectionConfig.detector).maxPauseMs
    expect(() => parseSessionFile(missingDetectorField)).toThrow(
      /\$\.detectionConfig\.detector\.maxPauseMs/,
    )

    const fractionalStripCount = validSessionFileDoc()
    fractionalStripCount.detectionConfig.tunables.stripCount = 0
    expect(() => parseSessionFile(fractionalStripCount)).toThrow(
      /\$\.detectionConfig\.tunables\.stripCount/,
    )

    const lapsNotArray = validSessionFileDoc()
    asRecord(lapsNotArray).laps = {}
    expect(() => parseSessionFile(lapsNotArray)).toThrow(/\$\.laps: expected array/)
  })

  it('rejects non-finite numbers even where JSON could not produce them', () => {
    const doc = validSessionFileDoc()
    doc.detectionConfig.detector.maxTraversalMs = Number.POSITIVE_INFINITY
    expect(() => parseSessionFile(doc)).toThrow(/\$\.detectionConfig\.detector\.maxTraversalMs/)
  })
})

describe('parseExportEnvelope', () => {
  it('accepts a complete envelope', () => {
    const parsed = parseExportEnvelope(validEnvelopeDoc())
    expect(parsed).toEqual(validEnvelopeDoc())
  })

  it('labels nested session errors with their envelope path', () => {
    const doc = validEnvelopeDoc()
    asRecord(doc.sessions[0]).note = 7
    expect(() => parseExportEnvelope(doc)).toThrow(/\$\.sessions\[0\]\.note/)
  })

  it('requires exportedAt', () => {
    const { exportedAt, ...withoutExportedAt } = validEnvelopeDoc()
    void exportedAt
    expect(() => parseExportEnvelope(withoutExportedAt)).toThrow(/\$\.exportedAt/)
  })
})

// v0 never shipped — SCHEMA_VERSION was 1 from the first byte ever written.
// The fabricated v0 difference ("v0 lacked settings") exists purely to prove
// the migration mechanism end to end before it is needed.
describe('migration registry (synthetic v0→v1)', () => {
  it('migrates a v0 courses file forward on read, adding default settings', () => {
    const { settings, ...v0 } = validCoursesFileDoc()
    void settings
    const parsed = parseCoursesFile({ ...v0, schemaVersion: 0 })
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION)
    expect(parsed.settings).toEqual(defaultAppSettings())
    expect(parsed.courses).toEqual(validCoursesFileDoc().courses)
  })

  it('migrates a v0 session file forward (shape unchanged, version stamped)', () => {
    const parsed = parseSessionFile({ ...validSessionFileDoc(), schemaVersion: 0 })
    expect(parsed).toEqual(validSessionFileDoc())
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('migrates a v0 export envelope forward, adding default settings', () => {
    const { settings, ...v0 } = validEnvelopeDoc()
    void settings
    const parsed = parseExportEnvelope({ ...v0, schemaVersion: 0 })
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION)
    expect(parsed.settings).toEqual(defaultAppSettings())
  })

  it('does not overwrite settings a v0 document somehow already carries', () => {
    const parsed = parseCoursesFile({
      ...validCoursesFileDoc(),
      settings: { speechEnabled: false },
      schemaVersion: 0,
    })
    expect(parsed.settings).toEqual({ speechEnabled: false })
  })
})

describe('migration driver (migrateToCurrent)', () => {
  it('stamps schemaVersion after each step, so the next migration observes it', () => {
    // A two-step chain needs a target above the shipped SCHEMA_VERSION (1);
    // migrations[1] is registered temporarily for this test only.
    const observedInputVersions: unknown[] = []
    migrations[1] = (doc) => {
      observedInputVersions.push(doc.schemaVersion)
      return doc
    }
    try {
      const result = migrateToCurrent({ ...validCoursesFileDoc(), schemaVersion: 0 }, 'courses', 2)
      expect(observedInputVersions).toEqual([1])
      expect(result.schemaVersion).toBe(2)
    } finally {
      delete migrations[1]
    }
  })

  it('throws SchemaVersionError when an intermediate migration is missing', () => {
    const doc = { ...validCoursesFileDoc(), schemaVersion: 1 }
    expect(() => migrateToCurrent(doc, 'courses', 2)).toThrow(SchemaVersionError)
    expect(() => migrateToCurrent(doc, 'courses', 2)).toThrow(/no migration registered from version 1/)
  })

  it('SchemaVersionError is a SchemaError subclass with its own name', () => {
    const error = new SchemaVersionError('$.schemaVersion: refused')
    expect(error).toBeInstanceOf(SchemaError)
    expect(error.name).toBe('SchemaVersionError')
  })
})
