// Frame-exact replay of raw luma clips (plan 03 item 1): emits a decoded
// clip's frames with their RECORDED captureTimesMs, so a live EMA trajectory
// — dropped-frame gaps and timestamp jitter included — is reproduced exactly.
// Pure TS, runs in node and CI. Mirrors SyntheticSource's synchronous pump
// pattern: no timers, frames are delivered on demand.

import type { LumaSource } from './frame-source'
import type { LumaFrame } from './types'

export class ClipSource implements LumaSource {
  readonly #frames: readonly LumaFrame[]
  #onFrame: ((frame: LumaFrame) => void) | undefined
  #nextFrameIndex = 0

  constructor(frames: readonly LumaFrame[]) {
    if (frames.length === 0) {
      throw new Error('ClipSource needs at least one frame')
    }
    this.#frames = frames
  }

  get frameCount(): number {
    return this.#frames.length
  }

  // The next clip frame pump() will emit.
  get nextFrameIndex(): number {
    return this.#nextFrameIndex
  }

  start(onFrame: (frame: LumaFrame) => void): void {
    this.#onFrame = onFrame
  }

  stop(): void {
    this.#onFrame = undefined
  }

  // Synchronously emits up to `frames` clip frames; returns the number
  // delivered (short only at the clip's end). Each emitted frame carries a
  // fresh copy of its luma plane — LumaFrame ownership transfers on emit, and
  // the source's decoded frames stay pristine for further replays.
  pump(frames = 1): number {
    const onFrame = this.#onFrame
    if (!onFrame) throw new Error('ClipSource.pump() before start()')
    let delivered = 0
    const end = Math.min(this.#nextFrameIndex + frames, this.#frames.length)
    while (this.#nextFrameIndex < end) {
      const frame = this.#frames[this.#nextFrameIndex++]
      onFrame({ ...frame, data: frame.data.slice() })
      delivered++
    }
    return delivered
  }

  pumpAll(): number {
    return this.pump(this.#frames.length - this.#nextFrameIndex)
  }
}
