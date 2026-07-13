import { describe, expect, it, vi } from 'vitest'
import type { StorageContext } from '../data/storage-context'
import { exportOutcomeNotice, runExport } from './export-action'

describe('runExport', () => {
  it('reports a failed export when the storage rejects, recording nothing', async () => {
    const updateSettings = vi.fn()
    const context = {
      storage: { exportAll: () => Promise.reject(new Error('disk exploded')) },
      coursesRepo: { updateSettings },
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
