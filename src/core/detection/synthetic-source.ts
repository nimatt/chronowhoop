// Programmable LumaFrame generator with mathematically-known ground truth
// (plan 03 items 1, 5): a moving full-height blob over a static or noisy
// background, optional global transient, jitter, and dropped frames. Designed
// for tests: frames are generated synchronously on demand via pump() — no
// timers, no ambient randomness (noise takes an injectable RNG; see
// seededLcg).

import type { LumaSource } from './frame-source'
import type { LumaFrame } from './types'

// Numerical Recipes LCG over uint32, returning floats in [0, 1). Deterministic
// across runs and platforms — the injectable RNG for noise functions.
export function seededLcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

export interface SyntheticBlob {
  widthPx: number
  // Absolute luma level (0–255) the blob paints over the background.
  intensity: number
  speedPxPerFrame: number
  // +1 moves toward increasing x, −1 toward decreasing x.
  direction: 1 | -1
  // Blob is visible on frames [startFrame, endFrame] (inclusive); omitted
  // endFrame means until the clip ends.
  startFrame: number
  endFrame?: number
  // Blob-center x at startFrame. Defaults to just off-screen on the entry
  // edge (left for direction +1, right for −1) so the blob flies through.
  // Set explicitly for stationary-blob scenes (speedPxPerFrame 0).
  startCenterX?: number
}

export interface SyntheticSourceOptions {
  width: number
  height: number
  frameCount: number
  // Nominal frame pacing; captureTimeMs(f) = startTimeMs + f·interval
  // (+ jitter). Defaults to 60 fps.
  frameIntervalMs?: number
  startTimeMs?: number
  frameJitterMs?: (frameIndex: number) => number
  backgroundLevel?: number
  // Additive per-pixel perturbation; compose with seededLcg for randomness.
  noise?: (x: number, y: number, frameIndex: number) => number
  blob?: SyntheticBlob
  // Global level shift added to every pixel from frameIndex onward (a step,
  // like lights toggling — detection.md "large lighting changes").
  transient?: { frameIndex: number; delta: number }
  // Dropped frames advance the timeline (and its timestamps) but are never
  // emitted — models MSTP dropping at the source under backpressure.
  isFrameDropped?: (frameIndex: number) => boolean
}

export interface SyntheticGroundTruth {
  crossingFrameIndex: number
  crossingTimeMs: number
}

function blobCenterAt(blob: SyntheticBlob, frameWidth: number, frameIndex: number): number {
  const startCenterX =
    blob.startCenterX ??
    (blob.direction === 1 ? -(blob.widthPx + 1) / 2 : frameWidth - 1 + (blob.widthPx + 1) / 2)
  return startCenterX + blob.direction * blob.speedPxPerFrame * (frameIndex - blob.startFrame)
}

export class SyntheticSource implements LumaSource {
  readonly options: SyntheticSourceOptions
  #onFrame: ((frame: LumaFrame) => void) | undefined
  #nextFrameIndex = 0

  constructor(options: SyntheticSourceOptions) {
    this.options = options
  }

  // The next timeline frame pump() will generate (dropped frames included).
  get nextFrameIndex(): number {
    return this.#nextFrameIndex
  }

  // The first frame whose blob center has reached the frame's horizontal
  // midpoint (width − 1)/2 — the moment "the wave reached the gate-center
  // strips". Undefined when there is no blob or it never crosses within the
  // clip (stationary, too slow, or ends early).
  get groundTruth(): SyntheticGroundTruth | undefined {
    const blob = this.options.blob
    if (!blob || blob.speedPxPerFrame <= 0) return undefined
    const midX = (this.options.width - 1) / 2
    const center0 = blobCenterAt(blob, this.options.width, blob.startFrame)
    const distance = blob.direction === 1 ? midX - center0 : center0 - midX
    if (distance < 0) return undefined
    const frameIndex = blob.startFrame + Math.ceil(distance / blob.speedPxPerFrame)
    const lastBlobFrame = Math.min(blob.endFrame ?? Infinity, this.options.frameCount - 1)
    if (frameIndex > lastBlobFrame) return undefined
    return { crossingFrameIndex: frameIndex, crossingTimeMs: this.#captureTimeAt(frameIndex) }
  }

  #captureTimeAt(frameIndex: number): number {
    const interval = this.options.frameIntervalMs ?? 1000 / 60
    const jitter = this.options.frameJitterMs?.(frameIndex) ?? 0
    return (this.options.startTimeMs ?? 0) + frameIndex * interval + jitter
  }

  #frameAt(frameIndex: number): LumaFrame {
    const { width, height, backgroundLevel = 32, noise, blob, transient } = this.options
    const data = new Uint8Array(width * height)

    let base = backgroundLevel
    if (transient && frameIndex >= transient.frameIndex) base += transient.delta

    // Blob columns: the fractional center is rounded to whole pixels so the
    // painted blob keeps a constant integer width — ground-truth math stays
    // exact for integer speeds and hand-computable otherwise.
    let blobLeft = 0
    let blobRight = -1
    let blobIntensity = 0
    const blobActive =
      blob !== undefined && frameIndex >= blob.startFrame && frameIndex <= (blob.endFrame ?? Infinity)
    if (blob && blobActive) {
      blobLeft = Math.round(blobCenterAt(blob, width, frameIndex) - (blob.widthPx - 1) / 2)
      blobRight = blobLeft + blob.widthPx - 1
      blobIntensity = blob.intensity
    }

    for (let y = 0; y < height; y++) {
      const row = y * width
      for (let x = 0; x < width; x++) {
        let value = x >= blobLeft && x <= blobRight ? blobIntensity : base
        if (noise) value += noise(x, y, frameIndex)
        data[row + x] = Math.min(255, Math.max(0, Math.round(value)))
      }
    }
    return { data, width, height, captureTimeMs: this.#captureTimeAt(frameIndex) }
  }

  start(onFrame: (frame: LumaFrame) => void): void {
    this.#onFrame = onFrame
  }

  stop(): void {
    this.#onFrame = undefined
  }

  // Advances up to `frames` timeline frames, synchronously emitting each one
  // that isn't dropped; returns the number actually delivered. Stops at
  // frameCount.
  pump(frames = 1): number {
    const onFrame = this.#onFrame
    if (!onFrame) throw new Error('SyntheticSource.pump() before start()')
    let delivered = 0
    const end = Math.min(this.#nextFrameIndex + frames, this.options.frameCount)
    while (this.#nextFrameIndex < end) {
      const frameIndex = this.#nextFrameIndex++
      if (this.options.isFrameDropped?.(frameIndex)) continue
      onFrame(this.#frameAt(frameIndex))
      delivered++
    }
    return delivered
  }

  pumpAll(): number {
    return this.pump(this.options.frameCount - this.#nextFrameIndex)
  }
}
