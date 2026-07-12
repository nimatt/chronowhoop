// CameraSource — the production WebCodecs capture path (ADR 0009,
// detection.md "Capture"): MediaStreamTrackProcessor delivers VideoFrames off
// the camera track; only the ROI is copied out (copyTo with a crop rect); the
// Y plane is read directly as luminance for the planar formats Android
// cameras deliver (NV12/I420), stride-subsampled to the working resolution.
// Packed RGB/BGR formats convert to Rec. 709 luma during subsampling.
//
// Backpressure (detection.md): frames drop at the source — MSTP's internal
// queue keeps only the newest frames while the pump processes serially, so no
// frame queue exists here and undelivered frames cost nothing. Timestamps are
// VideoFrame.timestamp (a capture timestamp by construction); a frame without
// one is skipped and counted as an error rather than stamped with wall-clock
// time, because capture-time fidelity is the point of this path.
//
// Evolved from the /diag spike (src/core/cpu-pipeline/webcodecs-probe.ts),
// which stays frozen as a diagnostic instrument — detection never imports
// from cpu-pipeline.

import { defaultMediaStreamTrackProcessor } from './capture-support'
import type { LumaSource } from './frame-source'
import type { LumaFrame, NormalizedRect } from './types'

export interface PlaneLayoutLike {
  offset: number
  stride: number
}

// Pixel coordinates on the frame's coded size.
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

export interface VideoFrameCopyOptionsLike {
  rect?: PixelRect
}

// Structural subset of VideoFrame, injectable in tests (spike pattern).
export interface VideoFrameLike {
  format: string | null
  codedWidth: number
  codedHeight: number
  timestamp: number | null
  allocationSize(options?: VideoFrameCopyOptionsLike): number
  copyTo(
    destination: Uint8Array,
    options?: VideoFrameCopyOptionsLike,
  ): Promise<PlaneLayoutLike[]>
  close(): void
}

export interface FrameReaderLike {
  read(): Promise<{ done: boolean; value?: VideoFrameLike }>
  cancel(): Promise<void> | void
}

export interface TrackProcessorLike {
  readable: { getReader(): FrameReaderLike }
}

export type CreateTrackProcessor = (track: MediaStreamTrack) => TrackProcessorLike

export interface CameraSourceOptions {
  // Normalized crop on the camera frame; defaults to the full frame.
  roi?: NormalizedRect
  // Working width the cropped ROI is subsampled toward (never upsampled).
  targetWidth?: number
  createTrackProcessor?: CreateTrackProcessor
}

export interface CameraSourceStats {
  // Frames read off the track (including skipped/errored ones).
  frames: number
  // LumaFrames delivered to the consumer.
  emitted: number
  // Pull-style error channel (there is no callback): per-frame processing
  // errors are counted here and capture continues; a reader read() failure is
  // also counted but ENDS capture (see #pump).
  errors: number
  lastError: string | undefined
  format: string | null
  codedWidth: number
  codedHeight: number
  // The crop actually used on the last processed frame, post-alignment.
  cropRect: PixelRect | undefined
  // False once a rect-cropped copyTo has failed and the source switched
  // permanently to full-frame copies (crop happens during subsampling
  // instead). The S22 cost re-measurement (ADR 0009) must know which path
  // ran, since only the rect path realizes the ROI-cropped copy saving.
  usedRectCopy: boolean
}

export const DEFAULT_TARGET_WIDTH = 256

// Working-resolution pixel budget (256×144, the target resolution's area).
// The subsample step is chosen against BOTH the target width and this budget,
// so a narrow-tall ROI cannot sneak a near-full-res crop past a width-only
// step (300×700 with step 1 would be ~6× the intended per-frame pixel work
// and recorder memory). Every emitted LumaFrame is ≤ TARGET_PIXELS bytes —
// the recorder's frame cap sizes its worst-case memory from this bound.
export const TARGET_PIXELS = 256 * 144

const FULL_FRAME_ROI: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 }

