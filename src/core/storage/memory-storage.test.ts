import { describe, expect, it } from 'vitest'
import { MemoryStorage } from './memory-storage'
import { describeStorageContract, makeSession } from './storage-contract'

describeStorageContract('MemoryStorage', () => Promise.resolve(new MemoryStorage()))

describe('MemoryStorage specifics', () => {
  it('exportAll stamps exportedAt from the injected clock', async () => {
    const storage = new MemoryStorage({ now: () => '2026-07-13T12:00:00.000Z' })
    await storage.saveSession(makeSession())
    const envelope = await storage.exportAll()
    expect(envelope.exportedAt).toBe('2026-07-13T12:00:00.000Z')
  })
})
