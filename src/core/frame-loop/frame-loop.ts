// The fields of VideoFrameCallbackMetadata this project cares about. All are
// declared optional: several are optional per spec (captureTime,
// processingDuration, rtpTimestamp — captureTime presence on live streams is
// exactly what the device spike probes), and the required-per-spec ones are
// kept optional too so the stats layer treats "browser didn't provide it" as
// data rather than a type error. A real VideoFrameCallbackMetadata is
// assignable to this shape.
export interface VideoFrameMetadataLike {
  presentationTime?: number
  expectedDisplayTime?: number
  mediaTime?: number
  presentedFrames?: number
  captureTime?: number
  processingDuration?: number
  rtpTimestamp?: number
}

export type VideoFrameCallbackLike = (now: number, metadata: VideoFrameMetadataLike) => void

export interface VideoLike {
  requestVideoFrameCallback(callback: VideoFrameCallbackLike): number
  cancelVideoFrameCallback(handle: number): void
}

export interface ClockLike {
  now(): number
}

export function defaultClock(): ClockLike {
  return { now: () => performance.now() }
}

export interface FrameSample {
  frameIndex: number
  // Injectable-clock time at callback dispatch. The rVFC callback's own `now`
  // argument is deliberately not used: this field is the candidate fallback
  // timestamp source (performance.now() at callback, per the device-spike
  // plan), so it must come from the same clock production code would use.
  now: number
  metadata: VideoFrameMetadataLike
}

export type FrameSubscriber = (sample: FrameSample) => void

// Emits one FrameSample per presented video frame by re-registering a
// requestVideoFrameCallback after each callback (rVFC is one-shot).
export class FrameLoop {
  private handle: number | undefined
  private generation = 0
  private frameIndex = 0

  constructor(
    private readonly video: VideoLike,
    private readonly subscriber: FrameSubscriber,
    private readonly clock: ClockLike = defaultClock(),
  ) {}

  get running(): boolean {
    return this.handle !== undefined
  }

  start(): void {
    if (this.running) return
    this.frameIndex = 0
    this.register()
  }

  stop(): void {
    if (this.handle === undefined) return
    // Bumping the generation makes any already-dispatched callback a no-op,
    // even if the browser delivers it despite the cancel.
    this.generation++
    this.video.cancelVideoFrameCallback(this.handle)
    this.handle = undefined
  }

  private register(): void {
    const generation = this.generation
    this.handle = this.video.requestVideoFrameCallback((_now, metadata) => {
      if (generation !== this.generation) return
      // Re-register before notifying so a throwing subscriber cannot kill the
      // loop, and so a subscriber calling stop() cancels the *next* frame.
      this.register()
      this.subscriber({ frameIndex: this.frameIndex++, now: this.clock.now(), metadata })
    })
  }
}
