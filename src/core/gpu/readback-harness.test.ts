import { describe, expect, it, vi } from 'vitest'
import type { SpikeFrame } from './frame-import'
import { ReadbackHarness, type SpikeSource } from './readback-benchmark'

// The harness's node-test seam is the GPUDevice itself: a fake device whose
// staging-buffer maps settle on command drives the submit/complete/error/
// overrun accounting deterministically without WebGPU. Only the external
// path is exercised so no GPUTextureUsage global is needed.

vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 })

interface PendingMap {
  resolve(): void
  reject(error: Error): void
}

function fakeGpuDevice(): { device: GPUDevice; pendingMaps: PendingMap[] } {
  const pendingMaps: PendingMap[] = []
  const encoder = {
    beginComputePass: () => ({
      setPipeline() {},
      setBindGroup() {},
      dispatchWorkgroups() {},
      end() {},
    }),
    copyBufferToBuffer() {},
    finish: () => ({}),
  }
  const device = {
    createBuffer: () => ({
      mapAsync: () =>
        new Promise<void>((resolve, reject) => pendingMaps.push({ resolve, reject })),
      getMappedRange: () => Float32Array.of(0.5).buffer,
      unmap() {},
      destroy() {},
    }),
    createCommandEncoder: () => encoder,
    importExternalTexture: () => ({}),
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    queue: { submit() {}, writeBuffer() {} },
  }
  return { device: device as unknown as GPUDevice, pendingMaps }
}

// 'videoWidth' makes isExternalImportable true; plain width/height (a canvas
// shape) makes the external path throw during encode.
const importableFrame = { videoWidth: 4, videoHeight: 4 } as unknown as SpikeFrame
const nonImportableFrame = { width: 4, height: 4 } as unknown as SpikeFrame

