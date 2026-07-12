import type { FrameSource, LumaSource } from './frame-source'
import type { DetectionTunables, FrameSample, LumaFrame } from './types'
import { DEFAULT_DETECTION_TUNABLES } from './types'
import { StripReducer } from './reducer'
import { RingBuffer, DEFAULT_RING_BUFFER_CAPACITY } from './ring-buffer'

// Composes any LumaSource with the shared reducer and the frame ring buffer;
// the single reduction path every source flows through (plan 03 items 1, 4,
// 6). Implements FrameSource — the app-facing seam is this FrameSample
// stream.
//
// Tunables routing: stripCount / threshold / emaTimeConstantMs feed the
// reducer and take effect on the next frame (a stripCount change only
// re-buckets — the EMA persists). The ROI is the SOURCE's concern: sources
// crop before emitting, so an ROI change means reconfiguring the source; the
// pipeline only carries the value as part of the session's tunables snapshot.
// triggerLevel is the state machine's concern (Phase 4) and is carried the
// same way.
export class DetectionPipeline implements FrameSource {
  #source: LumaSource
  #tunables: DetectionTunables
  #reducer: StripReducer
  #ringBuffer: RingBuffer
  #paused = false
  #running = false

  constructor(
    source: LumaSource,
    tunables: Partial<DetectionTunables> = {},
    ringBufferCapacity = DEFAULT_RING_BUFFER_CAPACITY,
  ) {
    this.#source = source
    this.#tunables = { ...DEFAULT_DETECTION_TUNABLES, ...tunables }
    this.#reducer = new StripReducer({
      stripCount: this.#tunables.stripCount,
      threshold: this.#tunables.threshold,
      emaTimeConstantMs: this.#tunables.emaTimeConstantMs,
    })
    this.#ringBuffer = new RingBuffer(ringBufferCapacity)
  }

  get tunables(): DetectionTunables {
    return { ...this.#tunables, roi: { ...this.#tunables.roi } }
  }

  get ringBuffer(): RingBuffer {
    return this.#ringBuffer
  }

  start(onSample: (sample: FrameSample) => void): void {
    if (this.#running) {
      throw new Error('DetectionPipeline is already started')
    }
    this.#running = true
    this.#source.start((frame) => this.#processFrame(frame, onSample))
  }

  stop(): void {
    if (!this.#running) return
    this.#running = false
    this.#source.stop()
  }

  // crossingInProgress: while paused the reducer still computes diffs and
  // counts but freezes the EMA background (Phase 4 wires the timeout).
  setPause(paused: boolean): void {
    this.#paused = paused
  }

  updateTunables(partial: Partial<DetectionTunables>): void {
    this.#tunables = {
      ...this.#tunables,
      ...partial,
      roi: { ...(partial.roi ?? this.#tunables.roi) },
    }
    this.#reducer.configure({
      stripCount: partial.stripCount,
      threshold: partial.threshold,
      emaTimeConstantMs: partial.emaTimeConstantMs,
    })
  }

  // The ROI is the source's crop, so an ROI move with an unchanged crop size
  // changes what the pixels show without changing dimensions — the reducer
  // would keep a stale EMA and report phantom energies until it re-adapts.
  // Callers reconfiguring the ROI (the /lab setup UI) reset here; the next
  // frame re-seeds the background.
  resetBackground(): void {
    this.#reducer.reset()
  }

  #processFrame(frame: LumaFrame, onSample: (sample: FrameSample) => void): void {
    // stop() is a hard barrier: a source frame already in flight when the
    // pipeline stopped must not touch the ring buffer or reach the listener.
    if (!this.#running) return
    this.#ringBuffer.push(frame)
    const energies = this.#reducer.process(frame, this.#paused)
    // The reducer reuses its arrays; each FrameSample owns fresh copies.
    onSample({
      captureTimeMs: frame.captureTimeMs,
      energies: energies.slice(),
      stripPixelCounts: this.#reducer.stripPixelCounts.slice(),
    })
  }
}
