import { describe, expect, it } from 'vitest'
import { RingBuffer, DEFAULT_RING_BUFFER_CAPACITY } from './ring-buffer'
import type { LumaFrame } from './types'

function frame(captureTimeMs: number): LumaFrame {
  return { data: new Uint8Array(1), width: 1, height: 1, captureTimeMs }
}

describe('RingBuffer', () => {
  it('defaults to ~2 s at 60 fps', () => {
    expect(new RingBuffer().capacity).toBe(DEFAULT_RING_BUFFER_CAPACITY)
    expect(DEFAULT_RING_BUFFER_CAPACITY).toBe(120)
  })

  it('returns pushed frames oldest-first while under capacity', () => {
    const buffer = new RingBuffer(3)
    buffer.push(frame(0))
    buffer.push(frame(1))
    expect(buffer.size).toBe(2)
    expect(buffer.frames().map((f) => f.captureTimeMs)).toEqual([0, 1])
  })

  it('keeps exactly the last K frames, overwriting the oldest', () => {
    const buffer = new RingBuffer(3)
    for (let t = 0; t < 8; t++) buffer.push(frame(t))
    expect(buffer.size).toBe(3)
    expect(buffer.frames().map((f) => f.captureTimeMs)).toEqual([5, 6, 7])
  })

  it('clear() empties the buffer and it refills correctly', () => {
    const buffer = new RingBuffer(2)
    buffer.push(frame(0))
    buffer.push(frame(1))
    buffer.push(frame(2))
    buffer.clear()
    expect(buffer.size).toBe(0)
    expect(buffer.frames()).toEqual([])
    buffer.push(frame(3))
    buffer.push(frame(4))
    buffer.push(frame(5))
    expect(buffer.frames().map((f) => f.captureTimeMs)).toEqual([4, 5])
  })

  it('rejects non-positive or fractional capacities', () => {
    expect(() => new RingBuffer(0)).toThrow()
    expect(() => new RingBuffer(2.5)).toThrow()
  })
})