function trackingSource(frames: SpikeFrame[]): SpikeSource & { released: SpikeFrame[] } {
  let index = 0
  const released: SpikeFrame[] = []
  return {
    released,
    nextFrame: () => frames[index++],
    releaseFrame: (frame) => released.push(frame),
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('ReadbackHarness accounting', () => {
  it('an encode error does not mark the harness drained while a readback is pending', async () => {
    const { device, pendingMaps } = fakeGpuDevice()
    const source = trackingSource([importableFrame, nonImportableFrame])
    const harness = new ReadbackHarness(device, source, { path: 'external' })

    harness.onFrame({ now: 0 })
    expect(harness.snapshot().submitted).toBe(1)
    expect(harness.drained).toBe(false)

    harness.onFrame({ now: 16 })
    const snapshot = harness.snapshot()
    expect(snapshot.errors).toBe(1)
    expect(snapshot.submitted).toBe(1)
    expect(snapshot.completed).toBe(0)
    expect(harness.drained).toBe(false)

    pendingMaps.splice(0).forEach((map) => map.resolve())
    await flushMicrotasks()
    expect(harness.drained).toBe(true)
    const final = harness.snapshot()
    expect(final.completed).toBe(1)
    expect(final.lastValue).toBeCloseTo(0.5, 6)
    harness.destroy()
  })

  it('encode errors release the frame and the ring slot', () => {
    const { device } = fakeGpuDevice()
    const frames = [nonImportableFrame, nonImportableFrame, nonImportableFrame, importableFrame]
    const source = trackingSource(frames)
    const harness = new ReadbackHarness(device, source, { path: 'external' })

    // Three encode errors in a row: if any slot leaked, the ring (depth 3)
    // could not take the following successful submit without an overrun.
    for (const now of [0, 16, 32]) harness.onFrame({ now })
    let snapshot = harness.snapshot()
    expect(snapshot.errors).toBe(3)
    expect(snapshot.submitted).toBe(0)
    expect(source.released).toEqual(frames.slice(0, 3))
    expect(harness.drained).toBe(true)

    harness.onFrame({ now: 48 })
    snapshot = harness.snapshot()
    expect(snapshot.submitted).toBe(1)
    expect(snapshot.overruns).toBe(0)
    expect(source.released).toEqual(frames)
    harness.destroy()
  })

  it('an overrun releases the frame and counts neither an error nor a submit', async () => {
    const { device, pendingMaps } = fakeGpuDevice()
    const frames = [importableFrame, importableFrame, importableFrame, importableFrame]
    const source = trackingSource(frames)
    const harness = new ReadbackHarness(device, source, { path: 'external' })

    for (const now of [0, 16, 32, 48]) harness.onFrame({ now })
    const snapshot = harness.snapshot()
    expect(snapshot.submitted).toBe(3)
    expect(snapshot.overruns).toBe(1)
    expect(snapshot.errors).toBe(0)
    expect(snapshot.skippedNoFrame).toBe(0)
    expect(source.released).toHaveLength(4)
    expect(harness.drained).toBe(false)

    pendingMaps.splice(0).forEach((map) => map.resolve())
    await flushMicrotasks()
    expect(harness.drained).toBe(true)
    expect(harness.snapshot().completed).toBe(3)
    harness.destroy()
  })

  it('a rejected readback counts as an error and toward drained', async () => {
    const { device, pendingMaps } = fakeGpuDevice()
    const harness = new ReadbackHarness(device, trackingSource([importableFrame]), {
      path: 'external',
    })

    harness.onFrame({ now: 0 })
    expect(harness.drained).toBe(false)

    pendingMaps.splice(0).forEach((map) => map.reject(new Error('device lost')))
    await flushMicrotasks()
    expect(harness.drained).toBe(true)
    const snapshot = harness.snapshot()
    expect(snapshot.completed).toBe(0)
    expect(snapshot.errors).toBe(1)
    expect(snapshot.lastError).toBe('device lost')
    harness.destroy()
  })
})

describe('ReadbackHarness tick decimation', () => {
  it('processes every Nth tick and leaves skipped ticks out of every counter', async () => {
    const { device, pendingMaps } = fakeGpuDevice()
    const frames = [importableFrame, importableFrame]
    const source = trackingSource(frames)
    const harness = new ReadbackHarness(device, source, { path: 'external', tickDecimation: 2 })

    for (const now of [0, 10, 20, 30]) harness.onFrame({ now })
    const snapshot = harness.snapshot()
    expect(snapshot.tickDecimation).toBe(2)
    expect(snapshot.ticks).toBe(2)
    expect(snapshot.submitted).toBe(2)
    expect(snapshot.overruns).toBe(0)
    expect(snapshot.skippedNoFrame).toBe(0)
    // Decimated ticks never pull a frame from the source.
    expect(source.released).toHaveLength(2)
    // Rolling rate reflects the PROCESSED rate: ticks at now 0 and 20.
    expect(snapshot.rollingTicksPerSecond).toBeCloseTo(50, 6)

    pendingMaps.splice(0).forEach((map) => map.resolve())
    await flushMicrotasks()
    expect(harness.drained).toBe(true)
    expect(harness.snapshot().completed).toBe(2)
    harness.destroy()
  })

  it('defaults to processing every tick with tickDecimation 1 in the snapshot', () => {
    const harness = new ReadbackHarness(fakeGpuDevice().device, trackingSource([]), {
      path: 'external',
    })
    for (const now of [0, 10, 20]) harness.onFrame({ now })
    const snapshot = harness.snapshot()
    expect(snapshot.tickDecimation).toBe(1)
    expect(snapshot.ticks).toBe(3)
    harness.destroy()
  })
})

describe('ReadbackHarness rolling tick rate', () => {
  const noFrameSource: SpikeSource = { nextFrame: () => undefined }

  it('is undefined until two ticks have a positive time span', () => {
    const harness = new ReadbackHarness(fakeGpuDevice().device, noFrameSource, {
      path: 'external',
    })
    expect(harness.snapshot().rollingTicksPerSecond).toBeUndefined()
    harness.onFrame({ now: 5 })
    expect(harness.snapshot().rollingTicksPerSecond).toBeUndefined()
    harness.onFrame({ now: 15 })
    expect(harness.snapshot().rollingTicksPerSecond).toBeCloseTo(100, 6)
    harness.destroy()
  })

  it('reflects only the recent tick window, not the whole run', () => {
    const harness = new ReadbackHarness(fakeGpuDevice().device, noFrameSource, {
      path: 'external',
    })
    // 20 slow ticks (100 ms apart) then 180 fast ticks (10 ms apart): the
    // 180-tick window holds only the fast ticks, so a slow start must not
    // drag down the current rate — nor could a mid-run thermal drop hide
    // behind a fast start.
    let now = 0
    for (let i = 0; i < 20; i++) {
      harness.onFrame({ now })
      now += 100
    }
    for (let i = 0; i < 180; i++) {
      harness.onFrame({ now })
      now += 10
    }
    expect(harness.snapshot().rollingTicksPerSecond).toBeCloseTo(100, 6)
    harness.destroy()
  })
})
