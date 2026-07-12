import { describe, expect, it } from 'vitest'
import {
  FrameLoop,
  defaultClock,
  type ClockLike,
  type FrameSample,
  type VideoFrameCallbackLike,
  type VideoFrameMetadataLike,
  type VideoLike,
} from './frame-loop'

class FakeVideo implements VideoLike {
  private nextHandle = 1
  private pending = new Map<number, VideoFrameCallbackLike>()
  cancelledCallbacks: VideoFrameCallbackLike[] = []
  registrationCount = 0
  cancelCount = 0

  requestVideoFrameCallback(callback: VideoFrameCallbackLike): number {
    this.registrationCount++
    const handle = this.nextHandle++
    this.pending.set(handle, callback)
    return handle
  }

  cancelVideoFrameCallback(handle: number): void {
    const callback = this.pending.get(handle)
    if (callback === undefined) return
    this.cancelCount++
    this.cancelledCallbacks.push(callback)
    this.pending.delete(handle)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  fire(metadata: VideoFrameMetadataLike = {}, now = 0): void {
    const callbacks = [...this.pending.values()]
    this.pending.clear()
    for (const callback of callbacks) callback(now, metadata)
  }

  fireCancelled(metadata: VideoFrameMetadataLike = {}, now = 0): void {
    const callbacks = this.cancelledCallbacks
    this.cancelledCallbacks = []
    for (const callback of callbacks) callback(now, metadata)
  }
}

class FakeClock implements ClockLike {
  current = 0
  now(): number {
    return this.current
  }
}

function setup() {
  const video = new FakeVideo()
  const clock = new FakeClock()
  const samples: FrameSample[] = []
  const loop = new FrameLoop(video, (sample) => samples.push(sample), clock)
  return { video, clock, samples, loop }
}

describe('FrameLoop', () => {
  it('does not register before start, registers exactly one callback on start', () => {
    const { video, loop } = setup()
    expect(video.registrationCount).toBe(0)
    expect(loop.running).toBe(false)
    loop.start()
    expect(video.registrationCount).toBe(1)
    expect(video.pendingCount).toBe(1)
    expect(loop.running).toBe(true)
  })

  it('emits one FrameSample per frame with increasing frameIndex and clock time', () => {
    const { video, clock, samples, loop } = setup()
    loop.start()
    clock.current = 100
    video.fire()
    clock.current = 116
    video.fire()
    clock.current = 133
    video.fire()
    expect(samples.map((sample) => sample.frameIndex)).toEqual([0, 1, 2])
    expect(samples.map((sample) => sample.now)).toEqual([100, 116, 133])
  })

  it('passes the rVFC metadata through untouched', () => {
    const { video, samples, loop } = setup()
    loop.start()
    const metadata: VideoFrameMetadataLike = {
      mediaTime: 1.5,
      expectedDisplayTime: 120,
      presentationTime: 118,
      presentedFrames: 42,
      captureTime: 95,
      processingDuration: 0.002,
      rtpTimestamp: 7,
    }
    video.fire(metadata)
    expect(samples[0].metadata).toBe(metadata)
  })

  it('re-registers after every frame, keeping exactly one callback pending', () => {
    const { video, loop } = setup()
    loop.start()
    video.fire()
    video.fire()
    expect(video.registrationCount).toBe(3)
    expect(video.pendingCount).toBe(1)
  })

  it('start is idempotent while running', () => {
    const { video, loop } = setup()
    loop.start()
    loop.start()
    expect(video.registrationCount).toBe(1)
  })

  it('stop cancels the pending callback and no further samples are emitted', () => {
    const { video, samples, loop } = setup()
    loop.start()
    video.fire()
    loop.stop()
    expect(loop.running).toBe(false)
    expect(video.pendingCount).toBe(0)
    expect(video.cancelCount).toBe(1)
    video.fire()
    expect(samples).toHaveLength(1)
  })

  it('stop is idempotent and safe before start', () => {
    const { video, loop } = setup()
    expect(() => loop.stop()).not.toThrow()
    loop.start()
    loop.stop()
    loop.stop()
    expect(video.cancelCount).toBe(1)
  })

  it('restart after stop works and resets frameIndex', () => {
    const { video, samples, loop } = setup()
    loop.start()
    video.fire()
    video.fire()
    loop.stop()
    loop.start()
    video.fire()
    expect(samples.map((sample) => sample.frameIndex)).toEqual([0, 1, 0])
  })

  it('ignores a cancelled callback the browser delivers after stop', () => {
    const { video, samples, loop } = setup()
    loop.start()
    loop.stop()
    video.fireCancelled()
    expect(samples).toHaveLength(0)
    expect(video.pendingCount).toBe(0)
  })

  it('ignores a stale cancelled callback delivered after a restart, without double-registering', () => {
    const { video, samples, loop } = setup()
    loop.start()
    loop.stop()
    loop.start()
    video.fireCancelled()
    expect(samples).toHaveLength(0)
    expect(video.pendingCount).toBe(1)
    video.fire()
    expect(samples.map((sample) => sample.frameIndex)).toEqual([0])
  })

  it('keeps looping when the subscriber throws', () => {
    const video = new FakeVideo()
    const samples: FrameSample[] = []
    let shouldThrow = true
    const loop = new FrameLoop(
      video,
      (sample) => {
        if (shouldThrow) throw new Error('subscriber boom')
        samples.push(sample)
      },
      new FakeClock(),
    )
    loop.start()
    expect(() => video.fire()).toThrow('subscriber boom')
    expect(video.pendingCount).toBe(1)
    shouldThrow = false
    video.fire()
    expect(samples.map((sample) => sample.frameIndex)).toEqual([1])
  })

  it('a subscriber calling stop() cancels the already-re-registered next frame', () => {
    const video = new FakeVideo()
    const loop: FrameLoop = new FrameLoop(video, () => loop.stop(), new FakeClock())
    loop.start()
    video.fire()
    expect(loop.running).toBe(false)
    expect(video.pendingCount).toBe(0)
  })
})

describe('defaultClock', () => {
  it('reads performance.now()', () => {
    const clock = defaultClock()
    const before = performance.now()
    const value = clock.now()
    expect(value).toBeGreaterThanOrEqual(before)
    expect(value).toBeLessThanOrEqual(performance.now())
  })
})
