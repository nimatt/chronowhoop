import type { FrameSample } from './frame-loop'

// The candidate timestamp sources the device spike compares against the
// declared jitter threshold ("trusted only if jitter ≤ ~½ frame interval").
// 'now' is the injectable-clock time at callback — the plan's fallback source.
export const TIMESTAMP_SOURCES = ['now', 'captureTime', 'mediaTime', 'expectedDisplayTime'] as const

export type TimestampSource = (typeof TIMESTAMP_SOURCES)[number]

export interface TimestampSourceStats {
  // How many frames in the window carried this timestamp, and as a 0..1
  // fraction of the window (0 when the window is empty).
  availableFrames: number
  availability: number
  // Deltas are taken between consecutive samples whose frameIndexes are
  // contiguous and which both carry the timestamp, so a restart or a
  // missing-metadata frame never fabricates a multi-frame delta.
  deltaCount: number
  // Median successive delta — the frame-interval estimate this source's
  // jitter is compared against (threshold: jitter ≤ ~½ of this).
  medianDeltaMs: number | undefined
  // Jitter, two views over the same deltas: population stddev, and the worst
  // single outlier as max |delta − median delta|. Both in ms.
  jitterStddevMs: number | undefined
  jitterMaxDeviationMs: number | undefined
}

export interface FrameLoopStats {
  frameCount: number
  windowDurationMs: number | undefined
  measuredFps: number | undefined
  // Sum of presentedFrames gaps (gap − 1) over contiguous sample pairs.
  // undefined when no pair carried presentedFrames — "can't tell" is not 0.
  droppedFrameEstimate: number | undefined
  sources: Record<TimestampSource, TimestampSourceStats>
}

// mediaTime is in seconds (media-timeline); captureTime, expectedDisplayTime,
// and callback-time now are DOMHighResTimeStamp milliseconds. Everything is
// normalized to ms so per-source jitter is directly comparable to a frame
// interval.
function timestampMs(sample: FrameSample, source: TimestampSource): number | undefined {
  switch (source) {
    case 'now':
      return sample.now
    case 'captureTime':
      return sample.metadata.captureTime
    case 'mediaTime':
      return sample.metadata.mediaTime === undefined ? undefined : sample.metadata.mediaTime * 1000
    case 'expectedDisplayTime':
      return sample.metadata.expectedDisplayTime
  }
}

function mean(values: readonly number[]): number {
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function populationStddev(values: readonly number[], valuesMean: number): number {
  let sumOfSquares = 0
  for (const value of values) sumOfSquares += (value - valuesMean) ** 2
  return Math.sqrt(sumOfSquares / values.length)
}

function areContiguous(previous: FrameSample, sample: FrameSample): boolean {
  return previous.frameIndex + 1 === sample.frameIndex
}

function computeSourceStats(
  samples: readonly FrameSample[],
  source: TimestampSource,
): TimestampSourceStats {
  let availableFrames = 0
  const deltas: number[] = []
  let previous: FrameSample | undefined
  for (const sample of samples) {
    const value = timestampMs(sample, source)
    if (value !== undefined) {
      availableFrames++
      if (previous !== undefined && areContiguous(previous, sample)) {
        const previousValue = timestampMs(previous, source)
        if (previousValue !== undefined) deltas.push(value - previousValue)
      }
    }
    previous = sample
  }

  if (deltas.length === 0) {
    return {
      availableFrames,
      availability: samples.length === 0 ? 0 : availableFrames / samples.length,
      deltaCount: 0,
      medianDeltaMs: undefined,
      jitterStddevMs: undefined,
      jitterMaxDeviationMs: undefined,
    }
  }

  const meanDeltaMs = mean(deltas)
  const medianDeltaMs = median(deltas)
  let jitterMaxDeviationMs = 0
  for (const delta of deltas) {
    jitterMaxDeviationMs = Math.max(jitterMaxDeviationMs, Math.abs(delta - medianDeltaMs))
  }
  return {
    availableFrames,
    availability: availableFrames / samples.length,
    deltaCount: deltas.length,
    medianDeltaMs,
    jitterStddevMs: populationStddev(deltas, meanDeltaMs),
    jitterMaxDeviationMs,
  }
}

function computeDroppedFrameEstimate(samples: readonly FrameSample[]): number | undefined {
  let comparablePairs = 0
  let dropped = 0
  let previous: FrameSample | undefined
  for (const sample of samples) {
    const presented = sample.metadata.presentedFrames
    if (
      previous !== undefined &&
      presented !== undefined &&
      previous.metadata.presentedFrames !== undefined &&
      areContiguous(previous, sample)
    ) {
      comparablePairs++
      dropped += Math.max(0, presented - previous.metadata.presentedFrames - 1)
    }
    previous = sample
  }
  return comparablePairs === 0 ? undefined : dropped
}

export function computeFrameStats(samples: readonly FrameSample[]): FrameLoopStats {
  const first = samples[0]
  const last = samples[samples.length - 1]
  const windowDurationMs =
    samples.length >= 2 && first !== undefined && last !== undefined
      ? last.now - first.now
      : undefined
  const measuredFps =
    windowDurationMs !== undefined && windowDurationMs > 0
      ? ((samples.length - 1) / windowDurationMs) * 1000
      : undefined
  return {
    frameCount: samples.length,
    windowDurationMs,
    measuredFps,
    droppedFrameEstimate: computeDroppedFrameEstimate(samples),
    sources: {
      now: computeSourceStats(samples, 'now'),
      captureTime: computeSourceStats(samples, 'captureTime'),
      mediaTime: computeSourceStats(samples, 'mediaTime'),
      expectedDisplayTime: computeSourceStats(samples, 'expectedDisplayTime'),
    },
  }
}

// ~4 seconds at 60 fps: long enough for stable jitter numbers, short enough
// that /diag reflects current conditions.
export const DEFAULT_STATS_WINDOW_SIZE = 240

// Sliding window of the most recent FrameSamples. add() is called per frame;
// stats() is expected to be called at UI rate (~1 Hz), so the math runs on
// demand rather than incrementally.
export class FrameStatsWindow {
  private samples: FrameSample[] = []

  constructor(private readonly windowSize: number = DEFAULT_STATS_WINDOW_SIZE) {
    if (!Number.isInteger(windowSize) || windowSize < 2) {
      throw new Error(`windowSize must be an integer ≥ 2, got ${windowSize}`)
    }
  }

  add(sample: FrameSample): void {
    this.samples.push(sample)
    if (this.samples.length > this.windowSize) this.samples.shift()
  }

  stats(): FrameLoopStats {
    return computeFrameStats(this.samples)
  }

  reset(): void {
    this.samples.length = 0
  }
}
