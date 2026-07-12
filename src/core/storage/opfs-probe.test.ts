import { describe, expect, it } from 'vitest'
import {
  probeOpfs,
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
