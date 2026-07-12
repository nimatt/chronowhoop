// WebCodecs capture probe (second CPU-pipeline candidate, see ADR 0008):
// MediaStreamTrackProcessor delivers VideoFrames straight off the camera
// track — no canvas, no drawImage, no getImageData. On Android the frames are
// planar YUV (NV12/I420), whose Y plane IS the luminance channel, so one
// copyTo + stride subsample replaces the canvas path's three stages. Also
// records per-frame VideoFrame.timestamp deltas: if their jitter beats rVFC's
// sources, this becomes a timestamp-source candidate too.

import { defaultClock, type ClockLike } from '../frame-loop/frame-loop'
import {
  computeDrift,
  computeLatencyStats,
  medianOf,
  type DriftReport,
  type LatencyStats,
} from '../gpu/readback-stats'
import { DEFAULT_STRIP_REDUCE_CONFIG, StripReducer, type StripReduceConfig } from './strip-reduce'

export interface PlaneLayoutLike {
  offset: number
  stride: number
}

export interface VideoFrameCaptureLike {
  format: string | null
  codedWidth: number
  codedHeight: number
  timestamp: number | null
  allocationSize(): number
  copyTo(destination: Uint8Array): Promise<PlaneLayoutLike[]>
  close(): void
}

export interface FrameReaderLike {
  read(): Promise<{ done: boolean; value?: VideoFrameCaptureLike }>
  cancel(): Promise<void> | void
}

export interface TrackProcessorLike {
  readable: { getReader(): FrameReaderLike }
}

export type CreateTrackProcessor = (track: MediaStreamTrack) => TrackProcessorLike

export function isWebCodecsCaptureSupported(): boolean {
  return typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor ===
    'function'
}

function defaultCreateTrackProcessor(track: MediaStreamTrack): TrackProcessorLike {
  const ctor = (
    globalThis as unknown as {
      MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => TrackProcessorLike
    }
  ).MediaStreamTrackProcessor
  return new ctor({ track })
}

// Stride-subsamples a Y plane (or any 1-byte-per-pixel plane with row
// padding) down to roughly targetWidth. Pure and unit-tested.
export function subsamplePlane(
  src: Uint8Array,
  srcOffset: number,
  srcStride: number,
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
  out: Uint8Array,
): { width: number; height: number } {
  const step = Math.max(1, Math.floor(srcWidth / targetWidth))
  const width = Math.floor(srcWidth / step)
  const height = Math.floor(srcHeight / step)
  for (let y = 0; y < height; y++) {
    const srcRow = srcOffset + y * step * srcStride
    const outRow = y * width
    for (let x = 0; x < width; x++) {
      out[outRow + x] = src[srcRow + x * step]
    }
  }
  return { width, height }
}

// Same subsampling over packed 4-byte pixels, converting to Rec. 709 luma.
// rIndex/bIndex select the channel order (RGBA vs BGRA).
export function subsamplePacked(
  src: Uint8Array,
  srcStride: number,
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
  rIndex: number,
  bIndex: number,
  out: Uint8Array,
): { width: number; height: number } {
  const step = Math.max(1, Math.floor(srcWidth / targetWidth))
  const width = Math.floor(srcWidth / step)
  const height = Math.floor(srcHeight / step)
  for (let y = 0; y < height; y++) {
    const srcRow = y * step * srcStride
    const outRow = y * width
    for (let x = 0; x < width; x++) {
      const p = srcRow + x * step * 4
      out[outRow + x] =
        0.2126 * src[p + rIndex] + 0.7152 * src[p + 1] + 0.0722 * src[p + bIndex]
    }
  }
  return { width, height }
}

export interface WebCodecsProbeOptions {
  targetWidth?: number
  reduce?: StripReduceConfig
  createTrackProcessor?: CreateTrackProcessor
  clock?: ClockLike
  // Called after each processed frame with the strip energies (for the
  // per-frame bar rendering — direct canvas, not reactive state).
  onFrame?: (energies: readonly number[], workingPixels: number) => void
}

export interface TimestampDeltaStats {
  count: number
  medianDeltaMs: number | undefined
  jitterStddevMs: number | undefined
}

export interface WebCodecsProbeSnapshot {
  frames: number
  processed: number
  errors: number
  lastError: string | undefined
  format: string | null
  codedWidth: number
  codedHeight: number
  workingWidth: number
  workingHeight: number
  elapsedMs: number
  processedPerSecond: number
  rollingFramesPerSecond: number | undefined
  stages: { copy?: LatencyStats; reduce?: LatencyStats; total?: LatencyStats }
  rollingTotal: LatencyStats | undefined
  drift: DriftReport | undefined
  frameTimestamps: TimestampDeltaStats
  lastEnergies: number[]
  running: boolean
}

const ROLLING_WINDOW_SIZE = 180
const RATE_WINDOW = 180

export class WebCodecsPipelineProbe {
  readonly #clock: ClockLike
  readonly #targetWidth: number
  readonly #reducer: StripReducer
  readonly #onFrame: WebCodecsProbeOptions['onFrame']
  readonly #reader: FrameReaderLike

  #running = false
  #startedAt = 0
  #frames = 0
  #processed = 0
  #errors = 0
  #lastError: string | undefined
  #format: string | null = null
  #codedWidth = 0
  #codedHeight = 0
  #workingWidth = 0
  #workingHeight = 0
  #copyBuffer = new Uint8Array(0)
  #lumaBuffer = new Uint8Array(0)
  #lastEnergies: number[] = []
  #lastTimestampUs: number | null = null
  readonly #timestampDeltasMs: number[] = []
  readonly #copy: number[] = []
  readonly #reduceTimes: number[] = []
  readonly #total: number[] = []
  readonly #processedNows: number[] = []

