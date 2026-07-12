// CPU-pipeline probe (post-session addition to the device spike, see ADR
// 0008): measures whether drawImage-downscale → getImageData → StripReducer
// can run at camera rate on the target phone. Stage costs are measured with
// the same clock discipline as the GPU readback benchmark so the two are
// directly comparable. Throwaway-quality measurement code, except
// StripReducer (candidate production seed).

import { defaultClock, type ClockLike } from '../frame-loop/frame-loop'
import {
  computeDrift,
  computeLatencyStats,
  type DriftReport,
  type LatencyStats,
} from '../gpu/readback-stats'
import { DEFAULT_STRIP_REDUCE_CONFIG, StripReducer, type StripReduceConfig } from './strip-reduce'

export interface ImageDataLike {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface Context2dLike {
  drawImage(source: unknown, dx: number, dy: number, dw: number, dh: number): void
  getImageData(x: number, y: number, w: number, h: number): ImageDataLike
}

export interface Canvas2dLike {
  width: number
  height: number
  getContext(contextId: '2d', options?: { willReadFrequently?: boolean }): Context2dLike | null
}

export interface CpuProbeVideoLike {
  videoWidth: number
  videoHeight: number
}

function defaultCreateCanvas(): Canvas2dLike {
  return document.createElement('canvas')
}

export interface CpuPipelineProbeOptions {
  // Working width per detection.md (~256 px); height follows the video's
  // aspect ratio.
  targetWidth?: number
  reduce?: StripReduceConfig
  // Chromium keeps the canvas CPU-backed with the hint (cheap getImageData,
  // CPU-side drawImage) and GPU-backed without it (GPU drawImage, expensive
  // readback). Which wins on the target phone is exactly what the probe
  // measures, so it is a run option, not a constant.
  willReadFrequently?: boolean
  createCanvas?: () => Canvas2dLike
  clock?: ClockLike
}

export interface CpuStageStats {
  draw?: LatencyStats
  read?: LatencyStats
  reduce?: LatencyStats
  total?: LatencyStats
}

export interface CpuPipelineSnapshot {
  ticks: number
  processed: number
  skippedNoVideo: number
  // Working-resolution recomputations (video dimension changes); each one
  // re-seeds the EMA background.
  resets: number
  workingWidth: number
  workingHeight: number
  willReadFrequently: boolean
  elapsedMs: number
  processedPerSecond: number
  rollingTicksPerSecond: number | undefined
  stages: CpuStageStats
  rollingTotal: LatencyStats | undefined
  drift: DriftReport | undefined
  lastEnergies: number[]
  lastError: string | undefined
  errors: number
}

const ROLLING_WINDOW_SIZE = 180
const TICK_RATE_WINDOW = 180

export class CpuPipelineProbe {
  readonly #video: CpuProbeVideoLike
  readonly #clock: ClockLike
  readonly #targetWidth: number
  readonly #willReadFrequently: boolean
  readonly #canvas: Canvas2dLike
  readonly #context: Context2dLike
  readonly #reducer: StripReducer

  #startedAt: number
  #ticks = 0
  #processed = 0
  #skippedNoVideo = 0
  #resets = 0
  #errors = 0
  #lastError: string | undefined
  #workingWidth = 0
  #workingHeight = 0
  #sourceWidth = 0
  #sourceHeight = 0
  #lastEnergies: number[] = []
  readonly #draw: number[] = []
  readonly #read: number[] = []
  readonly #reduce: number[] = []
  readonly #total: number[] = []
  readonly #tickNows: number[] = []

  constructor(video: CpuProbeVideoLike, options: CpuPipelineProbeOptions = {}) {
    this.#video = video
    this.#clock = options.clock ?? defaultClock()
    this.#targetWidth = options.targetWidth ?? 256
    this.#willReadFrequently = options.willReadFrequently ?? true
    this.#canvas = (options.createCanvas ?? defaultCreateCanvas)()
    const context = this.#canvas.getContext('2d', {
      willReadFrequently: this.#willReadFrequently,
    })
    if (context === null) throw new Error('canvas.getContext("2d") returned null')
    this.#context = context
    this.#reducer = new StripReducer(options.reduce ?? DEFAULT_STRIP_REDUCE_CONFIG)
    this.#startedAt = this.#clock.now()
  }

  get lastEnergies(): readonly number[] {
    return this.#lastEnergies
  }

  get workingSize(): { width: number; height: number } {
    return { width: this.#workingWidth, height: this.#workingHeight }
  }

  onFrame(tick: { now: number }): void {
    this.#ticks++
    this.#tickNows.push(tick.now)
    if (this.#tickNows.length > TICK_RATE_WINDOW) this.#tickNows.shift()

    const sourceWidth = this.#video.videoWidth
    const sourceHeight = this.#video.videoHeight
    if (sourceWidth === 0 || sourceHeight === 0) {
      this.#skippedNoVideo++
      return
    }
    if (sourceWidth !== this.#sourceWidth || sourceHeight !== this.#sourceHeight) {
      this.#sourceWidth = sourceWidth
      this.#sourceHeight = sourceHeight
      this.#workingWidth = Math.min(this.#targetWidth, sourceWidth)
      this.#workingHeight = Math.max(1, Math.round((sourceHeight / sourceWidth) * this.#workingWidth))
      this.#canvas.width = this.#workingWidth
      this.#canvas.height = this.#workingHeight
      this.#reducer.reset()
      this.#resets++
    }

    const clock = this.#clock
    try {
      const t0 = clock.now()
      this.#context.drawImage(this.#video, 0, 0, this.#workingWidth, this.#workingHeight)
      const t1 = clock.now()
      const image = this.#context.getImageData(0, 0, this.#workingWidth, this.#workingHeight)
      const t2 = clock.now()
      const energies = this.#reducer.process(image.data, image.width, image.height)
      const t3 = clock.now()

      this.#draw.push(t1 - t0)
      this.#read.push(t2 - t1)
      this.#reduce.push(t3 - t2)
      this.#total.push(t3 - t0)
      this.#lastEnergies = [...energies]
      this.#processed++
    } catch (error) {
      this.#errors++
      this.#lastError = error instanceof Error ? error.message : String(error)
    }
  }

  snapshot(): CpuPipelineSnapshot {
    const elapsedMs = this.#clock.now() - this.#startedAt
    let rollingTicksPerSecond: number | undefined
    if (this.#tickNows.length >= 2) {
      const spanMs = this.#tickNows[this.#tickNows.length - 1] - this.#tickNows[0]
      if (spanMs > 0) rollingTicksPerSecond = ((this.#tickNows.length - 1) * 1000) / spanMs
    }
    return {
      ticks: this.#ticks,
      processed: this.#processed,
      skippedNoVideo: this.#skippedNoVideo,
      resets: this.#resets,
      workingWidth: this.#workingWidth,
      workingHeight: this.#workingHeight,
      willReadFrequently: this.#willReadFrequently,
      elapsedMs,
      processedPerSecond: elapsedMs > 0 ? (this.#processed * 1000) / elapsedMs : 0,
      rollingTicksPerSecond,
      stages: {
        draw: computeLatencyStats(this.#draw),
        read: computeLatencyStats(this.#read),
        reduce: computeLatencyStats(this.#reduce),
        total: computeLatencyStats(this.#total),
      },
      rollingTotal: computeLatencyStats(this.#total.slice(-ROLLING_WINDOW_SIZE)),
      drift: computeDrift(this.#total),
      lastEnergies: this.#lastEnergies,
      lastError: this.#lastError,
      errors: this.#errors,
    }
  }
}
