import { afterEach, describe, expect, it } from 'vitest'
import { probeOpfs } from './opfs-probe'

const testFiles: string[] = []

afterEach(async () => {
  const root = await navigator.storage.getDirectory()
  for (const name of testFiles.splice(0)) {
    await root.removeEntry(name).catch(() => {})
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
})
