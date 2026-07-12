import { describe, expect, it } from 'vitest'
import { FPS_WINDOW_MS, PipelineCostTracker } from './pipeline-cost'

describe('PipelineCostTracker', () => {
  it('measures frame-start → sample-done deltas', () => {
    const tracker = new PipelineCostTracker()
    tracker.markFrameStart(100)
    tracker.markSampleDone(103)
    tracker.markFrameStart(200)
    tracker.markSampleDone(201)
    const stats = tracker.costStats()
    expect(stats?.count).toBe(2)
    expect(stats?.medianMs).toBe(2)
    expect(stats?.maxMs).toBe(3)
    expect(tracker.frames).toBe(2)
  })

  it('a sample without a preceding frame start counts the frame but records no cost', () => {
    const tracker = new PipelineCostTracker()
    tracker.markSampleDone(100)
    expect(tracker.frames).toBe(1)
    expect(tracker.costStats()).toBeUndefined()
  })

  it('one frame start pairs with at most one sample', () => {
    const tracker = new PipelineCostTracker()
    tracker.markFrameStart(100)
    tracker.markSampleDone(105)
    tracker.markSampleDone(300)
    expect(tracker.costStats()?.count).toBe(1)
  })

  it('keeps a rolling cost window', () => {
    const tracker = new PipelineCostTracker(3)
    for (const [start, done] of [
      [0, 10],
      [100, 101],
      [200, 202],
      [300, 303],
    ]) {
      tracker.markFrameStart(start)
      tracker.markSampleDone(done)
    }
    const stats = tracker.costStats()
    expect(stats?.count).toBe(3)
    expect(stats?.maxMs).toBe(3)
  })

  it('rollingFps needs at least two samples inside the window', () => {
    const tracker = new PipelineCostTracker()
    expect(tracker.rollingFps(0)).toBeNull()
    tracker.markSampleDone(0)
    expect(tracker.rollingFps(0)).toBeNull()
  })

  it('rollingFps measures rate over the recent window and evicts old arrivals', () => {
    const tracker = new PipelineCostTracker()
    for (let i = 0; i <= 60; i++) tracker.markSampleDone(i * 100)
    // Last arrival at 6000; the window covers [4000, 6000] — one arrival
    // every 100 ms → 10 per second.
    expect(tracker.rollingFps(6000)).toBeCloseTo(10)
    // Long idle: everything falls out of the window.
    expect(tracker.rollingFps(6000 + FPS_WINDOW_MS + 1)).toBeNull()
  })

  it('reset clears everything', () => {
    const tracker = new PipelineCostTracker()
    tracker.markFrameStart(0)
    tracker.markSampleDone(1)
    tracker.reset()
    expect(tracker.frames).toBe(0)
    expect(tracker.costStats()).toBeUndefined()
    expect(tracker.rollingFps(2)).toBeNull()
  })
})
