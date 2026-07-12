// Readback benchmark harness (device-spike work item 5): per frame, import →
// luminance pass → copy into a staging-ring buffer → mapAsync, measuring the
// JS-visible end-to-end latency from submit until the value is CPU-visible.
// Timing caveat: everything here is measured from JS, so it captures when
// results become visible to the CPU state machine — not how long the GPU
// spent. That is exactly the number the go/no-go threshold is about
// ("sustained readback latency ≤ one frame interval"), but it is not a
// GPU-profiling tool.

import type { ClockLike } from '../frame-loop/frame-loop'
import { defaultClock } from '../frame-loop/frame-loop'
import { CopyTarget, isExternalImportable, type SpikeFrame } from './frame-import'
import { FULL_FRAME_ROI, LuminancePass, type Roi } from './luminance-pass'
import {
  computeDrift,
  computeLatencyStats,
  DEFAULT_DRIFT_WINDOW_SIZE,
  type DriftReport,
  type LatencyStats,
} from './readback-stats'
import { createStagingRing, READBACK_RESULT_BYTES, type StagingRing } from './staging-ring'

export type ImportPath = 'external' | 'copy'

// What the harness pulls a frame from on each tick. nextFrame() returning
// undefined means "no frame available this tick" (counted, not an error);
// releaseFrame is where VideoFrame sources close their frames after the GPU
// work for the tick is submitted.
export interface SpikeSource {
  nextFrame(): SpikeFrame | undefined
  releaseFrame?(frame: SpikeFrame): void
}

export function videoElementSource(video: HTMLVideoElement): SpikeSource {
  return { nextFrame: () => video }
}

// Only the tick time is needed; frame-loop's FrameSample satisfies this
// structurally, so the /diag panel can pass FrameLoop samples straight
// through.
export interface ReadbackTick {
  now: number
}

export interface ReadbackHarnessOptions {
  path: ImportPath
  roi?: Roi
  clock?: ClockLike
  driftWindowSize?: number
  // Process every Nth frame-loop tick (default 1 = every tick). Skipped ticks
  // are invisible to the harness — they count as neither ticks, overruns, nor
  // skips — so N=2 measures the same chain at half the submission rate while
  // rVFC delivery stays untouched (ADR 0008's half-rate disambiguation run).
  // rollingTicksPerSecond then reflects the PROCESSED rate (~camera rate / N).
  tickDecimation?: number
}

export interface ReadbackSnapshot {
  path: ImportPath
  // 1 = every tick was processed; N = only every Nth tick was (half rate = 2).
  // All counters and rates below cover processed ticks only.
  tickDecimation: number
  ticks: number
  submitted: number
  completed: number
  // Ticks dropped because all staging buffers were still pending — the
  // "readback overrun" counter; the frame loop is never blocked.
  overruns: number
  skippedNoFrame: number
  errors: number
  lastError: string | undefined
  // Last luminance mean read back (0..1) — a sanity value, not a stat.
  lastValue: number | undefined
  elapsedMs: number | undefined
  completedPerSecond: number | undefined
  // Tick rate over the last ROLLING_WINDOW_SIZE ticks — the concurrent
  // frame-rate trace for the sustain run. A comfortable rolling latency is
  // only a pass at the frame rate actually delivered at that moment: if the
  // camera thermally drops 60→30 fps, per-frame latency gains headroom while
  // the granted rate silently degrades, and this number is what shows it.
  // Covers PROCESSED ticks: at tickDecimation N this is ~camera rate / N.
  rollingTicksPerSecond: number | undefined
  overall: LatencyStats | undefined
  rolling: LatencyStats | undefined
  drift: DriftReport | undefined
}

export const ROLLING_WINDOW_SIZE = 180

export class ReadbackHarness {
  private readonly clock: ClockLike
  private readonly path: ImportPath
  private readonly pass: LuminancePass
  private readonly ring: StagingRing<GPUBuffer>
  private readonly copyTarget: CopyTarget
  private readonly driftWindowSize: number
  private readonly tickDecimation: number
  private rawTicks = 0

  // Completion-order latency samples; ~18k numbers over a 5-minute 60 fps
  // run, cheap to keep whole so overall stats and drift windows stay exact.
  private readonly latencies: number[] = []
  private readonly recentTickNows: number[] = []
  private ticks = 0
  private submitted = 0
  private completed = 0
  private skippedNoFrame = 0
  private encodeErrors = 0
  private readbackErrors = 0
  private lastError: string | undefined
  private lastValue: number | undefined
  private firstTickNow: number | undefined
  private lastTickNow: number | undefined
  private destroyed = false

