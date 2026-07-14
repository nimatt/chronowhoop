import { describe, expect, it, vi } from 'vitest'
import type { StorageContext } from '../data/storage-context'
import { exportOutcomeNotice, runExport } from './export-action'

describe('runExport', () => {
  it('reports a failed export when the repo cannot assemble the envelope, recording nothing', async () => {
    const updateSettings = vi.fn()
    // The repo is the only door to the export (plan 09 item 6): an unqueued
    // storage.exportAll() can be torn by a cascade committing mid-scan. This
    // used to be asserted by spying on a context.storage.exportAll that runExport
    // must not call — a test that could only ever catch the mistake after
    // somebody made it. StorageContext no longer carries the Storage handle at
    // all, so the wrong door is now a compile error and a lint error
    // (eslint.config.js `seam/courses-json-critical-section`, pinned in
    // core/lint-seams.test.ts); what is left to test here is the behaviour.
    const context = {
      liveReadOnly: () => false,
      coursesRepo: {
        // The repo reports failure as null with lastError set; it never rejects.
        exportAll: () => Promise.resolve(null),
        lastError: { kind: 'write-failed', message: 'disk exploded' },
        updateSettings,
      },
    } as unknown as StorageContext

    const outcome = await runExport(context)

    expect(outcome).toEqual({ kind: 'failed', message: 'disk exploded' })
    expect(updateSettings).not.toHaveBeenCalled()
  })
})

describe('exportOutcomeNotice', () => {
  it('maps outcomes to the shared notice copy', () => {
    expect(exportOutcomeNotice({ kind: 'failed', message: 'disk exploded' })).toEqual({
      ok: false,
      text: 'Export failed: disk exploded',
    })
    expect(exportOutcomeNotice({ kind: 'delivered', filename: 'x.json' })).toEqual({
      ok: true,
      text: 'Exported x.json',
    })
    expect(exportOutcomeNotice({ kind: 'cancelled' })).toBeNull()
  })
})
