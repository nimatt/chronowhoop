// CPU strip reduction — the ADR 0003 per-frame shape (luminance → EMA
// background diff → threshold → hot-pixel count per vertical strip) as plain
// TypeScript over an RGBA pixel buffer. Written for the /diag CPU-pipeline
// probe that decides whether a CPU pipeline can replace WebGPU (the S22
// Xclipse finding, see ADR 0008); if adopted, this module is the seed of the
// production reduction stage.

export interface StripReduceConfig {
  // Vertical strips along the travel axis (x); detection.md default.
  stripCount: number
  // Per-frame EMA adaptation factor (detection.md default ~0.05). dt-scaling
  // is a Phase 3 concern; the probe runs at whatever rate the camera grants.
  alpha: number
  // Absolute luminance difference (0–255 scale) a pixel must EXCEED to count
  // as hot. Strictly greater-than: a diff exactly at the threshold is not hot.
  threshold: number
}

export const DEFAULT_STRIP_REDUCE_CONFIG: StripReduceConfig = {
  stripCount: 12,
  alpha: 0.05,
  threshold: 25,
}

// Rec. 709 luma, matching the GPU spike's luminance pass so CPU and GPU
// numbers stay comparable while both exist.
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// Owns the EMA background for one working resolution. The first processed
// frame seeds the background (all energies zero); a dimension change resets.
export class StripReducer {
  readonly config: StripReduceConfig
  #width = 0
  #height = 0
  #ema: Float32Array = new Float32Array(0)
  #seeded = false
  #energies: Uint32Array

  constructor(config: StripReduceConfig = DEFAULT_STRIP_REDUCE_CONFIG) {
    if (!Number.isInteger(config.stripCount) || config.stripCount < 1) {
      throw new Error(`stripCount must be a positive integer, got ${config.stripCount}`)
    }
    this.config = config
    this.#energies = new Uint32Array(config.stripCount)
  }

  get seeded(): boolean {
    return this.#seeded
  }

  reset(): void {
    this.#seeded = false
  }

  #prepare(width: number, height: number): void {
    if (width !== this.#width || height !== this.#height) {
      this.#width = width
      this.#height = height
      this.#ema = new Float32Array(width * height)
      this.#seeded = false
    }
  }

  // rgba is ImageData-shaped (4 bytes per pixel, row-major). Returns the
  // per-strip hot-pixel counts; the returned array is reused across calls.
  process(rgba: Uint8ClampedArray, width: number, height: number): Uint32Array {
    if (rgba.length < width * height * 4) {
      throw new Error(`pixel buffer too small: ${rgba.length} for ${width}×${height}`)
    }
    this.#prepare(width, height)
    const { stripCount, alpha, threshold } = this.config
    const ema = this.#ema
    const energies = this.#energies
    energies.fill(0)

    if (!this.#seeded) {
      for (let i = 0, p = 0; p < rgba.length; i++, p += 4) {
        ema[i] = luminance(rgba[p], rgba[p + 1], rgba[p + 2])
      }
      this.#seeded = true
      return energies
    }

    for (let y = 0; y < height; y++) {
      const row = y * width
      for (let x = 0; x < width; x++) {
        const i = row + x
        const p = i * 4
        const lum = luminance(rgba[p], rgba[p + 1], rgba[p + 2])
        const background = ema[i]
        if (Math.abs(lum - background) > threshold) {
          energies[Math.floor((x * stripCount) / width)]++
        }
        ema[i] = background + alpha * (lum - background)
      }
    }
    return energies
  }

  // Same reduction over a pre-extracted luminance plane (one byte per pixel,
  // row-major, no padding) — the WebCodecs path reads the camera frame's Y
  // plane directly, so no RGBA conversion exists to do.
  processLuminance(lum: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint32Array {
    if (lum.length < width * height) {
      throw new Error(`luminance buffer too small: ${lum.length} for ${width}×${height}`)
    }
    this.#prepare(width, height)
    const { stripCount, alpha, threshold } = this.config
    const ema = this.#ema
    const energies = this.#energies
    energies.fill(0)

    if (!this.#seeded) {
      for (let i = 0; i < width * height; i++) ema[i] = lum[i]
      this.#seeded = true
      return energies
    }

    for (let y = 0; y < height; y++) {
      const row = y * width
      for (let x = 0; x < width; x++) {
        const i = row + x
        const value = lum[i]
        const background = ema[i]
        if (Math.abs(value - background) > threshold) {
          energies[Math.floor((x * stripCount) / width)]++
        }
        ema[i] = background + alpha * (value - background)
      }
    }
    return energies
  }
}
