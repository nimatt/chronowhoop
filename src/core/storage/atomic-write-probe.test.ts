import { describe, expect, it } from 'vitest'
import {
  checkPendingAtomicProbe,
  PENDING_ATOMIC_MARKER_FILE,
  probeAtomicWriteAbort,
  retainedKillTabWritableForTesting,
  startPendingAtomicWriteProbe,
} from './atomic-write-probe'
import type {
  OpfsDirectoryLike,
  OpfsFileHandleLike,
  OpfsStorageLike,
  OpfsWritableLike,
} from './opfs-probe'

interface FakeOptions {
  abortSupported?: boolean
  abortCommitsPartial?: boolean
  leaveSwapAfterAbort?: boolean
  keysSupported?: boolean
  getFileSupported?: boolean
}

interface FakeWritableState {
  buffer: string
  settled: boolean
  writable?: OpfsWritableLike
}

function makeFakeOpfs(options: FakeOptions = {}) {
  const {
    abortSupported = true,
    abortCommitsPartial = false,
    leaveSwapAfterAbort = false,
    keysSupported = true,
    getFileSupported = true,
  } = options

  const files = new Map<string, string>()
  const openWritables: FakeWritableState[] = []

  function makeWritable(name: string): OpfsWritableLike {
    const state: FakeWritableState = { buffer: '', settled: false }
    openWritables.push(state)
    files.set(`${name}.crswap`, '')

    const writable: OpfsWritableLike = {
      async write(data) {
        state.buffer += data
        files.set(`${name}.crswap`, state.buffer)
      },
      async close() {
        state.settled = true
        files.set(name, state.buffer)
        files.delete(`${name}.crswap`)
      },
    }
    if (abortSupported) {
      writable.abort = async () => {
        state.settled = true
        if (abortCommitsPartial) files.set(name, state.buffer)
        if (!leaveSwapAfterAbort) files.delete(`${name}.crswap`)
      }
    }
    state.writable = writable
    return writable
  }

  function makeFileHandle(name: string): OpfsFileHandleLike {
    const handle: OpfsFileHandleLike = {
      async createWritable() {
        return makeWritable(name)
      },
    }
    if (getFileSupported) {
      handle.getFile = async () => ({
        async text() {
          const content = files.get(name)
          if (content === undefined) throw new Error(`no committed content for ${name}`)
          return content
        },
      })
    }
    return handle
  }

  const directory: OpfsDirectoryLike = {
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (!opts?.create) throw new Error(`NotFoundError: ${name}`)
        files.set(name, '')
      }
      return makeFileHandle(name)
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw new Error(`NotFoundError: ${name}`)
    },
  }
  if (keysSupported) {
    directory.keys = async function* () {
      yield* [...files.keys()]
    }
  }

  const storage: OpfsStorageLike = {
    async getDirectory() {
      return directory
    },
  }

  return { storage, files, openWritables }
}

describe('probeAtomicWriteAbort', () => {
  it('reports intact content and cleans up on an atomic implementation', async () => {
    const { storage, files } = makeFakeOpfs()
    const result = await probeAtomicWriteAbort(storage)
    expect(result).toMatchObject({ ok: true, contentIntact: true, leftoverArtifacts: [] })
    expect(files.size).toBe(0)
  })

  it('reports non-intact content when abort commits the partial write', async () => {
    const { storage } = makeFakeOpfs({ abortCommitsPartial: true })
    const result = await probeAtomicWriteAbort(storage)
    expect(result).toMatchObject({ ok: true, contentIntact: false, actualContent: 'partial' })
  })

  it('reports leftover swap artifacts by name and removes them', async () => {
    const { storage, files } = makeFakeOpfs({ leaveSwapAfterAbort: true })
    const result = await probeAtomicWriteAbort(storage)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.leftoverArtifacts).toHaveLength(1)
    expect(result.leftoverArtifacts[0]).toMatch(/^\.chronowhoop-atomic-abort-.*\.crswap$/)
    expect(files.size).toBe(0)
  })

  it('fails cleanly when abort is unavailable', async () => {
    const { storage, files } = makeFakeOpfs({ abortSupported: false })
    const result = await probeAtomicWriteAbort(storage)
    expect(result).toMatchObject({
      ok: false,
      message: 'FileSystemWritableFileStream.abort is not available',
    })
    expect([...files.keys()].filter((name) => !name.endsWith('.crswap'))).toEqual([])
  })

  it('fails when storage is unavailable', async () => {
    const result = await probeAtomicWriteAbort(undefined)
    expect(result).toMatchObject({ ok: false })
  })

  it('returns empty artifacts when directory iteration is unavailable', async () => {
    const { storage } = makeFakeOpfs({ keysSupported: false, leaveSwapAfterAbort: true })
    const result = await probeAtomicWriteAbort(storage)
    expect(result).toMatchObject({ ok: true, leftoverArtifacts: [] })
  })
})

