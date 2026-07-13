// Parameterized strip-energy sequence generator (plan 04 item 4): the
// energy-level twin of SyntheticSource. Emits FrameSample[] directly — no
// pixels, no reducer — with mathematically-known ground truth, so the
// crossing-detector suite is an executable spec. Deterministic: noise takes
// an injectable seeded RNG (seededLcg), and RNG consumption is uniform across
// the full timeline (dropped frames consume noise too), so drop patterns
// never shift the noise of surviving frames.

import type { FrameSample } from './types'
import type { CrossingDirection } from './crossing-events'

export const DEFAULT_EVENT_LEVEL = 0.8

export interface SyntheticWave {
  direction: CrossingDirection
  // Leading-edge advance per timeline frame: fractional for slow crossings,
  // > 1 for race-speed strip-skipping.
  speedStripsPerFrame: number
  widthStrips: number
  // The leading edge occupies the entry strip at startFrame.
  startFrame: number
  // The wave vanishes after this frame (partial traversal); omitted = runs
  // until it exits the far edge or the clip ends.
  endFrame?: number
  // Normalized strip energy of occupied strips.
  level?: number
}

export interface SyntheticHover {
  strips: readonly number[]
  startFrame: number
  endFrame?: number
  level?: number
}

// A global energy step (AE/AWB adjustment, lighting change): every
// nonzero-pixel strip reads `level` for durationFrames. The default duration
// approximates the EMA re-adaptation span (~τ at 60 fps) an unpaused
// background would take to absorb a real lighting step.
export interface SyntheticTransient {
  frameIndex: number
  durationFrames?: number
  level?: number
}

const DEFAULT_TRANSIENT_DURATION_FRAMES = 18

export interface SyntheticSequenceOptions {
  stripCount: number
  frameCount: number
  frameIntervalMs?: number
  startTimeMs?: number
  // Pixels per strip (uniform); energies are round(level × stripPixelCount).
  stripPixelCount?: number
  // Strips reporting stripPixelCounts 0 and energy 0 (div-by-zero guard).
  zeroPixelStrips?: readonly number[]
  // Uniform noise floor in [0, noiseLevel) per strip per frame; requires rng.
  noiseLevel?: number
  rng?: () => number
  timestampJitterMs?: (frameIndex: number) => number
  // Dropped frames advance the timeline but are never emitted.
  isFrameDropped?: (frameIndex: number) => boolean
  waves?: readonly SyntheticWave[]
  hovers?: readonly SyntheticHover[]
  transient?: SyntheticTransient
}

// Ground truth for one wave, per the spec's timestamp anchor: the first
// DELIVERED frame whose leading edge has reached or passed the center
// boundary (progress ≥ floor(N/2)) while the wave is active — exactly what a
// correct detector must stamp.
export interface SequenceGroundTruth {
  direction: CrossingDirection
  crossingFrameIndex: number
  crossingTimeMs: number
}

export interface SyntheticSequence {
  samples: FrameSample[]
  // Aligned with options.waves; undefined where the wave never reaches the
  // center boundary on a delivered frame.
  groundTruth: (SequenceGroundTruth | undefined)[]
}

function waveLeadingProgress(wave: SyntheticWave, frameIndex: number): number | undefined {
  if (frameIndex < wave.startFrame) return undefined
  if (wave.endFrame !== undefined && frameIndex > wave.endFrame) return undefined
  return Math.floor(wave.speedStripsPerFrame * (frameIndex - wave.startFrame))
}

function applyWave(
  levels: Float64Array,
  wave: SyntheticWave,
  frameIndex: number,
  stripCount: number,
): void {
  const lead = waveLeadingProgress(wave, frameIndex)
  if (lead === undefined) return
  const level = wave.level ?? DEFAULT_EVENT_LEVEL
  const from = Math.max(0, lead - wave.widthStrips + 1)
  const to = Math.min(stripCount - 1, lead)
  for (let p = from; p <= to; p++) {
    const strip = wave.direction === 'ltr' ? p : stripCount - 1 - p
    if (level > levels[strip]) levels[strip] = level
  }
}

export function generateSyntheticSequence(options: SyntheticSequenceOptions): SyntheticSequence {
  const {
    stripCount,
    frameCount,
    frameIntervalMs = 1000 / 60,
    startTimeMs = 0,
    stripPixelCount = 1000,
    zeroPixelStrips = [],
    noiseLevel = 0,
    rng,
    timestampJitterMs,
    isFrameDropped,
    waves = [],
    hovers = [],
    transient,
  } = options
  if (!Number.isInteger(stripCount) || stripCount < 1) {
    throw new Error(`stripCount must be a positive integer, got ${stripCount}`)
  }
  if (!Number.isInteger(stripPixelCount) || stripPixelCount < 1) {
    throw new Error(`stripPixelCount must be a positive integer, got ${stripPixelCount}`)
  }
  if (noiseLevel > 0 && !rng) {
    throw new Error('noiseLevel > 0 requires an injectable rng (see seededLcg)')
  }

  const zeroSet = new Set(zeroPixelStrips)
  const stripPixelCounts = new Uint32Array(stripCount)
  for (let i = 0; i < stripCount; i++) {
    stripPixelCounts[i] = zeroSet.has(i) ? 0 : stripPixelCount
  }
  const timeAt = (frameIndex: number): number =>
    startTimeMs + frameIndex * frameIntervalMs + (timestampJitterMs?.(frameIndex) ?? 0)

  const samples: FrameSample[] = []
  const levels = new Float64Array(stripCount)
  for (let f = 0; f < frameCount; f++) {
    levels.fill(0)
    if (noiseLevel > 0 && rng) {
      for (let i = 0; i < stripCount; i++) levels[i] = rng() * noiseLevel
    }
    for (const wave of waves) applyWave(levels, wave, f, stripCount)
    for (const hover of hovers) {
      if (f < hover.startFrame || (hover.endFrame !== undefined && f > hover.endFrame)) continue
      const level = hover.level ?? DEFAULT_EVENT_LEVEL
      for (const strip of hover.strips) {
        if (level > levels[strip]) levels[strip] = level
      }
    }
    if (
      transient &&
      f >= transient.frameIndex &&
      f < transient.frameIndex + (transient.durationFrames ?? DEFAULT_TRANSIENT_DURATION_FRAMES)
    ) {
      const level = transient.level ?? DEFAULT_EVENT_LEVEL
      for (let i = 0; i < stripCount; i++) {
        if (level > levels[i]) levels[i] = level
      }
    }
    if (isFrameDropped?.(f)) continue
    const energies = new Uint32Array(stripCount)
    for (let i = 0; i < stripCount; i++) {
      energies[i] = zeroSet.has(i) ? 0 : Math.round(levels[i] * stripPixelCount)
    }
    samples.push({ captureTimeMs: timeAt(f), energies, stripPixelCounts: stripPixelCounts.slice() })
  }

  const centerProgress = Math.floor(stripCount / 2)
  const groundTruth = waves.map((wave): SequenceGroundTruth | undefined => {
    const lastActiveFrame = Math.min(wave.endFrame ?? Infinity, frameCount - 1)
    for (let f = wave.startFrame; f <= lastActiveFrame; f++) {
      if (isFrameDropped?.(f)) continue
      const lead = waveLeadingProgress(wave, f)
      if (lead !== undefined && lead >= centerProgress) {
        return { direction: wave.direction, crossingFrameIndex: f, crossingTimeMs: timeAt(f) }
      }
    }
    return undefined
  })

  return { samples, groundTruth }
}
