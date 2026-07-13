import { describe, expect, it } from 'vitest'
import type { FrameSample } from './types'
import {
  TriggerLevelCollector,
  TRIGGER_SUGGESTION_MAX,
  TRIGGER_SUGGESTION_MIN,
  suggestTriggerLevel,
} from './trigger-suggest'

function sample(captureTimeMs: number, levels: readonly number[], pixels = 1000): FrameSample {
  return {
    captureTimeMs,
    energies: Uint32Array.from(levels.map((level) => Math.round(level * pixels))),
    stripPixelCounts: Uint32Array.from(levels.map(() => pixels)),
  }
}

// `count` samples spanning exactly (count − 1) × 100 ms.
function quietWindow(count: number, levels: readonly number[]): FrameSample[] {
  return Array.from({ length: count }, (_, i) => sample(i * 100, levels))
}

describe('suggestTriggerLevel', () => {
  it('needs at least quietWindowMs of capture-time span', () => {
    const levels = [0.01, 0.01, 0.01]
    expect(suggestTriggerLevel(quietWindow(30, levels))).toBeUndefined() // 2900 ms
    expect(suggestTriggerLevel(quietWindow(31, levels))).toBe(0.03) // 3000 ms
  })

  it('suggests p95 of observed strip levels × marginFactor', () => {
    // 31 frames × 4 strips = 124 observations, all 0.02 → p95 = 0.02, × 3.
    expect(suggestTriggerLevel(quietWindow(31, [0.02, 0.02, 0.02, 0.02]))).toBeCloseTo(0.06, 12)
  })

  it('p95 is nearest-rank: a single outlier above the 95th rank is ignored', () => {
    // 40 frames × 1 strip: 38 at 0.01, frames 5 and 9 spike. Nearest-rank
    // p95 of 40 values is the 38th (index 37) — the two spikes at indices
    // 38–39 are excluded.
    const samples = Array.from({ length: 40 }, (_, i) =>
      sample(i * 100, [i === 5 || i === 9 ? 0.4 : 0.01]),
    )
    expect(suggestTriggerLevel(samples)).toBe(0.03)
  })

  it('clamps to [0.02, 0.5]', () => {
    expect(suggestTriggerLevel(quietWindow(31, [0, 0, 0]))).toBe(TRIGGER_SUGGESTION_MIN)
    expect(suggestTriggerLevel(quietWindow(31, [0.3, 0.3, 0.3]))).toBe(TRIGGER_SUGGESTION_MAX)
  })

  it('skips zero-pixel strips', () => {
    const samples = Array.from({ length: 31 }, (_, i): FrameSample => {
      return {
        captureTimeMs: i * 100,
        energies: Uint32Array.from([999, 10]),
        stripPixelCounts: Uint32Array.from([0, 1000]),
      }
    })
    expect(suggestTriggerLevel(samples)).toBe(0.03)
  })

  it('honors config overrides', () => {
    const levels = [0.01]
    expect(suggestTriggerLevel(quietWindow(11, levels), { quietWindowMs: 1000 })).toBe(0.03)
    expect(
      suggestTriggerLevel(quietWindow(11, levels), { quietWindowMs: 1000, marginFactor: 4 }),
    ).toBe(0.04)
  })
})

describe('TriggerLevelCollector', () => {
  it('becomes ready incrementally and refines with more samples', () => {
    const collector = new TriggerLevelCollector()
    for (let i = 0; i < 30; i++) collector.add(sample(i * 100, [0.01]))
    expect(collector.ready).toBe(false)
    expect(collector.suggestion).toBeUndefined()
    collector.add(sample(3000, [0.01]))
    expect(collector.ready).toBe(true)
    expect(collector.observedSpanMs).toBe(3000)
    expect(collector.suggestion).toBe(0.03)
  })

  it('reset() starts a fresh window', () => {
    const collector = new TriggerLevelCollector()
    for (let i = 0; i < 31; i++) collector.add(sample(i * 100, [0.01]))
    expect(collector.ready).toBe(true)
    collector.reset()
    expect(collector.ready).toBe(false)
    expect(collector.observedSpanMs).toBe(0)
    expect(collector.suggestion).toBeUndefined()
  })

  it('validates its config', () => {
    expect(() => new TriggerLevelCollector({ quietWindowMs: 0 })).toThrow(/quietWindowMs/)
    expect(() => new TriggerLevelCollector({ marginFactor: 0 })).toThrow(/marginFactor/)
  })
})
