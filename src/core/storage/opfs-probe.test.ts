import { describe, expect, it } from 'vitest'
import {
  probeOpfs,
  probeStoragePersistence,
  type OpfsDirectoryLike,
  type OpfsStorageLike,
  type OpfsWritableLike,
} from './opfs-probe'

interface FakeOptions {
  getDirectoryError?: Error
  createWritableError?: Error
  writeError?: Error
  removeEntryError?: Error
}

function makeFakeStorage(options: FakeOptions = {}) {
  const calls: string[] = []

  const writable: OpfsWritableLike = {
    async write(data) {
      calls.push(`write:${data}`)
      if (options.writeError) throw options.writeError
    },
    async close() {
      calls.push('close')
    },
  }

  const directory: OpfsDirectoryLike = {
    async getFileHandle(name, opts) {
      calls.push(`getFileHandle:${name}:create=${opts?.create ?? false}`)
      return {
        async createWritable() {
          calls.push('createWritable')
          if (options.createWritableError) throw options.createWritableError
          return writable
        },
      }
    },
    async removeEntry(name) {
      calls.push(`removeEntry:${name}`)
      if (options.removeEntryError) throw options.removeEntryError
    },
  }

  const storage: OpfsStorageLike = {
    async getDirectory() {
      calls.push('getDirectory')
      if (options.getDirectoryError) throw options.getDirectoryError
      return directory
    },
  }

  return { storage, calls }
}

describe('probeOpfs', () => {
  it('reports unsupported when storage is undefined', async () => {
    const result = await probeOpfs(undefined)
    expect(result).toEqual({
      ok: false,
      message: 'navigator.storage.getDirectory is not available',
    })
  })

  it('reports unsupported when getDirectory is missing', async () => {
    const result = await probeOpfs({})
    expect(result).toMatchObject({ ok: false })
  })

  it('returns ok and removes the exact probe file it created on the happy path', async () => {
    const { storage, calls } = makeFakeStorage()
    const result = await probeOpfs(storage)
    expect(result).toEqual({ ok: true })
    expect(calls[0]).toBe('getDirectory')
    expect(calls).toContain('createWritable')
    expect(calls).toContain('write:opfs-probe')
    expect(calls).toContain('close')

    const createdName = calls.find((call) => call.startsWith('getFileHandle:'))?.split(':')[1]
    const removedName = calls.find((call) => call.startsWith('removeEntry:'))?.split(':')[1]
    expect(createdName).toMatch(/^\.chronowhoop-opfs-probe-/)
    expect(removedName).toBe(createdName)
  })

  it('reports failure when getDirectory throws', async () => {
    const { storage } = makeFakeStorage({ getDirectoryError: new Error('denied') })
    const result = await probeOpfs(storage)
    expect(result).toEqual({
      ok: false,
      message: 'getDirectory() failed: denied',
    })
  })

  it('reports failure and still cleans up when the write fails', async () => {
    const { storage, calls } = makeFakeStorage({ createWritableError: new Error('quota') })
    const result = await probeOpfs(storage)
    expect(result).toEqual({
      ok: false,
      message: 'OPFS write probe failed: quota',
    })
    expect(calls.some((call) => call.startsWith('removeEntry:'))).toBe(true)
  })

  it('still returns ok when cleanup itself fails', async () => {
    const { storage } = makeFakeStorage({ removeEntryError: new Error('gone') })
    const result = await probeOpfs(storage)
    expect(result).toEqual({ ok: true })
  })
})

describe('probeStoragePersistence', () => {
  it('reports persisted state, persist grant, and estimate on the happy path', async () => {
    const calls: string[] = []
    const storage: OpfsStorageLike = {
      async persisted() {
        calls.push('persisted')
        return false
      },
      async persist() {
        calls.push('persist')
        return true
      },
      async estimate() {
        calls.push('estimate')
        return { quota: 1000, usage: 10 }
      },
    }
    const report = await probeStoragePersistence(storage)
    expect(report).toEqual({
      persistedInitially: false,
      persistGranted: true,
      quotaBytes: 1000,
      usageBytes: 10,
    })
    expect(calls).toEqual(['persisted', 'persist', 'estimate'])
  })

  it('reports nulls with detail when the APIs are unavailable', async () => {
    const report = await probeStoragePersistence({})
    expect(report).toEqual({
      persistedInitially: null,
      persistGranted: null,
      quotaBytes: null,
      usageBytes: null,
      detail:
        'persisted() is not available; persist() is not available; estimate() is not available',
    })
  })

  it('handles undefined storage', async () => {
    const report = await probeStoragePersistence(undefined)
    expect(report).toMatchObject({ persistedInitially: null, persistGranted: null })
  })

  it('captures per-call failures without failing the whole report', async () => {
    const storage: OpfsStorageLike = {
      async persisted() {
        return true
      },
      async persist() {
        throw new Error('denied')
      },
      async estimate() {
        return {}
      },
    }
    const report = await probeStoragePersistence(storage)
    expect(report).toEqual({
      persistedInitially: true,
      persistGranted: null,
      quotaBytes: null,
      usageBytes: null,
      detail: 'persist() failed: denied',
    })
  })
})