  constructor(
    private readonly device: GPUDevice,
    private readonly source: SpikeSource,
    options: ReadbackHarnessOptions,
  ) {
    this.path = options.path
    this.clock = options.clock ?? defaultClock()
    this.pass = new LuminancePass(device, options.roi ?? FULL_FRAME_ROI)
    this.ring = createStagingRing(device)
    this.copyTarget = new CopyTarget(device)
    this.driftWindowSize = options.driftWindowSize ?? DEFAULT_DRIFT_WINDOW_SIZE
    this.tickDecimation = Math.max(1, Math.floor(options.tickDecimation ?? 1))
  }

  // Per-frame entry point, wired to FrameLoop by the /diag panel. Never
  // throws and never blocks: failures are counted into the snapshot.
  onFrame(tick: ReadbackTick): void {
    if (this.destroyed) return
    if (this.rawTicks++ % this.tickDecimation !== 0) return
    this.ticks++
    this.firstTickNow ??= tick.now
    this.lastTickNow = tick.now
    this.recentTickNows.push(tick.now)
    if (this.recentTickNows.length > ROLLING_WINDOW_SIZE) this.recentTickNows.shift()

    const frame = this.source.nextFrame()
    if (frame === undefined) {
      this.skippedNoFrame++
      return
    }

    const slot = this.ring.acquire()
    if (slot === undefined) {
      this.source.releaseFrame?.(frame)
      return
    }

    let submitTime: number
    try {
      const encoder = this.device.createCommandEncoder()
      this.encodeImportAndPass(encoder, frame)
      encoder.copyBufferToBuffer(this.pass.resultBuffer, 0, slot.buffer, 0, READBACK_RESULT_BYTES)
      const commands = encoder.finish()
      submitTime = this.clock.now()
      this.device.queue.submit([commands])
      this.submitted++
    } catch (error) {
      this.encodeErrors++
      this.recordError(error)
      this.ring.release(slot)
      this.source.releaseFrame?.(frame)
      return
    }
    this.source.releaseFrame?.(frame)

    void this.ring.readValue(slot).then(
      (value) => {
        this.completed++
        this.lastValue = value
        this.latencies.push(this.clock.now() - submitTime)
      },
      (error: unknown) => {
        this.readbackErrors++
        this.recordError(error)
      },
    )
  }

  snapshot(): ReadbackSnapshot {
    const elapsedMs =
      this.firstTickNow !== undefined && this.lastTickNow !== undefined
        ? this.lastTickNow - this.firstTickNow
        : undefined
    return {
      path: this.path,
      tickDecimation: this.tickDecimation,
      ticks: this.ticks,
      submitted: this.submitted,
      completed: this.completed,
      overruns: this.ring.overruns,
      skippedNoFrame: this.skippedNoFrame,
      errors: this.encodeErrors + this.readbackErrors,
      lastError: this.lastError,
      lastValue: this.lastValue,
      elapsedMs,
      completedPerSecond:
        elapsedMs !== undefined && elapsedMs > 0 ? (this.completed / elapsedMs) * 1000 : undefined,
      rollingTicksPerSecond: this.rollingTickRate(),
      overall: computeLatencyStats(this.latencies),
      rolling: computeLatencyStats(this.latencies.slice(-ROLLING_WINDOW_SIZE)),
      drift: computeDrift(this.latencies, this.driftWindowSize),
    }
  }

  // True once every submitted frame's readback has completed or errored.
  // Encode-phase errors never submitted anything, so they are excluded — an
  // encode error must not mark the harness drained while a mapAsync from an
  // earlier submit is still pending.
  get drained(): boolean {
    return this.completed + this.readbackErrors >= this.submitted
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.pass.destroy()
    this.ring.destroy()
    this.copyTarget.destroy()
  }

  private rollingTickRate(): number | undefined {
    const ticks = this.recentTickNows
    if (ticks.length < 2) return undefined
    const spanMs = ticks[ticks.length - 1] - ticks[0]
    return spanMs > 0 ? ((ticks.length - 1) / spanMs) * 1000 : undefined
  }

  private encodeImportAndPass(encoder: GPUCommandEncoder, frame: SpikeFrame): void {
    if (this.path === 'external') {
      if (!isExternalImportable(frame)) {
        throw new Error('importExternalTexture needs an HTMLVideoElement or VideoFrame source')
      }
      const texture = this.device.importExternalTexture({ source: frame })
      this.pass.encodeExternal(encoder, texture)
    } else {
      const texture = this.copyTarget.copyFrame(frame)
      this.pass.encodeTexture2d(encoder, texture)
    }
  }

  private recordError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error)
  }
}