  constructor(track: MediaStreamTrack, options: WebCodecsProbeOptions = {}) {
    this.#clock = options.clock ?? defaultClock()
    this.#targetWidth = options.targetWidth ?? 256
    this.#reducer = new StripReducer(options.reduce ?? DEFAULT_STRIP_REDUCE_CONFIG)
    this.#onFrame = options.onFrame
    this.#reader = (options.createTrackProcessor ?? defaultCreateTrackProcessor)(track)
      .readable.getReader()
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#startedAt = this.#clock.now()
    void this.#pump()
  }

  stop(): void {
    if (!this.#running) return
    this.#running = false
    void this.#reader.cancel()
  }

  async #pump(): Promise<void> {
    while (this.#running) {
      let frame: VideoFrameCaptureLike | undefined
      try {
        const result = await this.#reader.read()
        frame = result.value
        if (result.done || frame === undefined) break
        if (!this.#running) break
        this.#frames++
        await this.#processFrame(frame)
      } catch (error) {
        this.#errors++
        this.#lastError = error instanceof Error ? error.message : String(error)
      } finally {
        frame?.close()
      }
    }
  }

  async #processFrame(frame: VideoFrameCaptureLike): Promise<void> {
    this.#format = frame.format
    this.#codedWidth = frame.codedWidth
    this.#codedHeight = frame.codedHeight
    if (frame.timestamp !== null) {
      if (this.#lastTimestampUs !== null) {
        this.#timestampDeltasMs.push((frame.timestamp - this.#lastTimestampUs) / 1000)
      }
      this.#lastTimestampUs = frame.timestamp
    }

    const clock = this.#clock
    const t0 = clock.now()
    const size = frame.allocationSize()
    if (this.#copyBuffer.length < size) this.#copyBuffer = new Uint8Array(size)
    const layout = await frame.copyTo(this.#copyBuffer)
    const t1 = clock.now()

    const format = frame.format ?? ''
    const lumaCapacity = frame.codedWidth * frame.codedHeight
    if (this.#lumaBuffer.length < lumaCapacity) this.#lumaBuffer = new Uint8Array(lumaCapacity)
    let dims: { width: number; height: number }
    if (format.startsWith('I4') || format.startsWith('NV')) {
      dims = subsamplePlane(
        this.#copyBuffer,
        layout[0]?.offset ?? 0,
        layout[0]?.stride ?? frame.codedWidth,
        frame.codedWidth,
        frame.codedHeight,
        this.#targetWidth,
        this.#lumaBuffer,
      )
    } else if (format.startsWith('RGB')) {
      dims = subsamplePacked(
        this.#copyBuffer,
        layout[0]?.stride ?? frame.codedWidth * 4,
        frame.codedWidth,
        frame.codedHeight,
        this.#targetWidth,
        0,
        2,
        this.#lumaBuffer,
      )
    } else if (format.startsWith('BGR')) {
      dims = subsamplePacked(
        this.#copyBuffer,
        layout[0]?.stride ?? frame.codedWidth * 4,
        frame.codedWidth,
        frame.codedHeight,
        this.#targetWidth,
        2,
        0,
        this.#lumaBuffer,
      )
    } else {
      throw new Error(`unsupported VideoFrame format: ${frame.format}`)
    }
    this.#workingWidth = dims.width
    this.#workingHeight = dims.height
    const energies = this.#reducer.processLuminance(this.#lumaBuffer, dims.width, dims.height)
    const t2 = clock.now()

    this.#copy.push(t1 - t0)
    this.#reduceTimes.push(t2 - t1)
    this.#total.push(t2 - t0)
    this.#lastEnergies = [...energies]
    this.#processed++
    this.#processedNows.push(t2)
    if (this.#processedNows.length > RATE_WINDOW) this.#processedNows.shift()
    this.#onFrame?.(this.#lastEnergies, dims.width * dims.height)
  }

  #timestampStats(): TimestampDeltaStats {
    const deltas = this.#timestampDeltasMs
    if (deltas.length < 2) {
      return { count: deltas.length, medianDeltaMs: undefined, jitterStddevMs: undefined }
    }
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length
    const variance = deltas.reduce((a, b) => a + (b - mean) * (b - mean), 0) / deltas.length
    return {
      count: deltas.length,
      medianDeltaMs: medianOf(deltas),
      jitterStddevMs: Math.sqrt(variance),
    }
  }

  snapshot(): WebCodecsProbeSnapshot {
    const elapsedMs = this.#clock.now() - this.#startedAt
    let rollingFramesPerSecond: number | undefined
    if (this.#processedNows.length >= 2) {
      const span = this.#processedNows[this.#processedNows.length - 1] - this.#processedNows[0]
      if (span > 0) rollingFramesPerSecond = ((this.#processedNows.length - 1) * 1000) / span
    }
    return {
      frames: this.#frames,
      processed: this.#processed,
      errors: this.#errors,
      lastError: this.#lastError,
      format: this.#format,
      codedWidth: this.#codedWidth,
      codedHeight: this.#codedHeight,
      workingWidth: this.#workingWidth,
      workingHeight: this.#workingHeight,
      elapsedMs,
      processedPerSecond: elapsedMs > 0 ? (this.#processed * 1000) / elapsedMs : 0,
      rollingFramesPerSecond,
      stages: {
        copy: computeLatencyStats(this.#copy),
        reduce: computeLatencyStats(this.#reduceTimes),
        total: computeLatencyStats(this.#total),
      },
      rollingTotal: computeLatencyStats(this.#total.slice(-ROLLING_WINDOW_SIZE)),
      drift: computeDrift(this.#total),
      frameTimestamps: this.#timestampStats(),
      lastEnergies: this.#lastEnergies,
      running: this.#running,
    }
  }
}
