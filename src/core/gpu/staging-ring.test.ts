import { describe, expect, it } from 'vitest'
import { StagingRing, type StagingBufferLike } from './staging-ring'

interface FakeBuffer extends StagingBufferLike {
  resolveMap(): void
  rejectMap(error: Error): void
  unmapped: boolean
}

function fakeBuffer(value: number): FakeBuffer {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const mapped = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {
    mapAsync: () => mapped,
    getMappedRange: () => Float32Array.of(value).buffer,
    unmap() {
      this.unmapped = true
    },
    resolveMap: resolve,
    rejectMap: reject,
    unmapped: false,
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('StagingRing', () => {
  it('hands out each buffer once, then overruns instead of blocking', () => {
    const buffers = [fakeBuffer(1), fakeBuffer(2), fakeBuffer(3)]
    const ring = new StagingRing(buffers)

    const slots = [ring.acquire(), ring.acquire(), ring.acquire()]
    expect(slots.map((slot) => slot?.buffer)).toEqual(buffers)
    expect(ring.pending).toBe(3)
    expect(ring.overruns).toBe(0)

    expect(ring.acquire()).toBeUndefined()
    expect(ring.acquire()).toBeUndefined()
    expect(ring.overruns).toBe(2)
    expect(ring.pending).toBe(3)
  })

  it('readValue resolves with the buffer f32 and frees the slot', async () => {
    const buffers = [fakeBuffer(0.25)]
    const ring = new StagingRing(buffers)
    const slot = ring.acquire()!

    expect(ring.acquire()).toBeUndefined()

    const read = ring.readValue(slot)
    buffers[0].resolveMap()
    expect(await read).toBeCloseTo(0.25, 6)
    expect(buffers[0].unmapped).toBe(true)
    expect(ring.pending).toBe(0)
    expect(ring.acquire()).toBeDefined()
  })

  it('frees the slot even when mapAsync rejects', async () => {
    const buffers = [fakeBuffer(0)]
    const ring = new StagingRing(buffers)
    const slot = ring.acquire()!

    const read = ring.readValue(slot)
    buffers[0].rejectMap(new Error('device lost'))
    await expect(read).rejects.toThrow('device lost')
    await flushMicrotasks()
    expect(ring.pending).toBe(0)
    expect(ring.acquire()).toBeDefined()
  })

  it('release frees a slot without reading', () => {
    const ring = new StagingRing([fakeBuffer(0)])
    const slot = ring.acquire()!
    ring.release(slot)
    expect(ring.pending).toBe(0)
    expect(ring.acquire()).toBeDefined()
    expect(ring.overruns).toBe(0)
  })

  it('rejects an empty ring', () => {
    expect(() => new StagingRing([])).toThrow()
  })
})
