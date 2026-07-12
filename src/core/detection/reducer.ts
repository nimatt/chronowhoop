// Detection-owned strip reduction (plan 03 item 4): the ADR 0003 per-frame
// shape (luminance → EMA background diff → threshold → hot-pixel count per
// vertical strip), evolved from the src/core/cpu-pipeline spike's StripReducer
// with the two decisions written into detection.md:
// - the EMA adapts per unit time (dt-scaled from capture timestamps), not per
//   frame, so tunables transfer across delivered frame rates and dropped
//   frames replay exactly;
// - strip energy stays an integer hot-pixel count, normalized by strip pixel
//   count downstream, so determinism is exact equality.
// The spike module stays frozen as a /diag instrument.

import type { LumaFrame } from './types'

export interface StripReducerConfig {
  stripCount: number
  // Absolute luminance difference (0–255) a pixel must EXCEED to count as
  // hot. Strictly greater-than: a diff exactly at the threshold is not hot
  // (pinned by the spike's golden tests, kept identical here).
  threshold: number
  emaTimeConstantMs: number
}

// dt clamps: capture timestamps should be monotonic with sane gaps, but the
// EMA must stay well-behaved if they aren't. dt ≤ 0 (non-monotonic or
// duplicate timestamps) is treated as a minimal 1 ms step — the background
// barely moves rather than jumping or throwing. dt above 1000 ms (a stall or
// tab suspension) is clamped so a single frame never absorbs more than one
// second's worth of adaptation.
export const MIN_DT_MS = 1
export const MAX_DT_MS = 1000

function validateStripCount(stripCount: number): void {
  if (!Number.isInteger(stripCount) || stripCount < 1) {
    throw new Error(`stripCount must be a positive integer, got ${stripCount}`)
  }
}

// Owns the per-pixel EMA background for one working resolution. The first
// processed frame seeds the background (all energies zero) — even when
// paused, since there is no prior background to preserve; a dimension change
// re-seeds. Config changes (stripCount/threshold/τ) take effect on the next
// frame; a stripCount change only re-buckets the counts — the EMA persists.
export class StripReducer {
  #stripCount: number
  #threshold: number
  #emaTimeConstantMs: number
  #width = 0
  #height = 0
  #ema = new Float32Array(0)
  #seeded = false
  #lastCaptureTimeMs = 0
  #stripOfX = new Uint16Array(0)
  #stripPixelCounts: Uint32Array
  #energies: Uint32Array

  constructor(config: StripReducerConfig) {
    validateStripCount(config.stripCount)
    this.#stripCount = config.stripCount
    this.#threshold = config.threshold
    this.#emaTimeConstantMs = config.emaTimeConstantMs
    this.#stripPixelCounts = new Uint32Array(config.stripCount)
    this.#energies = new Uint32Array(config.stripCount)
  }

  get seeded(): boolean {
    return this.#seeded
  }

  // Per-strip pixel counts for the current dimensions (all zero before the
  // first frame) — the normalization denominators emitted in FrameSamples.
  get stripPixelCounts(): Uint32Array {
    return this.#stripPixelCounts
  }

  configure(partial: Partial<StripReducerConfig>): void {
    if (partial.threshold !== undefined) this.#threshold = partial.threshold
    if (partial.emaTimeConstantMs !== undefined) this.#emaTimeConstantMs = partial.emaTimeConstantMs
    if (partial.stripCount !== undefined && partial.stripCount !== this.#stripCount) {
      validateStripCount(partial.stripCount)
      this.#stripCount = partial.stripCount
      this.#stripPixelCounts = new Uint32Array(partial.stripCount)
      this.#energies = new Uint32Array(partial.stripCount)
      this.#rebucket()
    }
  }

  reset(): void {
    this.#seeded = false
  }

  // Copy of the current EMA background (row-major, current dims) — a test
  // seam for validating dt-scaling trajectories; no production consumer.
  snapshotBackground(): Float32Array {
    return this.#ema.slice(0, this.#width * this.#height)
  }

  #prepare(width: number, height: number): void {
    if (width !== this.#width || height !== this.#height) {
      this.#width = width
      this.#height = height
      this.#ema = new Float32Array(width * height)
      this.#seeded = false
      this.#rebucket()
    }
  }

  #rebucket(): void {
    const width = this.#width
    const stripCount = this.#stripCount
    this.#stripOfX = new Uint16Array(width)
    this.#stripPixelCounts.fill(0)
    for (let x = 0; x < width; x++) {
      const strip = Math.floor((x * stripCount) / width)
      this.#stripOfX[x] = strip
      this.#stripPixelCounts[strip] += this.#height
    }
  }

  // Reduces one frame to per-strip hot-pixel counts; the returned array is
  // reused across calls (copy before retaining). When paused
  // (crossingInProgress, Phase 4 wires the timeout) the diff and counts are
  // still computed but the EMA is NOT updated, so the drone doesn't absorb
  // into the background. Paused frames still advance the last-capture
  // timestamp: dt is always the per-frame delta, so unpausing adapts at the
  // normal per-frame rate instead of integrating the whole pause span (which
  // would partially absorb exactly what the pause protected).
  process(frame: LumaFrame, pause = false): Uint32Array {
    const { data, width, height, captureTimeMs } = frame
    if (data.length < width * height) {
      throw new Error(`luminance buffer too small: ${data.length} for ${width}×${height}`)
    }
    this.#prepare(width, height)
    const energies = this.#energies
    energies.fill(0)

    if (!this.#seeded) {
      this.#ema.set(data.subarray(0, width * height))
      this.#seeded = true
      this.#lastCaptureTimeMs = captureTimeMs
      return energies
    }

    let dtMs = captureTimeMs - this.#lastCaptureTimeMs
    if (dtMs <= 0) dtMs = MIN_DT_MS
    else if (dtMs > MAX_DT_MS) dtMs = MAX_DT_MS
    this.#lastCaptureTimeMs = captureTimeMs

    const alphaEff = 1 - Math.exp(-dtMs / this.#emaTimeConstantMs)
    const threshold = this.#threshold
    const ema = this.#ema
    const stripOfX = this.#stripOfX

    for (let y = 0; y < height; y++) {
      const row = y * width
      for (let x = 0; x < width; x++) {
        const i = row + x
        const value = data[i]
        const background = ema[i]
        if (Math.abs(value - background) > threshold) {
          energies[stripOfX[x]]++
        }
        if (!pause) {
          ema[i] = background + alphaEff * (value - background)
        }
      }
    }
    return energies
  }
}
