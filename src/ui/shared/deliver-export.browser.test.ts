// deliverExport delivery selection (plan 07 item 1) with injected fake
// navigators — the headless test browser has no Web Share API of its own.

import { describe, expect, it, vi } from 'vitest'
import { deliverExport, type ShareCapableNavigator } from './deliver-export'

const blob = () => new Blob(['{"schemaVersion":1}'], { type: 'application/json' })

describe('deliverExport', () => {
  it('shares when canShare accepts files, and reports shared', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const nav: ShareCapableNavigator = { canShare: () => true, share }

    await expect(deliverExport(blob(), 'export.json', nav)).resolves.toBe('shared')

    expect(share).toHaveBeenCalledTimes(1)
    const [{ files }] = share.mock.calls[0] as [{ files: File[] }]
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('export.json')
    expect(files[0].type).toBe('application/json')
  })

  it('reports cancelled when the user dismisses the share sheet (AbortError)', async () => {
    const nav: ShareCapableNavigator = {
      canShare: () => true,
      share: () => Promise.reject(new DOMException('canceled', 'AbortError')),
    }
    await expect(deliverExport(blob(), 'export.json', nav)).resolves.toBe('cancelled')
  })

  it('falls back to the anchor download when share fails for another reason', async () => {
    const nav: ShareCapableNavigator = {
      canShare: () => true,
      share: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    }
    await expect(deliverExport(blob(), 'export.json', nav)).resolves.toBe('downloaded')
  })

  it('downloads when the platform cannot share files', async () => {
    const nav: ShareCapableNavigator = { canShare: () => false, share: () => Promise.resolve() }
    await expect(deliverExport(blob(), 'export.json', nav)).resolves.toBe('downloaded')
  })

  it('downloads when there is no Web Share API at all', async () => {
    await expect(deliverExport(blob(), 'export.json', {})).resolves.toBe('downloaded')
  })
})
