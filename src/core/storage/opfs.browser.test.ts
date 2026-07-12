import { afterEach, describe, expect, it } from 'vitest'
import { probeOpfs, probeStoragePersistence } from './opfs-probe'
import {
  checkPendingAtomicProbe,
  PENDING_ATOMIC_MARKER_FILE,
  probeAtomicWriteAbort,
  startPendingAtomicWriteProbe,
} from './atomic-write-probe'

const testFiles: string[] = []

afterEach(async () => {
  const root = await navigator.storage.getDirectory()
  for (const name of testFiles.splice(0)) {
    await root.removeEntry(name).catch(() => {})
    await root.removeEntry(`${name}.crswap`).catch(() => {})
  }
})

describe('OPFS in a real browser', () => {
  it('writes a file and reads the same content back', async () => {
    const name = `chronowhoop-opfs-${crypto.randomUUID()}.txt`
    testFiles.push(name)
    const payload = `lap 1: 12.34s @ ${Date.now()}`

    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(payload)
    await writable.close()

    const file = await root.getFileHandle(name)
    const readBack = await (await file.getFile()).text()

    expect(readBack).toBe(payload)
  })

  it('probeOpfs succeeds against real OPFS', async () => {
    const result = await probeOpfs()
    expect(result).toEqual({ ok: true })
  })

  it('probeAtomicWriteAbort finds the original content intact after abort', async () => {
    const result = await probeAtomicWriteAbort()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.contentIntact).toBe(true)
    expect(result.actualContent).toBe('chronowhoop-atomic-original')
  })

  it('pending atomic probe round-trips: start, check, then reports none', async () => {
    testFiles.push(PENDING_ATOMIC_MARKER_FILE)

    const started = await startPendingAtomicWriteProbe('never-close')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    testFiles.push(started.fileName)
    expect(started.scenario).toBe('never-close')
    expect(started.immediateContentIntact).toBe(true)

    const check = await checkPendingAtomicProbe()
    expect(check.status).toBe('completed')
    if (check.status !== 'completed') return
    expect(check.scenario).toBe('never-close')
    expect(check.contentIntact).toBe(true)

    expect(await checkPendingAtomicProbe()).toEqual({ status: 'none' })
  })

  it('probeStoragePersistence returns a fully-populated report', async () => {
    const report = await probeStoragePersistence()
    expect(typeof report.persistedInitially).toBe('boolean')
    expect(typeof report.persistGranted).toBe('boolean')
    expect(typeof report.quotaBytes).toBe('number')
    expect(typeof report.usageBytes).toBe('number')
  })
})
