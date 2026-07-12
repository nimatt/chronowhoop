// Rolling per-frame pipeline-cost measurement for the /lab live panel: the
// tee→sample turnaround (frame handed to the pipeline → FrameSample emitted),
// which covers ring-buffer push + reduction + listener fan-out. It does NOT
// include CameraSource's copyTo/subsample stage (stats() carries no per-stage
// timings by design — the /diag WebCodecs probe measures that half), so the
// ADR 0008/0009 on-device budget check reads this alongside the delivered
// frame rate. Stats math is shared with the readback benchmark.

import { computeLatencyStats, type LatencyStats } from '../../core/stats/latency-stats'

export const DEFAULT_COST_WINDOW_SIZE = 600
export const FPS_WINDOW_MS = 2000

export class PipelineCostTracker {
  readonly #windowSize: number
  #costs: number[] = []
  #arrivals: number[] = []
  #frameStartMs: number | undefined
  #frames = 0

  constructor(windowSize = DEFAULT_COST_WINDOW_SIZE) {
    if (!Number.isInteger(windowSize) || windowSize < 1) {
      throw new Error(`windowSize must be a positive integer, got ${windowSize}`)
    }
    this.#windowSize = windowSize
  }

  get frames(): number {
    return this.#frames
  }

  markFrameStart(nowMs: number): void {
    this.#frameStartMs = nowMs
  }

  markSampleDone(nowMs: number): void {
    this.#frames++
    if (this.#frameStartMs !== undefined) {
      this.#costs.push(nowMs - this.#frameStartMs)
      if (this.#costs.length > this.#windowSize) this.#costs.shift()
      this.#frameStartMs = undefined
    }
    this.#arrivals.push(nowMs)
    const cutoff = nowMs - FPS_WINDOW_MS
    while (this.#arrivals.length > 0 && this.#arrivals[0] < cutoff) this.#arrivals.shift()
  }

  costStats(): LatencyStats | undefined {
    return computeLatencyStats(this.#costs)
  }

  // Samples per second over the last FPS_WINDOW_MS, measured between the
  // first and last arrival still inside the window; null until two samples
  // have arrived.
  rollingFps(nowMs: number): number | null {
    const cutoff = nowMs - FPS_WINDOW_MS
    while (this.#arrivals.length > 0 && this.#arrivals[0] < cutoff) this.#arrivals.shift()
    if (this.#arrivals.length < 2) return null
    const spanMs = this.#arrivals[this.#arrivals.length - 1] - this.#arrivals[0]
    if (spanMs <= 0) return null
    return ((this.#arrivals.length - 1) * 1000) / spanMs
  }

  reset(): void {
    this.#costs = []
    this.#arrivals = []
    this.#frameStartMs = undefined
    this.#frames = 0
  }
}
