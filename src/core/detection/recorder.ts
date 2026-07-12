// Fixture recorder core (plan 03 item 7): the framework-free logic the /lab
// UI drives. Two capture modes — snapshot the pipeline's ring buffer (the
// video-capture seam, ~2 s of recent frames) or record continuously for long
// events. Download/share delivery is UI-side; this module only produces
// .cwclip bytes.

import type { LumaFrame } from './types'
import type { RingBuffer } from './ring-buffer'
import { encodeClip } from './clip-format'

// A .cwclip requires uniform frame dimensions, but an ROI drag changes the
// source's crop size mid-stream, so the ring can hold mixed-dims frames for
// its whole span (~2 s). Encode only the longest run of newest frames that
// share the last frame's dimensions — the current-ROI footage, which is what
// a snapshot after a drag means. Throws ClipFormatError on an empty ring —
// there is nothing honest to snapshot.
export function snapshotRingClip(
  ring: RingBuffer,
  conditions?: Record<string, string>,
): Uint8Array {
  return encodeClip(uniformDimsSuffix(ring.frames()), conditions)
}

function uniformDimsSuffix(frames: readonly LumaFrame[]): readonly LumaFrame[] {
  const last = frames.at(-1)
  if (last === undefined) return frames
  let start = frames.length - 1
  while (start > 0 && sameDims(frames[start - 1], last)) start--
  return frames.slice(start)
}

function sameDims(a: LumaFrame, b: LumaFrame): boolean {
  return a.width === b.width && a.height === b.height
}

// 30 s at 60 fps. The subsampler bounds frames to TARGET_PIXELS (≤ 36 864 B
// each, see camera-source.ts), so a full recording retains ≤ ~66 MB — 60 s
// (3600 frames, ~133 MB) was more than a phone should pin for one clip.
export const DEFAULT_CONTINUOUS_RECORDER_MAX_FRAMES = 1800

// At the frame cap the recorder STOPS capturing (keeps the oldest frames,
// drops everything after) and marks the clip's conditions with
// `truncated: 'true'` plus the dropped-frame count — the simplest honest
// behavior: the recorded prefix is contiguous and its timestamps are exactly
// what the live run saw, rather than a silently windowed tail.
//
// Frames whose dimensions differ from the first recorded frame (an ROI drag
// mid-recording) are dropped and counted (`droppedMismatchedFrames`,
// surfaced in the clip's conditions) instead of poisoning stop(): a clip's
// dims are uniform by construction, so with ≥ 1 frame encodeClip cannot fail
// and stop() cannot leave the recorder wedged. (Short data planes or
// non-finite timestamps would still throw, but those violate the LumaFrame
// contract at the source, not recorder state.) The zero-frames stop() still
// throws and stays recording — that is the documented empty-stop behavior.
export class ContinuousRecorder {
  readonly maxFrames: number
  #frames: LumaFrame[] = []
  #droppedFrameCount = 0
  #droppedMismatchedFrames = 0
  #recording = false

  constructor(maxFrames = DEFAULT_CONTINUOUS_RECORDER_MAX_FRAMES) {
    if (!Number.isInteger(maxFrames) || maxFrames < 1) {
      throw new Error(`maxFrames must be a positive integer, got ${maxFrames}`)
    }
    this.maxFrames = maxFrames
  }

  get recording(): boolean {
    return this.#recording
  }

  get frameCount(): number {
    return this.#frames.length
  }

  get truncated(): boolean {
    return this.#droppedFrameCount > 0
  }

  get droppedMismatchedFrames(): number {
    return this.#droppedMismatchedFrames
  }

  start(): void {
    if (this.#recording) throw new Error('ContinuousRecorder is already recording')
    this.#recording = true
    this.#frames = []
    this.#droppedFrameCount = 0
    this.#droppedMismatchedFrames = 0
  }

  // Retains the frame by reference (LumaFrame ownership transfers on emit;
  // sharing references with the ring buffer is fine — nobody mutates).
  add(frame: LumaFrame): void {
    if (!this.#recording) throw new Error('ContinuousRecorder.add() while not recording')
    const first = this.#frames[0]
    if (first !== undefined && !sameDims(frame, first)) {
      this.#droppedMismatchedFrames++
      return
    }
    if (this.#frames.length >= this.maxFrames) {
      this.#droppedFrameCount++
      return
    }
    this.#frames.push(frame)
  }

  // Encodes and returns the clip, then clears recording state. Throws
  // ClipFormatError when no frames were captured — the recorder stays
  // recording so the caller can capture more and stop again.
  stop(conditions?: Record<string, string>): Uint8Array {
    if (!this.#recording) throw new Error('ContinuousRecorder.stop() while not recording')
    const finalConditions = {
      ...conditions,
      ...(this.truncated
        ? { truncated: 'true', truncatedDroppedFrames: String(this.#droppedFrameCount) }
        : {}),
      ...(this.#droppedMismatchedFrames > 0
        ? { droppedMismatchedFrames: String(this.#droppedMismatchedFrames) }
        : {}),
    }
    const clip = encodeClip(
      this.#frames,
      Object.keys(finalConditions).length > 0 ? finalConditions : undefined,
    )
    this.#recording = false
    this.#frames = []
    return clip
  }
}
