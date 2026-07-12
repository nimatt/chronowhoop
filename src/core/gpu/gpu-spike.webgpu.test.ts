import { describe, expect, it } from 'vitest'
import { observeDeviceLoss, type DeviceLossEvent } from './device-loss-observer'
import { LuminancePass } from './luminance-pass'
import {
  ReadbackHarness,
  type ImportPath,
  type ReadbackSnapshot,
  type SpikeSource,
} from './readback-benchmark'
import { createStagingRing } from './staging-ring'
import { probeTextureImport } from './texture-import-probe'

// Device-spike GPU chain against real (SwiftShader) WebGPU in true headless
// Chromium: copy-path import → luminance pass → staging-ring readback with
// known pixel content, a short benchmark loop, the texture-import probe, and
// device-loss observation.
//
// Measured SwiftShader quirk this file is ordered around: ANY WebGPU use of a
// VideoFrame (importExternalTexture or copyExternalImageToTexture, whether
// the frame was constructed from a canvas or from raw RGBA bytes) drops the
// whole WebGPU instance ("Instance dropped" / "A valid external Instance
// reference no longer exists"), after which requestAdapter() flakily returns
// null for the rest of the page. Canvas and ImageBitmap copy sources are
// stable. So: deterministic correctness tests use a canvas source, and the
// VideoFrame paths run LAST against a pre-acquired device, asserting only
// that a clean result is recorded either way — real devices on /diag give
// the real answer.

async function getDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter()
  expect(adapter, 'requestAdapter() should return an adapter').toBeTruthy()
  return adapter!.requestDevice()
}

const GRAY = 128
const GRAY_LUMINANCE = GRAY / 255

function grayCanvas(width = 64, height = 48): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')!
  context.fillStyle = `rgb(${GRAY}, ${GRAY}, ${GRAY})`
  context.fillRect(0, 0, width, height)
  return canvas
}

function canvasSource(canvas: OffscreenCanvas): SpikeSource {
  return { nextFrame: () => canvas }
}

