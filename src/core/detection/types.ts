// Contracts for the CPU detection pipeline (ADR 0009). Semantics live in
// docs/specs/detection.md (Capture + Reduction stage); the build-out is
// docs/plans/03-gpu-pipeline-lab.md.

// One working-resolution ROI luminance plane (one byte per pixel, row-major,
// no padding) plus its capture timestamp. Ownership transfers on emit: sources
// allocate per frame and never reuse `data`, so consumers (ring buffer, clip
// recorder) may retain frames without copying.
export interface LumaFrame {
  data: Uint8Array
  width: number
  height: number
  captureTimeMs: number
}

// One per processed frame: integer hot-pixel counts per strip (determinism is
// exact equality), plus each strip's pixel count so downstream normalization
// handles uneven strip widths.
export interface FrameSample {
  captureTimeMs: number
  energies: Uint32Array
  stripPixelCounts: Uint32Array
}

// Normalized to the camera frame: all fields in [0, 1].
export interface NormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

// Snapshotted into each session (detection.md "Tunables"). The EMA background
// adapts per unit time (dt-scaled from capture timestamps, plan 03 item 4),
// not per frame, so tunables transfer across delivered frame rates.
export interface DetectionTunables {
  roi: NormalizedRect
  stripCount: number
  triggerLevel: number
  emaTimeConstantMs: number
  threshold: number
}

// detection.md historically specified the EMA as "alpha ≈ 0.05 per frame",
// measured at 60 fps. Restated as a time constant: a per-frame factor a at
// frame interval dt corresponds to τ = −dt / ln(1 − a), so
// τ = −(1000/60) / ln(1 − 0.05) ≈ 324.9 ms. The reducer derives the effective
// per-frame factor back from τ as alphaEff = 1 − exp(−dt/τ).
export const EMA_TIME_CONSTANT_MS = -(1000 / 60) / Math.log(1 - 0.05)

export const DEFAULT_DETECTION_TUNABLES: DetectionTunables = {
  roi: { x: 0, y: 0, width: 1, height: 1 },
  stripCount: 12,
  // Fraction of a strip's pixels that must be hot (normalized energy) for the
  // strip to count as triggered. Placeholder default; detection.md says the
  // real value is auto-suggested from observed background noise (Phase 4).
  triggerLevel: 0.1,
  emaTimeConstantMs: EMA_TIME_CONSTANT_MS,
  // Absolute luminance difference (0–255) a pixel must EXCEED to count as hot.
  threshold: 25,
}