function defaultCreateTrackProcessor(track: MediaStreamTrack): TrackProcessorLike {
  const ctor = defaultMediaStreamTrackProcessor() as
    | (new (init: { track: MediaStreamTrack }) => TrackProcessorLike)
    | undefined
  if (typeof ctor !== 'function') {
    throw new Error('MediaStreamTrackProcessor is not available in this browser')
  }
  return new ctor({ track })
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

// Maps a normalized ROI to pixel coordinates on the coded size, rounded
// OUTWARD to even x/y/width/height: NV12/I420 chroma is 2×2 subsampled, so
// copyTo rects must be even-aligned in those formats; for packed formats the
// ≤1 px enlargement per edge is harmless, so one alignment path serves all.
// The result is clamped to the coded size and never smaller than 2×2.
export function alignRoiToCropRect(
  roi: NormalizedRect,
  codedWidth: number,
  codedHeight: number,
): PixelRect {
  const maxRight = 2 * Math.floor(codedWidth / 2)
  const maxBottom = 2 * Math.floor(codedHeight / 2)
  let x = 2 * Math.floor((clamp01(roi.x) * codedWidth) / 2)
  let right = Math.min(maxRight, 2 * Math.ceil((clamp01(roi.x + roi.width) * codedWidth) / 2))
  let y = 2 * Math.floor((clamp01(roi.y) * codedHeight) / 2)
  let bottom = Math.min(maxBottom, 2 * Math.ceil((clamp01(roi.y + roi.height) * codedHeight) / 2))
  if (right - x < 2) {
    right = Math.min(maxRight, x + 2)
    x = Math.max(0, right - 2)
  }
  if (bottom - y < 2) {
    bottom = Math.min(maxBottom, y + 2)
    y = Math.max(0, bottom - 2)
  }
  return { x, y, width: right - x, height: bottom - y }
}

export interface SubsampledLuma {
  data: Uint8Array
  width: number
  height: number
}

// The smallest integer step keeping the working resolution within budget:
// floor(srcWidth/step) ≤ the width-derived target AND
// floor(srcWidth/step)·floor(srcHeight/step) ≤ TARGET_PIXELS. Never
// upsamples (step ≥ 1 even when the crop is already small), and clamps the
// step to srcHeight so a degenerate flat ROI still yields at least one row
// (that clamp wins over the budget, but a crop of ≤ srcHeight rows is far
// below TARGET_PIXELS for any real camera width).
function subsampleStep(srcWidth: number, srcHeight: number, targetWidth: number): number {
  let step = Math.max(1, Math.floor(srcWidth / targetWidth))
  while (Math.floor(srcWidth / step) * Math.floor(srcHeight / step) > TARGET_PIXELS) {
    step++
  }
  return Math.max(1, Math.min(step, srcHeight))
}

// Stride-subsamples a 1-byte-per-pixel luminance region (a Y plane, possibly
// row-padded, starting at srcOffset) down to roughly targetWidth. Allocates a
// fresh output per call — LumaFrame ownership transfers on emit.
export function subsampleLuma(
  src: Uint8Array,
  srcOffset: number,
  srcStride: number,
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
): SubsampledLuma {
  const step = subsampleStep(srcWidth, srcHeight, targetWidth)
  const width = Math.floor(srcWidth / step)
  const height = Math.floor(srcHeight / step)
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const srcRow = srcOffset + y * step * srcStride
    const outRow = y * width
    for (let x = 0; x < width; x++) {
      data[outRow + x] = src[srcRow + x * step]
    }
  }
  return { data, width, height }
}

// Same subsampling over packed 4-byte pixels, converting to Rec. 709 luma.
// rIndex/bIndex select the channel order (RGBA/RGBX vs BGRA/BGRX).
export function subsamplePackedToLuma(
  src: Uint8Array,
  srcOffset: number,
  srcStride: number,
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
  rIndex: number,
  bIndex: number,
): SubsampledLuma {
  const step = subsampleStep(srcWidth, srcHeight, targetWidth)
  const width = Math.floor(srcWidth / step)
  const height = Math.floor(srcHeight / step)
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const srcRow = srcOffset + y * step * srcStride
    const outRow = y * width
    for (let x = 0; x < width; x++) {
      const p = srcRow + x * step * 4
      data[outRow + x] = 0.2126 * src[p + rIndex] + 0.7152 * src[p + 1] + 0.0722 * src[p + bIndex]
    }
  }
  return { data, width, height }
}

type LumaConversion = { kind: 'planar' } | { kind: 'packed'; rIndex: number; bIndex: number }

function lumaConversionFor(format: string | null): LumaConversion {
  const f = format ?? ''
  if (f.startsWith('I4') || f.startsWith('NV')) return { kind: 'planar' }
  if (f.startsWith('RGB')) return { kind: 'packed', rIndex: 0, bIndex: 2 }
  if (f.startsWith('BGR')) return { kind: 'packed', rIndex: 2, bIndex: 0 }
  throw new Error(`unsupported VideoFrame format: ${format}`)
}

// Single-use: stop() cancels the track reader, so a stopped source cannot be
// restarted — create a new CameraSource per capture session.
export class CameraSource implements LumaSource {
  readonly #targetWidth: number
  readonly #reader: FrameReaderLike

  #roi: NormalizedRect
  #onFrame: ((frame: LumaFrame) => void) | undefined
  #running = false
  #stopped = false
  #copyBuffer = new Uint8Array(0)
  #rectCopySupported = true
  #frames = 0
  #emitted = 0
  #errors = 0
  #lastError: string | undefined
  #format: string | null = null
  #codedWidth = 0
  #codedHeight = 0
  #cropRect: PixelRect | undefined

