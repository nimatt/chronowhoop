import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EVENT_LEVEL,
  generateSyntheticSequence,
  type SyntheticSequenceOptions,
} from './synthetic-sequences'
import { seededLcg } from './synthetic-source'

const INTERVAL = 1000 / 60

function levelsOf(sample: { energies: Uint32Array; stripPixelCounts: Uint32Array }): number[] {
  return [...sample.energies].map((e, i) =>
    sample.stripPixelCounts[i] === 0 ? 0 : e / sample.stripPixelCounts[i],
  )
}

const base: SyntheticSequenceOptions = { stripCount: 12, frameCount: 30 }

describe('generateSyntheticSequence', () => {
  it('is deterministic for identical options and seeds', () => {
    const make = () =>
      generateSyntheticSequence({
        ...base,
        noiseLevel: 0.05,
        rng: seededLcg(11),
        waves: [{ direction: 'ltr', speedStripsPerFrame: 1.5, widthStrips: 2, startFrame: 3 }],
      })
    const a = make()
    const b = make()
    expect(a.samples.map((s) => [...s.energies])).toEqual(b.samples.map((s) => [...s.energies]))
    expect(a.samples.map((s) => s.captureTimeMs)).toEqual(b.samples.map((s) => s.captureTimeMs))
  })

  it('paces timestamps at the frame interval plus jitter', () => {
    const { samples } = generateSyntheticSequence({
      ...base,
      frameCount: 4,
      startTimeMs: 100,
      timestampJitterMs: (f) => f * 0.5,
    })
    expect(samples.map((s) => s.captureTimeMs)).toEqual([
      100,
      100 + INTERVAL + 0.5,
      100 + 2 * INTERVAL + 1,
      100 + 3 * INTERVAL + 1.5,
    ])
  })

  it('advances the wave leading edge by speed × frames with width behind it', () => {
    const { samples } = generateSyntheticSequence({
      ...base,
      waves: [{ direction: 'ltr', speedStripsPerFrame: 3, widthStrips: 2, startFrame: 2 }],
    })
    expect(levelsOf(samples[1]).every((l) => l === 0)).toBe(true)
    // Frame 2: lead 0, width clamped at the left edge.
    expect(levelsOf(samples[2])[0]).toBe(DEFAULT_EVENT_LEVEL)
    expect(levelsOf(samples[2]).slice(1).every((l) => l === 0)).toBe(true)
    // Frame 4: lead 6 → strips 5 and 6.
    const frame4 = levelsOf(samples[4])
    expect(frame4[5]).toBe(DEFAULT_EVENT_LEVEL)
    expect(frame4[6]).toBe(DEFAULT_EVENT_LEVEL)
    expect(frame4.filter((l) => l > 0)).toHaveLength(2)
    // Frame 7: lead 15 → fully exited.
    expect(levelsOf(samples[7]).every((l) => l === 0)).toBe(true)
  })

  it('mirrors rtl waves in strip-index space', () => {
    const { samples } = generateSyntheticSequence({
      ...base,
      waves: [{ direction: 'rtl', speedStripsPerFrame: 1, widthStrips: 1, startFrame: 0 }],
    })
    expect(levelsOf(samples[0])[11]).toBe(DEFAULT_EVENT_LEVEL)
    expect(levelsOf(samples[3])[8]).toBe(DEFAULT_EVENT_LEVEL)
  })

  it('computes center-boundary ground truth (progress ≥ floor(N/2))', () => {
    const options: SyntheticSequenceOptions = {
      ...base,
      waves: [
        { direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 },
        { direction: 'rtl', speedStripsPerFrame: 3.5, widthStrips: 2, startFrame: 5 },
      ],
    }
    const { groundTruth } = generateSyntheticSequence(options)
    expect(groundTruth[0]).toEqual({
      direction: 'ltr',
      crossingFrameIndex: 11,
      crossingTimeMs: 11 * INTERVAL,
    })
    // floor(3.5 × 2) = 7 ≥ 6 at frame 7.
    expect(groundTruth[1]?.crossingFrameIndex).toBe(7)
  })

  it('ground truth skips dropped frames (first DELIVERED frame at/after center)', () => {
    const { samples, groundTruth } = generateSyntheticSequence({
      ...base,
      isFrameDropped: (f) => f === 11,
      waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5 }],
    })
    expect(groundTruth[0]?.crossingFrameIndex).toBe(12)
    expect(samples.map((s) => s.captureTimeMs)).not.toContain(11 * INTERVAL)
    expect(samples).toHaveLength(29)
  })

  it('marks truncated waves (never reach center) as undefined ground truth', () => {
    const { groundTruth } = generateSyntheticSequence({
      ...base,
      waves: [{ direction: 'ltr', speedStripsPerFrame: 1, widthStrips: 2, startFrame: 5, endFrame: 9 }],
    })
    expect(groundTruth[0]).toBeUndefined()
  })

  it('global transient lifts every strip for its duration', () => {
    const { samples } = generateSyntheticSequence({
      ...base,
      transient: { frameIndex: 4, durationFrames: 2, level: 0.6 },
    })
    expect(levelsOf(samples[3]).every((l) => l === 0)).toBe(true)
    expect(levelsOf(samples[4]).every((l) => l === 0.6)).toBe(true)
    expect(levelsOf(samples[5]).every((l) => l === 0.6)).toBe(true)
    expect(levelsOf(samples[6]).every((l) => l === 0)).toBe(true)
  })

  it('hover holds its strips hot over its frame range', () => {
    const { samples } = generateSyntheticSequence({
      ...base,
      hovers: [{ strips: [4, 5], startFrame: 2, endFrame: 3, level: 0.7 }],
    })
    expect(levelsOf(samples[2])[4]).toBe(0.7)
    expect(levelsOf(samples[3])[5]).toBe(0.7)
    expect(levelsOf(samples[4]).every((l) => l === 0)).toBe(true)
  })

  it('zero-pixel strips report zero pixels and zero energy even under a transient', () => {
    const { samples } = generateSyntheticSequence({
      ...base,
      zeroPixelStrips: [3],
      transient: { frameIndex: 0, durationFrames: 30 },
    })
    for (const sample of samples) {
      expect(sample.stripPixelCounts[3]).toBe(0)
      expect(sample.energies[3]).toBe(0)
      expect(sample.energies[4]).toBeGreaterThan(0)
    }
  })

  it('bounds noise by noiseLevel and requires an rng', () => {
    const { samples } = generateSyntheticSequence({
      ...base,
      noiseLevel: 0.05,
      rng: seededLcg(1),
    })
    for (const sample of samples) {
      for (const level of levelsOf(sample)) {
        expect(level).toBeGreaterThanOrEqual(0)
        expect(level).toBeLessThan(0.051)
      }
    }
    expect(() => generateSyntheticSequence({ ...base, noiseLevel: 0.05 })).toThrow(/rng/)
  })

  it('validates stripCount and stripPixelCount', () => {
    expect(() => generateSyntheticSequence({ stripCount: 0, frameCount: 1 })).toThrow(/stripCount/)
    expect(() =>
      generateSyntheticSequence({ stripCount: 12, frameCount: 1, stripPixelCount: 0 }),
    ).toThrow(/stripPixelCount/)
  })
})
