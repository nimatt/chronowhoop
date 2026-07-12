import { describe, expect, it } from 'vitest'
import { StripReducer } from './reducer'
import { EMA_TIME_CONSTANT_MS } from './types'
import type { LumaFrame } from './types'

function luma(values: number[], width: number, height: number, captureTimeMs: number): LumaFrame {
  return { data: Uint8Array.from(values), width, height, captureTimeMs }
}

const FRAME_60FPS_MS = 1000 / 60

describe('EMA_TIME_CONSTANT_MS', () => {
  it('restates "0.05 per frame at 60 fps" as τ = −(1000/60)/ln(1−0.05) ≈ 324.9 ms', () => {
    expect(EMA_TIME_CONSTANT_MS).toBeCloseTo(324.93, 2)
    // Round trip: one 60 fps frame interval yields alphaEff 0.05 again.
    expect(1 - Math.exp(-FRAME_60FPS_MS / EMA_TIME_CONSTANT_MS)).toBeCloseTo(0.05, 12)
  })
})

describe('StripReducer', () => {
  it('seeds on the first frame: zero energies, background = frame', () => {
    const reducer = new StripReducer({ stripCount: 2, threshold: 10, emaTimeConstantMs: 100 })
    const energies = reducer.process(luma([10, 20, 30, 40], 4, 1, 0))
    expect([...energies]).toEqual([0, 0])
    expect(reducer.seeded).toBe(true)
    expect([...reducer.snapshotBackground()]).toEqual([10, 20, 30, 40])
  })

  it('seeds on the first frame even when paused (no prior background to preserve)', () => {
    const reducer = new StripReducer({ stripCount: 1, threshold: 10, emaTimeConstantMs: 100 })
    expect([...reducer.process(luma([10, 20], 2, 1, 0), true)]).toEqual([0])
    expect(reducer.seeded).toBe(true)
    expect([...reducer.snapshotBackground()]).toEqual([10, 20])
  })

  it('computes strip pixel counts for uneven strip widths', () => {
    const reducer = new StripReducer({ stripCount: 2, threshold: 10, emaTimeConstantMs: 100 })
    expect([...reducer.stripPixelCounts]).toEqual([0, 0])
    // width 5: floor(x·2/5) buckets x∈{0,1,2}→0 and x∈{3,4}→1, ×2 rows.
    reducer.process(luma(new Array<number>(10).fill(100), 5, 2, 0))
    expect([...reducer.stripPixelCounts]).toEqual([6, 4])
  })

  it('counts hot pixels per strip with a strictly-greater-than threshold', () => {
    const reducer = new StripReducer({ stripCount: 2, threshold: 10, emaTimeConstantMs: 100 })
    reducer.process(luma(new Array<number>(8).fill(100), 4, 2, 0))
    // Diffs vs background 100: strip 0 gets 50 (hot) and 0; strip 1 gets
    // 11 (hot) and 10 (NOT hot — exactly at threshold); row 2 all 0.
    const energies = reducer.process(luma([150, 100, 111, 110, 100, 100, 100, 100], 4, 2, 16))
    expect([...energies]).toEqual([1, 1])
  })

  it('scales the EMA by capture-time delta: dt = τ·ln2 halves the gap each frame', () => {
    const reducer = new StripReducer({ stripCount: 1, threshold: 10, emaTimeConstantMs: 100 })
    const dt = 100 * Math.LN2
    reducer.process(luma([100], 1, 1, 0))
    reducer.process(luma([200], 1, 1, dt))
    expect(reducer.snapshotBackground()[0]).toBeCloseTo(150, 4)
    reducer.process(luma([200], 1, 1, 2 * dt))
    expect(reducer.snapshotBackground()[0]).toBeCloseTo(175, 4)
  })

  it('treats dt ≤ 0 as a minimal 1 ms step', () => {
    const reducer = new StripReducer({ stripCount: 1, threshold: 25, emaTimeConstantMs: 100 })
    reducer.process(luma([100], 1, 1, 1000))
    const energies = reducer.process(luma([200], 1, 1, 1000))
    expect([...energies]).toEqual([1])
    expect(reducer.snapshotBackground()[0]).toBeCloseTo(100 + 100 * (1 - Math.exp(-1 / 100)), 3)
  })

  it('clamps dt above 1000 ms so a stall never over-adapts', () => {
    const reducer = new StripReducer({ stripCount: 1, threshold: 25, emaTimeConstantMs: 1000 })
    reducer.process(luma([100], 1, 1, 0))
    reducer.process(luma([200], 1, 1, 60_000))
    expect(reducer.snapshotBackground()[0]).toBeCloseTo(100 + 100 * (1 - Math.exp(-1)), 3)
  })

  it('freezes the EMA while paused (stationary blob is not absorbed) and decays it once unpaused', () => {
    const reducer = new StripReducer({ stripCount: 1, threshold: 25, emaTimeConstantMs: 50 })
    reducer.process(luma([100], 1, 1, 0))
    let t = 0
    for (let i = 0; i < 20; i++) {
      t += FRAME_60FPS_MS
      expect([...reducer.process(luma([200], 1, 1, t), true)]).toEqual([1])
    }
    expect(reducer.snapshotBackground()[0]).toBe(100)
    // Unpaused: alphaEff = 1 − exp(−16.67/50) ≈ 0.2835 per frame. Each frame
    // counts against the background from before its own update, so the nth
    // unpaused frame sees a gap of 100·0.7165ⁿ⁻¹: the 5th sees ≈ 26.4 (still
    // hot), the 6th ≈ 18.9 (below the 25 threshold).
    const perFrame: number[] = []
    for (let i = 0; i < 6; i++) {
      t += FRAME_60FPS_MS
      perFrame.push(reducer.process(luma([200], 1, 1, t))[0])
    }
    expect(perFrame).toEqual([1, 1, 1, 1, 1, 0])
  })

  it('re-buckets on stripCount change without re-seeding the EMA', () => {
    const reducer = new StripReducer({ stripCount: 1, threshold: 10, emaTimeConstantMs: 1e9 })
    reducer.process(luma([100, 100, 100, 100], 4, 1, 0))
    reducer.configure({ stripCount: 2 })
    // A re-seed would report zero energies here; the persisted background
    // keeps the changed pixels hot, now bucketed into two strips.
    const energies = reducer.process(luma([150, 150, 100, 100], 4, 1, 16), true)
    expect([...energies]).toEqual([2, 0])
    expect([...reducer.stripPixelCounts]).toEqual([2, 2])
  })

  it('applies threshold changes on the next frame', () => {
    const reducer = new StripReducer({ stripCount: 1, threshold: 10, emaTimeConstantMs: 1e9 })
    reducer.process(luma([100], 1, 1, 0))
    expect([...reducer.process(luma([150], 1, 1, 16), true)]).toEqual([1])
    reducer.configure({ threshold: 60 })
    expect([...reducer.process(luma([150], 1, 1, 33), true)]).toEqual([0])
  })

  it('re-seeds on dimension change and on reset()', () => {
    const reducer = new StripReducer({ stripCount: 1, threshold: 10, emaTimeConstantMs: 100 })
    reducer.process(luma([100], 1, 1, 0))
    expect([...reducer.process(luma([200, 200], 2, 1, 16))]).toEqual([0])
    reducer.reset()
    expect(reducer.seeded).toBe(false)
    expect([...reducer.process(luma([50, 50], 2, 1, 33))]).toEqual([0])
  })

  it('produces equivalent EMA trajectories at 60 fps and 30 fps (dt-scaling)', () => {
    const run = (intervalMs: number, steps: number) => {
      const reducer = new StripReducer({ stripCount: 1, threshold: 25, emaTimeConstantMs: 325 })
      reducer.process(luma([50, 50, 50, 50], 2, 2, 0))
      for (let k = 1; k <= steps; k++) {
        reducer.process(luma([180, 180, 180, 180], 2, 2, k * intervalMs))
      }
      return reducer.snapshotBackground()
    }
    // Same scene, same 198 ms span: 12 frames at 16.5 ms vs 6 at 33 ms.
    const at60 = run(16.5, 12)
    const at30 = run(33, 6)
    const analytic = 180 - 130 * Math.exp(-198 / 325)
    for (let i = 0; i < at60.length; i++) {
      expect(at60[i]).toBeCloseTo(at30[i], 2)
      expect(at60[i]).toBeCloseTo(analytic, 2)
    }
  })

  it('matches the gap-free trajectory when frames are dropped (dt-scaling over gaps)', () => {
    const run = (droppedFrames: Set<number>) => {
      const reducer = new StripReducer({ stripCount: 1, threshold: 25, emaTimeConstantMs: 325 })
      reducer.process(luma([50], 1, 1, 0))
      for (let k = 1; k <= 12; k++) {
        if (droppedFrames.has(k)) continue
        reducer.process(luma([180], 1, 1, k * 16.5))
      }
      return reducer.snapshotBackground()[0]
    }
    expect(run(new Set([3, 4, 7]))).toBeCloseTo(run(new Set()), 2)
  })

  it('validates stripCount in the constructor and in configure()', () => {
    expect(() => new StripReducer({ stripCount: 0, threshold: 10, emaTimeConstantMs: 100 })).toThrow()
    const reducer = new StripReducer({ stripCount: 2, threshold: 10, emaTimeConstantMs: 100 })
    expect(() => reducer.configure({ stripCount: 1.5 })).toThrow()
  })

  it('rejects a luminance buffer smaller than the stated dimensions', () => {
    const reducer = new StripReducer({ stripCount: 1, threshold: 10, emaTimeConstantMs: 100 })
    expect(() => reducer.process(luma([1, 2, 3], 2, 2, 0))).toThrow()
  })
})
