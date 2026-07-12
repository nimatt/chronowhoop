import { describe, expect, it } from 'vitest'
import { SyntheticSource, seededLcg } from './synthetic-source'
import type { SyntheticSourceOptions } from './synthetic-source'
import type { LumaFrame } from './types'

function collect(source: SyntheticSource): LumaFrame[] {
  const frames: LumaFrame[] = []
  source.start((f) => frames.push(f))
  source.pumpAll()
  return frames
}

describe('seededLcg', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = seededLcg(42)
    const b = seededLcg(42)
    for (let i = 0; i < 100; i++) {
      const value = a()
      expect(b()).toBe(value)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
    expect(seededLcg(7)()).not.toBe(seededLcg(42)())
  })
})

describe('SyntheticSource', () => {
  it('emits flat background frames at nominal 60 fps pacing by default', () => {
    const frames = collect(
      new SyntheticSource({ width: 3, height: 2, frameCount: 2, backgroundLevel: 40 }),
    )
    expect(frames).toHaveLength(2)
    expect([...frames[0].data]).toEqual([40, 40, 40, 40, 40, 40])
    expect(frames[0].captureTimeMs).toBe(0)
    expect(frames[1].captureTimeMs).toBeCloseTo(1000 / 60, 10)
  })

  it('applies startTimeMs, frameIntervalMs, and per-frame jitter to capture times', () => {
    const source = new SyntheticSource({
      width: 1,
      height: 1,
      frameCount: 3,
      startTimeMs: 100,
      frameIntervalMs: 10,
      frameJitterMs: (f) => f * 0.5,
    })
    expect(collect(source).map((f) => f.captureTimeMs)).toEqual([100, 110.5, 121])
  })

  it('moves the blob by whole pixels along the travel axis', () => {
    // center(k) = −1.5 + 2k → painted columns 2k−2 .. 2k−1.
    const source = new SyntheticSource({
      width: 10,
      height: 1,
      frameCount: 7,
      backgroundLevel: 20,
      blob: { widthPx: 2, intensity: 200, speedPxPerFrame: 2, direction: 1, startFrame: 0 },
    })
    const frames = collect(source)
    const blobColumns = (f: LumaFrame) =>
      [...f.data].flatMap((v, x) => (v === 200 ? [x] : []))
    expect(blobColumns(frames[0])).toEqual([])
    expect(blobColumns(frames[1])).toEqual([0, 1])
    expect(blobColumns(frames[3])).toEqual([4, 5])
    expect(blobColumns(frames[5])).toEqual([8, 9])
    expect(blobColumns(frames[6])).toEqual([])
  })

  it('exposes the mathematically-known crossing frame and time', () => {
    const source = new SyntheticSource({
      width: 10,
      height: 1,
      frameCount: 7,
      frameIntervalMs: 10,
      blob: { widthPx: 2, intensity: 200, speedPxPerFrame: 2, direction: 1, startFrame: 0 },
    })
    // midX = 4.5; center starts at −1.5, so 6 px / 2 px·frame⁻¹ = 3 frames.
    expect(source.groundTruth).toEqual({ crossingFrameIndex: 3, crossingTimeMs: 30 })
  })

  it('mirrors blob entry and ground truth for direction −1', () => {
    const source = new SyntheticSource({
      width: 10,
      height: 1,
      frameCount: 7,
      frameIntervalMs: 10,
      backgroundLevel: 20,
      blob: { widthPx: 2, intensity: 200, speedPxPerFrame: 2, direction: -1, startFrame: 0 },
    })
    const frames = collect(source)
    expect([...frames[1].data].flatMap((v, x) => (v === 200 ? [x] : []))).toEqual([8, 9])
    expect(source.groundTruth).toEqual({ crossingFrameIndex: 3, crossingTimeMs: 30 })
  })

  it('supports stationary blobs via startCenterX (no ground-truth crossing)', () => {
    const source = new SyntheticSource({
      width: 4,
      height: 2,
      frameCount: 3,
      backgroundLevel: 10,
      blob: {
        widthPx: 2,
        intensity: 99,
        speedPxPerFrame: 0,
        direction: 1,
        startFrame: 1,
        startCenterX: 0.5,
      },
    })
    const frames = collect(source)
    expect([...frames[0].data]).toEqual([10, 10, 10, 10, 10, 10, 10, 10])
    expect([...frames[1].data]).toEqual([99, 99, 10, 10, 99, 99, 10, 10])
    expect([...frames[2].data]).toEqual([99, 99, 10, 10, 99, 99, 10, 10])
    expect(source.groundTruth).toBeUndefined()
  })

  it('removes the blob after endFrame and reports no crossing past it', () => {
    const options: SyntheticSourceOptions = {
      width: 10,
      height: 1,
      frameCount: 7,
      backgroundLevel: 20,
      blob: {
        widthPx: 2,
        intensity: 200,
        speedPxPerFrame: 2,
        direction: 1,
        startFrame: 0,
        endFrame: 2,
      },
    }
    const frames = collect(new SyntheticSource(options))
    expect([...frames[2].data].includes(200)).toBe(true)
    expect([...frames[3].data].includes(200)).toBe(false)
    expect(new SyntheticSource(options).groundTruth).toBeUndefined()
  })

  it('applies a global transient step from its frame onward', () => {
    const frames = collect(
      new SyntheticSource({
        width: 2,
        height: 1,
        frameCount: 4,
        backgroundLevel: 10,
        transient: { frameIndex: 2, delta: 100 },
      }),
    )
    expect(frames.map((f) => f.data[0])).toEqual([10, 10, 110, 110])
  })

  it('adds injectable noise and clamps pixel values to 0–255', () => {
    const rng = seededLcg(1)
    const frames = collect(
      new SyntheticSource({
        width: 2,
        height: 1,
        frameCount: 1,
        backgroundLevel: 250,
        noise: () => rng() * 20,
      }),
    )
    for (const value of frames[0].data) {
      expect(value).toBeLessThanOrEqual(255)
      expect(value).toBeGreaterThanOrEqual(250)
    }
  })

  it('skips dropped frames but keeps the timeline advancing', () => {
    const source = new SyntheticSource({
      width: 1,
      height: 1,
      frameCount: 4,
      frameIntervalMs: 10,
      isFrameDropped: (f) => f === 1 || f === 2,
    })
    const frames: LumaFrame[] = []
    source.start((f) => frames.push(f))
    expect(source.pump(4)).toBe(2)
    expect(frames.map((f) => f.captureTimeMs)).toEqual([0, 30])
    expect(source.nextFrameIndex).toBe(4)
  })

  it('pumps on demand, stops at frameCount, and requires start()', () => {
    const source = new SyntheticSource({ width: 1, height: 1, frameCount: 3 })
    expect(() => source.pump()).toThrow()
    const frames: LumaFrame[] = []
    source.start((f) => frames.push(f))
    expect(source.pump()).toBe(1)
    expect(source.pump(10)).toBe(2)
    expect(source.pump(10)).toBe(0)
    expect(frames).toHaveLength(3)
    source.stop()
    expect(() => source.pump()).toThrow()
  })

  it('generates bit-identical frames for identical parameterizations', () => {
    const options = (): SyntheticSourceOptions => {
      const rng = seededLcg(9)
      return {
        width: 6,
        height: 4,
        frameCount: 5,
        backgroundLevel: 30,
        noise: () => (rng() - 0.5) * 10,
        blob: { widthPx: 2, intensity: 220, speedPxPerFrame: 1, direction: 1, startFrame: 1 },
      }
    }
    const a = collect(new SyntheticSource(options()))
    const b = collect(new SyntheticSource(options()))
    expect(a).toEqual(b)
  })
})