describe('startPendingAtomicWriteProbe', () => {
  it('never-close: verifies original content immediately and persists a marker', async () => {
    const { storage, files, openWritables } = makeFakeOpfs()
    const result = await startPendingAtomicWriteProbe('never-close', storage)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scenario).toBe('never-close')
    expect(result.immediateContentIntact).toBe(true)
    expect(result.immediateLeftoverArtifacts).toEqual([`${result.fileName}.crswap`])

    const marker = JSON.parse(files.get(PENDING_ATOMIC_MARKER_FILE) ?? '') as {
      scenario: string
      fileName: string
      expectedContent: string
      startedAtMs: number
    }
    expect(marker.scenario).toBe('never-close')
    expect(marker.fileName).toBe(result.fileName)
    expect(marker.expectedContent).toBe(files.get(result.fileName))
    expect(typeof marker.startedAtMs).toBe('number')

    const partialWritable = openWritables.find((state) => state.buffer === 'partial')
    expect(partialWritable?.settled).toBe(false)
  })

  it('kill-tab: persists a marker without closing or aborting the writable', async () => {
    const { storage, files, openWritables } = makeFakeOpfs()
    const result = await startPendingAtomicWriteProbe('kill-tab', storage)
    expect(result).toMatchObject({ ok: true, scenario: 'kill-tab', immediateContentIntact: true })
    expect(files.has(PENDING_ATOMIC_MARKER_FILE)).toBe(true)
    const partialWritable = openWritables.find((state) => state.buffer === 'partial')
    expect(partialWritable?.settled).toBe(false)
  })

  it('kill-tab: retains only the latest experiment writable across restarts', async () => {
    const { storage, openWritables } = makeFakeOpfs()
    expect((await startPendingAtomicWriteProbe('kill-tab', storage)).ok).toBe(true)
    expect((await startPendingAtomicWriteProbe('kill-tab', storage)).ok).toBe(true)

    const partialWritables = openWritables.filter((state) => state.buffer === 'partial')
    expect(partialWritables).toHaveLength(2)
    expect(retainedKillTabWritableForTesting()).toBe(partialWritables[1]?.writable)
  })

  it('drops a retained kill-tab writable when a never-close experiment supersedes it', async () => {
    const { storage } = makeFakeOpfs()
    expect((await startPendingAtomicWriteProbe('kill-tab', storage)).ok).toBe(true)
    expect(retainedKillTabWritableForTesting()).toBeDefined()

    expect((await startPendingAtomicWriteProbe('never-close', storage)).ok).toBe(true)
    expect(retainedKillTabWritableForTesting()).toBeUndefined()
  })

  it('drops a retained kill-tab writable when a later start fails', async () => {
    const okFake = makeFakeOpfs()
    expect((await startPendingAtomicWriteProbe('kill-tab', okFake.storage)).ok).toBe(true)
    expect(retainedKillTabWritableForTesting()).toBeDefined()

    const failingFake = makeFakeOpfs({ getFileSupported: false })
    expect((await startPendingAtomicWriteProbe('kill-tab', failingFake.storage)).ok).toBe(false)
    expect(retainedKillTabWritableForTesting()).toBeUndefined()
  })

  it('cleans up marker and probe file when the start flow fails', async () => {
    const { storage, files } = makeFakeOpfs({ getFileSupported: false })
    const result = await startPendingAtomicWriteProbe('never-close', storage)
    expect(result).toMatchObject({ ok: false })
    expect(files.has(PENDING_ATOMIC_MARKER_FILE)).toBe(false)
    expect([...files.keys()].filter((name) => !name.endsWith('.crswap'))).toEqual([])
  })
})

describe('checkPendingAtomicProbe', () => {
  it('reports none when no marker exists', async () => {
    const { storage } = makeFakeOpfs()
    expect(await checkPendingAtomicProbe(storage)).toEqual({ status: 'none' })
  })

  it('completes a pending probe, reports the verdict, and cleans everything up', async () => {
    const { storage, files } = makeFakeOpfs()
    const started = await startPendingAtomicWriteProbe('never-close', storage)
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const check = await checkPendingAtomicProbe(storage)
    expect(check).toMatchObject({
      status: 'completed',
      scenario: 'never-close',
      contentIntact: true,
      leftoverArtifacts: [`${started.fileName}.crswap`],
    })
    expect(files.size).toBe(0)
    expect(await checkPendingAtomicProbe(storage)).toEqual({ status: 'none' })
  })

  it('detects a clobbered file after a simulated dirty reload', async () => {
    const { storage, files } = makeFakeOpfs()
    const started = await startPendingAtomicWriteProbe('kill-tab', storage)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    files.set(started.fileName, 'partial')

    const check = await checkPendingAtomicProbe(storage)
    expect(check).toMatchObject({
      status: 'completed',
      scenario: 'kill-tab',
      contentIntact: false,
      actualContent: 'partial',
    })
  })

  it('removes a malformed marker and reports an error', async () => {
    const { storage, files } = makeFakeOpfs()
    files.set(PENDING_ATOMIC_MARKER_FILE, 'not json')
    const check = await checkPendingAtomicProbe(storage)
    expect(check).toMatchObject({ status: 'error' })
    expect(files.has(PENDING_ATOMIC_MARKER_FILE)).toBe(false)
  })

  it('reports an error and cleans the marker when the probe file is missing', async () => {
    const { storage, files } = makeFakeOpfs()
    files.set(
      PENDING_ATOMIC_MARKER_FILE,
      JSON.stringify({
        scenario: 'kill-tab',
        fileName: '.chronowhoop-atomic-kill-tab-gone',
        expectedContent: 'chronowhoop-atomic-original',
        startedAtMs: 1,
      }),
    )
    const check = await checkPendingAtomicProbe(storage)
    expect(check).toMatchObject({ status: 'error' })
    expect(files.has(PENDING_ATOMIC_MARKER_FILE)).toBe(false)
  })

  it('reports an error when storage is unavailable', async () => {
    expect(await checkPendingAtomicProbe(undefined)).toMatchObject({ status: 'error' })
  })
})
