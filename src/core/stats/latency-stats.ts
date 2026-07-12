// Pure latency-stats math, born in the readback benchmark (device-spike work
// item 5) and shared with the /lab pipeline-cost readout. Kept free of any
// GPU types so it unit-tests in node with hand-computed numbers.

export interface LatencyStats {
  count: number
  meanMs: number
  medianMs: number
  p95Ms: number
  maxMs: number
}

export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// Nearest-rank quantile over a copy of the values; q in (0, 1].
export function quantileOf(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)))
  return sorted[rank - 1]
}

export function computeLatencyStats(samples: readonly number[]): LatencyStats | undefined {
  if (samples.length === 0) return undefined
  let sum = 0
  let max = -Infinity
  for (const sample of samples) {
    sum += sample
    max = Math.max(max, sample)
  }
  return {
    count: samples.length,
    meanMs: sum / samples.length,
    medianMs: medianOf(samples),
    p95Ms: quantileOf(samples, 0.95),
    maxMs: max,
  }
}

export interface DriftReport {
  windowSize: number
  earlyMedianMs: number
  lateMedianMs: number
  driftMs: number
  // driftMs as a fraction of the early median (0 when the early median is 0).
  driftFraction: number
  // The go/no-go judgment: true when the late median exceeds the early median
  // by more than thresholdFraction.
  upwardDrift: boolean
  thresholdFraction: number
}

export const DEFAULT_DRIFT_WINDOW_SIZE = 600
export const DEFAULT_DRIFT_THRESHOLD_FRACTION = 0.2

// Compares the median of the first windowSize samples against the median of
// the last windowSize samples. Undefined until the two windows are disjoint
// (≥ 2 × windowSize samples), so a short run never reports a drift verdict
// from overlapping data.
export function computeDrift(
  samples: readonly number[],
  windowSize: number = DEFAULT_DRIFT_WINDOW_SIZE,
  thresholdFraction: number = DEFAULT_DRIFT_THRESHOLD_FRACTION,
): DriftReport | undefined {
  if (windowSize < 1 || samples.length < windowSize * 2) return undefined
  const earlyMedianMs = medianOf(samples.slice(0, windowSize))
  const lateMedianMs = medianOf(samples.slice(-windowSize))
  const driftMs = lateMedianMs - earlyMedianMs
  const driftFraction = earlyMedianMs === 0 ? 0 : driftMs / earlyMedianMs
  return {
    windowSize,
    earlyMedianMs,
    lateMedianMs,
    driftMs,
    driftFraction,
    upwardDrift: driftMs > earlyMedianMs * thresholdFraction,
    thresholdFraction,
  }
}
