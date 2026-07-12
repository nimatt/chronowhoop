import { describe, expect, it } from 'vitest'
import { computeDrift, computeLatencyStats, medianOf, quantileOf } from './readback-stats'

describe('medianOf / quantileOf', () => {
  it('interpolates the median of an even-length list', () => {
    expect(medianOf([4, 1, 3, 2])).toBe(2.5)
  })

  it('takes the middle of an odd-length list', () => {
    expect(medianOf([9, 1, 5])).toBe(5)
  })

  it('nearest-rank quantile: p95 of four values is the max', () => {
    // ceil(0.95 × 4) = 4 → 4th smallest.
    expect(quantileOf([1, 2, 3, 4], 0.95)).toBe(4)
  })

  it('nearest-rank quantile: p50 of [10, 20] is the lower value', () => {
    // ceil(0.5 × 2) = 1 → 1st smallest.
    expect(quantileOf([20, 10], 0.5)).toBe(10)
  })
})

describe('computeLatencyStats', () => {
  it('is undefined for no samples', () => {
    expect(computeLatencyStats([])).toBeUndefined()
  })

  it('computes hand-checked stats', () => {
    // sorted: [2, 4, 6, 8]; mean 5; median (4+6)/2; p95 nearest-rank → 8.
    expect(computeLatencyStats([8, 2, 6, 4])).toEqual({
      count: 4,
      meanMs: 5,
      medianMs: 5,
      p95Ms: 8,
      maxMs: 8,
    })
  })

  it('a single sample is its own median/p95/max', () => {
    expect(computeLatencyStats([7])).toEqual({
      count: 1,
      meanMs: 7,
      medianMs: 7,
      p95Ms: 7,
      maxMs: 7,
    })
  })
})

describe('computeDrift', () => {
  it('is undefined until early and late windows are disjoint', () => {
    expect(computeDrift([10, 10, 10, 10, 10], 3)).toBeUndefined()
    expect(computeDrift([10, 10, 10, 10, 10, 10], 3)).toBeDefined()
  })

  it('reports no upward drift for a flat run', () => {
    expect(computeDrift([10, 10, 10, 10, 10, 10], 3, 0.2)).toEqual({
      windowSize: 3,
      earlyMedianMs: 10,
      lateMedianMs: 10,
      driftMs: 0,
      driftFraction: 0,
      upwardDrift: false,
      thresholdFraction: 0.2,
    })
  })

  it('flags drift above the threshold fraction', () => {
    // early median 10, late median 13 → +30% > 20% threshold.
    const report = computeDrift([10, 10, 10, 13, 13, 13], 3, 0.2)
    expect(report).toMatchObject({
      earlyMedianMs: 10,
      lateMedianMs: 13,
      driftMs: 3,
      upwardDrift: true,
    })
    expect(report!.driftFraction).toBeCloseTo(0.3, 10)
  })

  it('does not flag drift at exactly the threshold, or downward drift', () => {
    expect(computeDrift([10, 10, 10, 12, 12, 12], 3, 0.2)!.upwardDrift).toBe(false)
    expect(computeDrift([13, 13, 13, 10, 10, 10], 3, 0.2)).toMatchObject({
      driftMs: -3,
      upwardDrift: false,
    })
  })

  it('uses windows from the ends of a longer run', () => {
    const samples = [1, 1, 5, 5, 5, 5, 9, 9]
    expect(computeDrift(samples, 2, 0.2)).toMatchObject({
      earlyMedianMs: 1,
      lateMedianMs: 9,
      driftMs: 8,
      upwardDrift: true,
    })
  })
})
