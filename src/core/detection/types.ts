// Contracts for the CPU detection pipeline (ADR 0009). Semantics live in
// docs/specs/detection.md (Capture + Reduction stage); the build-out is
// docs/plans/03-gpu-pipeline-lab.md. Deliberately minimal — Phase 3 owns the
// real work; this pins only the pipeline→state-machine seam.

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
