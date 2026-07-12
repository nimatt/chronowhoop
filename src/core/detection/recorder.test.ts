import { describe, expect, it } from 'vitest'
import { ContinuousRecorder, DEFAULT_CONTINUOUS_RECORDER_MAX_FRAMES, snapshotRingClip } from './recorder'
import { RingBuffer } from './ring-buffer'
import { decodeClip, ClipFormatError } from './clip-format'
import type { LumaFrame } from './types'

function frame(captureTimeMs: number, width = 3, height = 2): LumaFrame {
  return {
    data: new Uint8Array(width * height).fill(captureTimeMs % 256),
    width,
    height,
    captureTimeMs,
  }
}

describe('snapshotRingClip', () => {
  it('encodes the ring contents oldest-first with conditions', () => {
    const ring = new RingBuffer(3)
    for (let t = 0; t < 5; t++) ring.push(frame(t))
    const clip = snapshotRingClip(ring, { trigger: 'manual' })
    const { header, frames } = decodeClip(clip)
    expect(header.captureTimesMs).toEqual([2, 3, 4])
    expect(header.conditions).toEqual({ trigger: 'manual' })
    expect(frames).toEqual([frame(2), frame(3), frame(4)])
  })

  it('throws on an empty ring', () => {
    expect(() => snapshotRingClip(new RingBuffer(3))).toThrow(ClipFormatError)
  })

  it('encodes only the newest uniform-dims suffix after an ROI change mid-ring', () => {
    const ring = new RingBuffer(5)
    ring.push(frame(0, 4, 4))
    ring.push(frame(1, 4, 4))
    ring.push(frame(2, 3, 2))
    ring.push(frame(3, 3, 2))
    const { header } = decodeClip(snapshotRingClip(ring))
    expect({ width: header.width, height: header.height }).toEqual({ width: 3, height: 2 })
    expect(header.captureTimesMs).toEqual([2, 3])
  })

  it('keeps the whole ring when dims are uniform', () => {
    const ring = new RingBuffer(3)
    for (let t = 0; t < 3; t++) ring.push(frame(t))
    expect(decodeClip(snapshotRingClip(ring)).header.captureTimesMs).toEqual([0, 1, 2])
  })
})

describe('ContinuousRecorder', () => {
  it('defaults to 30 s at 60 fps', () => {
    expect(new ContinuousRecorder().maxFrames).toBe(DEFAULT_CONTINUOUS_RECORDER_MAX_FRAMES)
    expect(DEFAULT_CONTINUOUS_RECORDER_MAX_FRAMES).toBe(1800)
  })

  it('records start → add × n → stop into a decodable clip', () => {
    const recorder = new ContinuousRecorder(10)
    recorder.start()
    expect(recorder.recording).toBe(true)
    for (let t = 0; t < 4; t++) recorder.add(frame(t))
    expect(recorder.frameCount).toBe(4)
    const { header, frames } = decodeClip(recorder.stop({ venue: 'garage' }))
    expect(recorder.recording).toBe(false)
    expect(header.captureTimesMs).toEqual([0, 1, 2, 3])
    expect(header.conditions).toEqual({ venue: 'garage' })
    expect(frames).toHaveLength(4)
    expect(recorder.truncated).toBe(false)
  })

  it('stops capturing at the cap and marks the clip truncated', () => {
    const recorder = new ContinuousRecorder(3)
    recorder.start()
    for (let t = 0; t < 8; t++) recorder.add(frame(t))
    expect(recorder.frameCount).toBe(3)
    expect(recorder.truncated).toBe(true)
    const { header } = decodeClip(recorder.stop({ venue: 'garage' }))
    expect(header.captureTimesMs).toEqual([0, 1, 2])
    expect(header.conditions).toEqual({
      venue: 'garage',
      truncated: 'true',
      truncatedDroppedFrames: '5',
    })
  })

  it('does not mark truncated when exactly at the cap', () => {
    const recorder = new ContinuousRecorder(2)
    recorder.start()
    recorder.add(frame(0))
    recorder.add(frame(1))
    expect(decodeClip(recorder.stop()).header.conditions).toBeUndefined()
  })

  it('rejects misuse: add/stop while idle, double start, empty stop, bad cap', () => {
    expect(() => new ContinuousRecorder(0)).toThrow(/maxFrames/)
    const recorder = new ContinuousRecorder(3)
    expect(() => recorder.add(frame(0))).toThrow(/not recording/)
    expect(() => recorder.stop()).toThrow(/not recording/)
    recorder.start()
    expect(() => recorder.start()).toThrow(/already recording/)
    expect(() => recorder.stop()).toThrow(ClipFormatError)
    expect(recorder.recording).toBe(true)
    recorder.add(frame(0))
    expect(decodeClip(recorder.stop()).frames).toHaveLength(1)
  })

  it('drops and counts dims-mismatched frames so stop() always encodes', () => {
    const recorder = new ContinuousRecorder(10)
    recorder.start()
    recorder.add(frame(0))
    recorder.add(frame(1, 4, 4))
    recorder.add(frame(2))
    recorder.add(frame(3, 5, 1))
    expect(recorder.frameCount).toBe(2)
    expect(recorder.droppedMismatchedFrames).toBe(2)
    const { header } = decodeClip(recorder.stop({ venue: 'garage' }))
    expect(recorder.recording).toBe(false)
    expect(header.captureTimesMs).toEqual([0, 2])
    expect(header.conditions).toEqual({ venue: 'garage', droppedMismatchedFrames: '2' })
  })

  it('start() resets state from the previous recording', () => {
    const recorder = new ContinuousRecorder(1)
    recorder.start()
    recorder.add(frame(0))
    recorder.add(frame(1))
    recorder.add(frame(2, 4, 4))
    recorder.stop()
    recorder.start()
    expect(recorder.frameCount).toBe(0)
    expect(recorder.truncated).toBe(false)
    expect(recorder.droppedMismatchedFrames).toBe(0)
    recorder.add(frame(2))
    expect(decodeClip(recorder.stop()).header.captureTimesMs).toEqual([2])
  })
})