  constructor(track: MediaStreamTrack, options: CameraSourceOptions = {}) {
    this.#roi = { ...(options.roi ?? FULL_FRAME_ROI) }
    this.#targetWidth = options.targetWidth ?? DEFAULT_TARGET_WIDTH
    if (!Number.isInteger(this.#targetWidth) || this.#targetWidth < 1) {
      throw new Error(`targetWidth must be a positive integer, got ${this.#targetWidth}`)
    }
    this.#reader = (options.createTrackProcessor ?? defaultCreateTrackProcessor)(track)
      .readable.getReader()
  }

  // Takes effect on the next frame (the /lab ROI drag adjusts this live).
  setRoi(roi: NormalizedRect): void {
    this.#roi = { ...roi }
  }

  start(onFrame: (frame: LumaFrame) => void): void {
    if (this.#running) throw new Error('CameraSource is already started')
    if (this.#stopped) {
      throw new Error('CameraSource cannot restart after stop(); create a new instance')
    }
    this.#running = true
    this.#onFrame = onFrame
    void this.#pump()
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#running = false
    void this.#reader.cancel()
  }

  stats(): CameraSourceStats {
    return {
      frames: this.#frames,
      emitted: this.#emitted,
      errors: this.#errors,
      lastError: this.#lastError,
      format: this.#format,
      codedWidth: this.#codedWidth,
      codedHeight: this.#codedHeight,
      cropRect: this.#cropRect ? { ...this.#cropRect } : undefined,
      usedRectCopy: this.#rectCopySupported,
    }
  }

  // Serial pump: read → process → close, one frame at a time; while a frame
  // is in flight MSTP's own queue drops stale frames at the source. Errors
  // never escape the loop, but read and processing failures differ: a
  // per-frame PROCESSING error is counted and the pump continues, while a
  // read() rejection ENDS capture — an errored ReadableStream rejects every
  // subsequent read() immediately, so retrying would spin a microtask busy
  // loop forever. Both are surfaced via stats() (errors + lastError).
  async #pump(): Promise<void> {
    while (this.#running) {
      let frame: VideoFrameLike | undefined
      try {
        const result = await this.#reader.read()
        frame = result.value
        if (result.done || frame === undefined) {
          frame?.close()
          break
        }
      } catch (error) {
        this.#errors++
        this.#lastError = error instanceof Error ? error.message : String(error)
        break
      }
      try {
        if (!this.#running) break
        this.#frames++
        await this.#processFrame(frame)
      } catch (error) {
        this.#errors++
        this.#lastError = error instanceof Error ? error.message : String(error)
      } finally {
        frame.close()
      }
    }
    this.#running = false
  }

  async #processFrame(frame: VideoFrameLike): Promise<void> {
    this.#format = frame.format
    this.#codedWidth = frame.codedWidth
    this.#codedHeight = frame.codedHeight
    if (frame.timestamp === null) {
      throw new Error('VideoFrame.timestamp is null; frame skipped (capture timestamps are the timing source)')
    }
    const conversion = lumaConversionFor(frame.format)
    const rect = alignRoiToCropRect(this.#roi, frame.codedWidth, frame.codedHeight)
    this.#cropRect = rect

    let layout: PlaneLayoutLike[] | undefined
    if (this.#rectCopySupported) {
      try {
        layout = await this.#copyInto(frame, { rect })
      } catch {
        this.#rectCopySupported = false
      }
    }
    const bufferHoldsCropOnly = layout !== undefined
    if (layout === undefined) {
      layout = await this.#copyInto(frame)
    }
    const plane = layout[0]
    if (plane === undefined) {
      throw new Error('copyTo returned no plane layout')
    }

    const bytesPerPixel = conversion.kind === 'planar' ? 1 : 4
    const offset = bufferHoldsCropOnly
      ? plane.offset
      : plane.offset + rect.y * plane.stride + rect.x * bytesPerPixel
    const luma =
      conversion.kind === 'planar'
        ? subsampleLuma(this.#copyBuffer, offset, plane.stride, rect.width, rect.height, this.#targetWidth)
        : subsamplePackedToLuma(
            this.#copyBuffer,
            offset,
            plane.stride,
            rect.width,
            rect.height,
            this.#targetWidth,
            conversion.rIndex,
            conversion.bIndex,
          )

    this.#emitted++
    this.#onFrame?.({ ...luma, captureTimeMs: frame.timestamp / 1000 })
  }

  async #copyInto(
    frame: VideoFrameLike,
    options?: VideoFrameCopyOptionsLike,
  ): Promise<PlaneLayoutLike[]> {
    const size = frame.allocationSize(options)
    if (this.#copyBuffer.length < size) this.#copyBuffer = new Uint8Array(size)
    return frame.copyTo(this.#copyBuffer, options)
  }
}