function videoFrameSource(create: () => VideoFrame): SpikeSource {
  return {
    nextFrame: create,
    releaseFrame: (frame) => (frame as VideoFrame).close(),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Drives the harness with synthetic macrotask-separated ticks (so map
// callbacks can land between frames), waits for in-flight readbacks to drain,
// and returns the final snapshot. Test-only: the /diag panel feeds the harness
// real FrameLoop samples instead.
async function runReadbackBenchmark(
  device: GPUDevice,
  source: SpikeSource,
  options: { path: ImportPath; frames: number; driftWindowSize?: number; drainTimeoutMs?: number },
): Promise<ReadbackSnapshot> {
  const harness = new ReadbackHarness(device, source, {
    path: options.path,
    driftWindowSize: options.driftWindowSize,
  })
  try {
    for (let i = 0; i < options.frames; i++) {
      harness.onFrame({ now: performance.now() })
      await delay(0)
    }
    const drainDeadline = performance.now() + (options.drainTimeoutMs ?? 5000)
    while (!harness.drained && performance.now() < drainDeadline) {
      await delay(10)
    }
    return harness.snapshot()
  } finally {
    harness.destroy()
  }
}

describe('luminance pass + staging-ring readback', () => {
  it('computes the exact ROI mean from known texture bytes', async () => {
    const device = await getDevice()

    // 4×4 texture: zero everywhere except the centre 2×2 ROI, which holds
    // grays 64, 128, 192, 255. A wrong ROI drags the mean toward zero.
    const roiGrays = [64, 128, 192, 255]
    const texels = new Uint8Array(4 * 4 * 4)
    const roiPixels = [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ]
    roiPixels.forEach(([x, y], i) => {
      const offset = (y * 4 + x) * 4
      texels[offset] = texels[offset + 1] = texels[offset + 2] = roiGrays[i]
      texels[offset + 3] = 255
    })
    const texture = device.createTexture({
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    })
    device.queue.writeTexture({ texture }, texels, { bytesPerRow: 16 }, { width: 4, height: 4 })

    const pass = new LuminancePass(device, { x: 1, y: 1, width: 2, height: 2 })
    const ring = createStagingRing(device)
    const slot = ring.acquire()!
    const encoder = device.createCommandEncoder()
    pass.encodeTexture2d(encoder, texture)
    encoder.copyBufferToBuffer(pass.resultBuffer, 0, slot.buffer, 0, 4)
    device.queue.submit([encoder.finish()])

    const value = await ring.readValue(slot)
    const expected = (64 + 128 + 192 + 255) / 4 / 255
    expect(value).toBeCloseTo(expected, 3)

    pass.destroy()
    ring.destroy()
    texture.destroy()
    device.destroy()
  })

  it('runs a short copy-path benchmark from a canvas source with sane stats', async () => {
    const device = await getDevice()
    const source = canvasSource(grayCanvas())

    const snapshot = await runReadbackBenchmark(device, source, {
      path: 'copy',
      frames: 30,
      driftWindowSize: 5,
    })

    expect(snapshot.path).toBe('copy')
    expect(snapshot.ticks).toBe(30)
    expect(snapshot.errors, snapshot.lastError ?? '').toBe(0)
    expect(snapshot.completed).toBeGreaterThan(0)
    expect(snapshot.completed + snapshot.overruns + snapshot.skippedNoFrame).toBe(30)
    expect(snapshot.lastValue).toBeCloseTo(GRAY_LUMINANCE, 2)
    expect(snapshot.overall).toBeDefined()
    expect(snapshot.overall!.count).toBe(snapshot.completed)
    expect(snapshot.overall!.medianMs).toBeGreaterThanOrEqual(0)
    expect(snapshot.overall!.maxMs).toBeGreaterThanOrEqual(snapshot.overall!.p95Ms)
    expect(snapshot.completedPerSecond).toBeGreaterThan(0)
    expect(snapshot.rollingTicksPerSecond).toBeGreaterThan(0)
    if (snapshot.completed >= 10) {
      expect(snapshot.drift).toBeDefined()
      expect(typeof snapshot.drift!.upwardDrift).toBe('boolean')
    }
    // The /diag panel polls snapshots over a serialization-shaped boundary.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)

    device.destroy()
  })
})

describe('device-loss observer', () => {
  it('reports a destroyed-device loss from a real device.lost', async () => {
    const device = await getDevice()
    const events: DeviceLossEvent[] = []
    observeDeviceLoss(device, (event) => events.push(event), { now: () => 42 })
    expect(events).toEqual([])

    device.destroy()
    await device.lost

    expect(events).toEqual([{ at: 42, reason: 'destroyed', message: expect.any(String) }])
  })
})

// LAST on purpose: these can drop the SwiftShader WebGPU instance (see file
// header). One device is acquired up front and shared, so no assertion
// depends on requestAdapter() surviving the crash.
describe('VideoFrame import paths (may be unsupported under SwiftShader)', () => {
  it('probe and external benchmark record a result per path, supported or clean failure', async () => {
    const device = await getDevice()
    const canvas = grayCanvas()
    let timestamp = 0
    const createVideoFrame = () => new VideoFrame(canvas, { timestamp: timestamp++ })

    const report = await probeTextureImport(device, { createVideoFrame }, { framesPerPath: 5 })

    expect(report.timingNote).toBeTruthy()
    expect(report.results).toHaveLength(4)
    const byKey = (path: string, source: string) =>
      report.results.find((result) => result.path === path && result.source === source)!

    for (const path of ['importExternalTexture', 'copyExternalImageToTexture'] as const) {
      expect(byKey(path, 'video-element')).toMatchObject({
        attempted: false,
        ok: false,
        error: 'no video element provided',
      })

      const frameResult = byKey(path, 'video-frame')
      expect(frameResult.attempted).toBe(true)
      if (frameResult.ok) {
        expect(frameResult.framesMeasured).toBe(5)
        expect(frameResult.medianImportCostUs).toBeGreaterThanOrEqual(0)
        expect(frameResult.p95ImportCostUs).toBeGreaterThanOrEqual(frameResult.medianImportCostUs!)
      } else {
        expect(frameResult.error).toBeTruthy()
      }
      console.log(
        `${path} from VideoFrame on this adapter: ` +
          (frameResult.ok
            ? `ok, median ${frameResult.medianImportCostUs!.toFixed(1)} µs`
            : `failed: ${frameResult.error}`),
      )
    }
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)

    const snapshot = await runReadbackBenchmark(device, videoFrameSource(createVideoFrame), {
      path: 'external',
      frames: 10,
      driftWindowSize: 2,
      drainTimeoutMs: 2000,
    })
    expect(snapshot.ticks).toBe(10)
    if (snapshot.completed > 0) {
      expect(snapshot.lastValue).toBeCloseTo(GRAY_LUMINANCE, 2)
    } else {
      expect(snapshot.errors).toBeGreaterThan(0)
      expect(snapshot.lastError).toBeTruthy()
    }
    console.log(
      `external-path benchmark on this adapter: completed=${snapshot.completed} ` +
        `errors=${snapshot.errors} lastError=${snapshot.lastError ?? 'none'}`,
    )

    device.destroy()
  })
})
