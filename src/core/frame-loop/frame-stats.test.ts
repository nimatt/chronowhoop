import { describe, expect, it } from 'vitest'
import type { FrameSample, VideoFrameMetadataLike } from './frame-loop'
import {
  DEFAULT_STATS_WINDOW_SIZE,
  FrameStatsWindow,
  TIMESTAMP_SOURCES,
  computeFrameStats,
} from './frame-stats'

function sample(
  frameIndex: number,
  now: number,
  metadata: VideoFrameMetadataLike = {},
): FrameSample {
  return { frameIndex, now, metadata }
}

function samplesFromNows(nows: number[]): FrameSample[] {
  return nows.map((now, frameIndex) => sample(frameIndex, now))
}

describe('computeFrameStats', () => {
  it('reports an empty window as unknown, not zero-ish numbers', () => {
    const stats = computeFrameStats([])
    expect(stats.frameCount).toBe(0)
    expect(stats.windowDurationMs).toBeUndefined()
    expect(stats.measuredFps).toBeUndefined()
    expect(stats.droppedFrameEstimate).toBeUndefined()
    for (const source of TIMESTAMP_SOURCES) {
      expect(stats.sources[source]).toEqual({
        availableFrames: 0,
        availability: 0,
        deltaCount: 0,
        medianDeltaMs: undefined,
        jitterStddevMs: undefined,
        jitterMaxDeviationMs: undefined,
      })
    }
  })

  it('reports a single sample without fps or deltas', () => {
    const stats = computeFrameStats([sample(0, 100, { captureTime: 90 })])
    expect(stats.frameCount).toBe(1)
    expect(stats.measuredFps).toBeUndefined()
    expect(stats.sources.captureTime.availableFrames).toBe(1)
    expect(stats.sources.captureTime.availability).toBe(1)
    expect(stats.sources.captureTime.deltaCount).toBe(0)
  })

  it('measures fps over the window duration', () => {
    const stats = computeFrameStats(samplesFromNows([0, 10, 20, 30]))
    expect(stats.windowDurationMs).toBe(30)
    expect(stats.measuredFps).toBeCloseTo(100, 10)
  })

  it('leaves fps undefined when the window duration is zero', () => {
    const stats = computeFrameStats(samplesFromNows([50, 50]))
    expect(stats.windowDurationMs).toBe(0)
    expect(stats.measuredFps).toBeUndefined()
  })

  it('computes callback-time deltas, median, stddev, and max deviation by hand-checked values', () => {
    const stats = computeFrameStats(samplesFromNows([0, 10, 12, 20, 30]))
    const now = stats.sources.now
    // deltas [10, 2, 8, 10]: sorted [2, 8, 10, 10] -> median 9, population
    // stddev sqrt(43/4) around mean 7.5, max |delta - 9| = 7
    expect(now.deltaCount).toBe(4)
    expect(now.medianDeltaMs).toBeCloseTo(9, 10)
    expect(now.jitterStddevMs).toBeCloseTo(Math.sqrt(10.75), 10)
    expect(now.jitterMaxDeviationMs).toBeCloseTo(7, 10)
    expect(now.availability).toBe(1)
  })

  it('reports zero jitter for perfectly regular frames', () => {
    const stats = computeFrameStats(samplesFromNows([0, 16, 32, 48, 64]))
    expect(stats.sources.now.jitterStddevMs).toBe(0)
    expect(stats.sources.now.jitterMaxDeviationMs).toBe(0)
    expect(stats.sources.now.medianDeltaMs).toBe(16)
  })

  it('takes the odd-count median as the middle delta', () => {
    const stats = computeFrameStats(samplesFromNows([0, 10, 12, 20]))
    // deltas [10, 2, 8] -> sorted [2, 8, 10] -> median 8
    expect(stats.sources.now.medianDeltaMs).toBe(8)
  })

  it('converts mediaTime from seconds to milliseconds', () => {
    const stats = computeFrameStats([
      sample(0, 0, { mediaTime: 0 }),
      sample(1, 10, { mediaTime: 0.01 }),
      sample(2, 22, { mediaTime: 0.022 }),
    ])
    const mediaTime = stats.sources.mediaTime
    // deltas in ms: [10, 12]
    expect(mediaTime.deltaCount).toBe(2)
    expect(mediaTime.medianDeltaMs).toBeCloseTo(11, 10)
    expect(mediaTime.jitterStddevMs).toBeCloseTo(1, 10)
    expect(mediaTime.jitterMaxDeviationMs).toBeCloseTo(1, 10)
  })

  it('tracks per-source availability when captureTime is missing on some frames', () => {
    const stats = computeFrameStats([
      sample(0, 0, { captureTime: 5 }),
      sample(1, 16, { captureTime: 21 }),
      sample(2, 32),
      sample(3, 48),
    ])
    const captureTime = stats.sources.captureTime
    expect(captureTime.availableFrames).toBe(2)
    expect(captureTime.availability).toBe(0.5)
    expect(captureTime.deltaCount).toBe(1)
    expect(captureTime.medianDeltaMs).toBe(16)
    expect(stats.sources.now.availability).toBe(1)
  })

  it('does not fabricate a delta across a frame missing the timestamp', () => {
    const stats = computeFrameStats([
      sample(0, 0, { captureTime: 5 }),
      sample(1, 16),
      sample(2, 32, { captureTime: 37 }),
    ])
    expect(stats.sources.captureTime.availableFrames).toBe(2)
    expect(stats.sources.captureTime.deltaCount).toBe(0)
    expect(stats.sources.captureTime.medianDeltaMs).toBeUndefined()
  })

  it('does not pair samples across a frameIndex discontinuity (loop restart)', () => {
    const stats = computeFrameStats([sample(0, 0), sample(1, 16), sample(0, 500)])
    expect(stats.sources.now.deltaCount).toBe(1)
    expect(stats.sources.now.medianDeltaMs).toBe(16)
  })

  it('estimates dropped frames from presentedFrames gaps', () => {
    const stats = computeFrameStats([
      sample(0, 0, { presentedFrames: 100 }),
      sample(1, 16, { presentedFrames: 101 }),
      sample(2, 48, { presentedFrames: 103 }),
      sample(3, 96, { presentedFrames: 106 }),
    ])
    expect(stats.droppedFrameEstimate).toBe(3)
  })

  it('reports zero dropped frames when presentedFrames is consecutive', () => {
    const stats = computeFrameStats([
      sample(0, 0, { presentedFrames: 7 }),
      sample(1, 16, { presentedFrames: 8 }),
    ])
    expect(stats.droppedFrameEstimate).toBe(0)
  })

  it('skips pairs missing presentedFrames and reports undefined when none are comparable', () => {
    const partial = computeFrameStats([
      sample(0, 0, { presentedFrames: 10 }),
      sample(1, 16),
      sample(2, 32, { presentedFrames: 13 }),
      sample(3, 48, { presentedFrames: 15 }),
    ])
    expect(partial.droppedFrameEstimate).toBe(1)

    const none = computeFrameStats(samplesFromNows([0, 16, 32]))
    expect(none.droppedFrameEstimate).toBeUndefined()
  })

  it('does not count a presentedFrames counter reset as negative drops', () => {
    const stats = computeFrameStats([
      sample(0, 0, { presentedFrames: 100 }),
      sample(1, 16, { presentedFrames: 1 }),
    ])
    expect(stats.droppedFrameEstimate).toBe(0)
  })
})

describe('FrameStatsWindow', () => {
  it('defaults to the documented window size', () => {
    expect(DEFAULT_STATS_WINDOW_SIZE).toBe(240)
  })

  it('rejects window sizes that cannot hold a delta', () => {
    expect(() => new FrameStatsWindow(1)).toThrow()
    expect(() => new FrameStatsWindow(2.5)).toThrow()
    expect(() => new FrameStatsWindow(2)).not.toThrow()
  })

  it('keeps only the most recent windowSize samples', () => {
    const window = new FrameStatsWindow(3)
    for (const frame of samplesFromNows([0, 10, 20, 30, 40])) window.add(frame)
    const stats = window.stats()
    expect(stats.frameCount).toBe(3)
    expect(stats.windowDurationMs).toBe(20)
    expect(stats.measuredFps).toBeCloseTo(100, 10)
  })

  it('reset clears the window', () => {
    const window = new FrameStatsWindow(4)
    window.add(sample(0, 0))
    window.add(sample(1, 16))
    window.reset()
    expect(window.stats().frameCount).toBe(0)
  })
})
