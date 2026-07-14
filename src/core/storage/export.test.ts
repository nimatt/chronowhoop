import { describe, expect, test } from 'vitest'
import type { Course, Session } from '../domain/types'
import { buildExportFilename, exportEnvelopeToBlob } from './export'
import { MemoryStorage } from './memory-storage'
import { parseExportEnvelope } from './schema'

const EXPORTED_AT = '2026-07-13T10:30:00.000Z'

function courseFixture(): Course {
  return {
    id: 'course-1',
    name: 'Basement 3-gate',
    direction: 'ltr',
    minLapTimeMs: 3000,
    createdAt: '2026-07-12T09:30:00.000Z',
  }
}

function sessionFixture(id: string, startedAt: string): Session {
  return {
    id,
    courseId: 'course-1',
    startedAt,
    note: '',
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
    ],
  }
}

async function seededStorage(): Promise<MemoryStorage> {
  const storage = new MemoryStorage({ now: () => EXPORTED_AT })
  await storage.saveCourses({
    courses: [courseFixture()],
    settings: { speechEnabled: false, lastCourseId: 'course-1' },
  })
  await storage.saveSession(sessionFixture('session-a', '2026-07-12T10:05:00.000Z'))
  await storage.saveSession(sessionFixture('session-b', '2026-07-13T08:00:00.000Z'))
  return storage
}

describe('buildExportFilename', () => {
  // Local-time components, so the expectations are timezone-independent.
  test('formats as chronowhoop-export-YYYYMMDD-HHMMSS.json with zero padding', () => {
    expect(buildExportFilename(new Date(2026, 6, 3, 9, 5, 7))).toBe(
      'chronowhoop-export-20260703-090507.json',
    )
    expect(buildExportFilename(new Date(2026, 11, 31, 23, 59, 59))).toBe(
      'chronowhoop-export-20261231-235959.json',
    )
  })

  // Two exports in the same minute — the export → delete → export rhythm this
  // feature encourages — must not produce the same name: an overwriting share
  // target would replace the pre-delete backup with a post-delete snapshot.
  test('distinguishes two exports within the same minute', () => {
    expect(buildExportFilename(new Date(2026, 6, 3, 9, 5, 12))).not.toBe(
      buildExportFilename(new Date(2026, 6, 3, 9, 5, 48)),
    )
  })
})

describe('exportEnvelopeToBlob', () => {
  test('assembles a pretty-printed JSON blob that round-trips through the envelope validator', async () => {
    const storage = await seededStorage()
    const { blob, filename, exportedAt } = exportEnvelopeToBlob(await storage.exportAll())

    expect(blob.type).toBe('application/json')
    expect(filename).toBe(buildExportFilename(new Date(EXPORTED_AT)))
    expect(exportedAt).toBe(EXPORTED_AT)

    const text = await blob.text()
    expect(text).toContain('\n  "schemaVersion"')

    const envelope = parseExportEnvelope(JSON.parse(text))
    expect(envelope.schemaVersion).toBe(1)
    expect(envelope.exportedAt).toBe(EXPORTED_AT)
    expect(envelope.courses).toEqual([courseFixture()])
    // Sessions oldest → newest, per the Storage contract.
    expect(envelope.sessions.map((session) => session.id)).toEqual(['session-a', 'session-b'])
    expect(envelope.settings.speechEnabled).toBe(false)
  })

  // Recording settings.lastExportAt is the UI layer's job (through
  // CoursesRepo, after delivery); this module is pure assembly.
  test('does not write anything — settings are untouched after assembly', async () => {
    const storage = await seededStorage()
    exportEnvelopeToBlob(await storage.exportAll())

    const { settings } = await storage.loadCourses()
    expect(settings).toEqual({ speechEnabled: false, lastCourseId: 'course-1' })
  })
})
