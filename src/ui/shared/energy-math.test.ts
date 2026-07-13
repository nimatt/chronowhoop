import { describe, expect, it } from 'vitest'
import { maxNormalizedEnergy, normalizeEnergies, timelinePoints } from './energy-math'

describe('normalizeEnergies', () => {
  it('divides each energy by its strip pixel count', () => {
    expect(normalizeEnergies([10, 0, 36], [100, 100, 72])).toEqual([0.1, 0, 0.5])
  })

  it('a zero denominator normalizes to 0, not NaN', () => {
    expect(normalizeEnergies([5, 3], [0, 10])).toEqual([0, 0.3])
  })

  it('works on typed arrays (the FrameSample shape)', () => {
    expect(normalizeEnergies(new Uint32Array([4]), new Uint32Array([16]))).toEqual([0.25])
  })
})

describe('maxNormalizedEnergy', () => {
  it('returns the max ratio', () => {
    expect(maxNormalizedEnergy([10, 50, 36], [100, 100, 72])).toBe(0.5)
  })

  it('ignores zero-denominator strips and returns 0 for empty input', () => {
    expect(maxNormalizedEnergy([99, 1], [0, 10])).toBe(0.1)
    expect(maxNormalizedEnergy([], [])).toBe(0)
  })
})

describe('timelinePoints', () => {
  it('spreads frame indices over the width and inverts y', () => {
    expect(timelinePoints([0, 0.5, 1], 200, 100)).toEqual([
      [0, 100],
      [100, 50],
      [200, 0],
    ])
  })

  it('a single value lands at x = 0', () => {
    expect(timelinePoints([0.25], 200, 100)).toEqual([[0, 75]])
  })

  it('clamps out-of-range values to the canvas edges', () => {
    expect(timelinePoints([-1, 2], 100, 100)).toEqual([
      [0, 100],
      [100, 0],
    ])
  })

  it('empty input yields no points', () => {
    expect(timelinePoints([], 100, 100)).toEqual([])
  })
})
