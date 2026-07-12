import type { LumaFrame } from './types'

// ~2 s at 60 fps (longer at lower delivered rates — the cap is a frame count,
// not a duration).
export const DEFAULT_RING_BUFFER_CAPACITY = 120

// Holds the last `capacity` LumaFrames, overwriting the oldest — the
// video-capture seam (detection.md): per-crossing clip export and the fixture
// recorder consume this buffer without restructuring the pipeline. Stores
// frame references, no copies: LumaFrame ownership transfers on emit.
export class RingBuffer {
  readonly capacity: number
  #frames: LumaFrame[] = []
  #start = 0

  constructor(capacity = DEFAULT_RING_BUFFER_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`capacity must be a positive integer, got ${capacity}`)
    }
    this.capacity = capacity
  }

  get size(): number {
    return this.#frames.length
  }

  push(frame: LumaFrame): void {
    if (this.#frames.length < this.capacity) {
      this.#frames.push(frame)
    } else {
      this.#frames[this.#start] = frame
      this.#start = (this.#start + 1) % this.capacity
    }
  }

  // Retained frames in arrival order (oldest first), as a fresh array.
  frames(): readonly LumaFrame[] {
    return [...this.#frames.slice(this.#start), ...this.#frames.slice(0, this.#start)]
  }

  clear(): void {
    this.#frames = []
    this.#start = 0
  }
}
