import { describe, expect, it } from 'vitest'
import { RECENT_EXPORT_MAX_AGE_MS, shouldNudgeBackup } from './backup-nudge'

const NOW = Date.parse('2026-07-13T12:00:00.000Z')

function sessionsAt(...startedAts: string[]) {
  return startedAts.map((startedAt) => ({ startedAt }))
}

function isoBefore(nowMs: number, deltaMs: number): string {
  return new Date(nowMs - deltaMs).toISOString()
}

describe('shouldNudgeBackup', () => {
  it('never nudges when no sessions exist', () => {
    expect(shouldNudgeBackup({ sessionSummaries: [], lastExportAt: undefined, now: NOW })).toBe(false)
    expect(
      shouldNudgeBackup({
        sessionSummaries: [],
        lastExportAt: isoBefore(NOW, RECENT_EXPORT_MAX_AGE_MS * 2),
        now: NOW,
      }),
    ).toBe(false)
  })

  it('nudges when sessions exist and nothing was ever exported', () => {
    expect(
      shouldNudgeBackup({
        sessionSummaries: sessionsAt('2026-07-13T10:00:00.000Z'),
        lastExportAt: undefined,
        now: NOW,
      }),
    ).toBe(true)
  })

  it('nudges when a session postdates an export older than 7 days', () => {
    const lastExportAt = isoBefore(NOW, RECENT_EXPORT_MAX_AGE_MS + 1)
    expect(
      shouldNudgeBackup({
        sessionSummaries: sessionsAt('2026-01-01T00:00:00.000Z', isoBefore(NOW, 60_000)),
        lastExportAt,
        now: NOW,
      }),
    ).toBe(true)
  })

  it('does not nudge when the export is old but every session predates it', () => {
    const lastExportAt = isoBefore(NOW, RECENT_EXPORT_MAX_AGE_MS * 3)
    expect(
      shouldNudgeBackup({
        sessionSummaries: sessionsAt('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
        lastExportAt,
        now: NOW,
      }),
    ).toBe(false)
  })

  it('does not nudge when the export is recent, even with unexported sessions', () => {
    const lastExportAt = isoBefore(NOW, RECENT_EXPORT_MAX_AGE_MS - 60_000)
    expect(
      shouldNudgeBackup({
        sessionSummaries: sessionsAt(isoBefore(NOW, 30_000)),
        lastExportAt,
        now: NOW,
      }),
    ).toBe(false)
  })

  it('boundary: an export exactly 7 days old is still recent; 1ms older is not', () => {
    const sessionSummaries = sessionsAt(isoBefore(NOW, 1_000))

    const exactlySevenDays = isoBefore(NOW, RECENT_EXPORT_MAX_AGE_MS)
    expect(shouldNudgeBackup({ sessionSummaries, lastExportAt: exactlySevenDays, now: NOW })).toBe(false)

    const justOverSevenDays = isoBefore(NOW, RECENT_EXPORT_MAX_AGE_MS + 1)
    expect(shouldNudgeBackup({ sessionSummaries, lastExportAt: justOverSevenDays, now: NOW })).toBe(true)
  })

  it('boundary: a session starting exactly at lastExportAt counts as exported', () => {
    const lastExportAt = isoBefore(NOW, RECENT_EXPORT_MAX_AGE_MS * 2)
    expect(
      shouldNudgeBackup({ sessionSummaries: sessionsAt(lastExportAt), lastExportAt, now: NOW }),
    ).toBe(false)

    const oneMsAfterExport = new Date(Date.parse(lastExportAt) + 1).toISOString()
    expect(
      shouldNudgeBackup({ sessionSummaries: sessionsAt(oneMsAfterExport), lastExportAt, now: NOW }),
    ).toBe(true)
  })
})
