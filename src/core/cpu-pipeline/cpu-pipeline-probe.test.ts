import { describe, expect, it } from 'vitest'
import { CpuPipelineProbe, type Canvas2dLike, type Context2dLike } from './cpu-pipeline-probe'

// Fake 2D canvas: drawImage is a no-op, getImageData returns a scripted gray
// frame so the reducer sees deterministic pixels. The injected clock advances
// a fixed step per call, giving exact per-stage timings (each stage = 1 ms).
function makeFakeCanvas(frameValue: () => number) {
  const calls: string[] = []
  const context: Context2dLike = {
    drawImage: () => {
      calls.push('draw')
    },
    getImageData: (_x, _y, w, h) => {
      calls.push('read')
      const data = new Uint8ClampedArray(w * h * 4)
      const v = frameValue()
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = v
        data[i * 4 + 1] = v
        data[i * 4 + 2] = v
        data[i * 4 + 3] = 255
      }
      return { data, width: w, height: h }
    },
  }
  const canvas: Canvas2dLike = {
    width: 0,
    height: 0,
    getContext: (_id, options) => {
      calls.push(`getContext(willReadFrequently=${options?.willReadFrequently})`)
      return context
    },
  }
  return { canvas, calls }
}

function makeClock(stepMs = 1) {
  let now = 0
  return {
    now: () => {
      now += stepMs
      return now
    },
  }
}

describe('CpuPipelineProbe', () => {
  it('skips ticks while the video has no dimensions', () => {
    const { canvas } = makeFakeCanvas(() => 100)
    const video = { videoWidth: 0, videoHeight: 0 }
    const probe = new CpuPipelineProbe(video, { createCanvas: () => canvas, clock: makeClock() })
    probe.onFrame({ now: 1 })
    const snapshot = probe.snapshot()
    expect(snapshot.skippedNoVideo).toBe(1)
    expect(snapshot.processed).toBe(0)
  })

  it('computes the working resolution from the target width and aspect ratio', () => {
    const { canvas } = makeFakeCanvas(() => 100)
    const video = { videoWidth: 1280, videoHeight: 720 }
    const probe = new CpuPipelineProbe(video, { createCanvas: () => canvas, clock: makeClock() })
    probe.onFrame({ now: 1 })
    expect(probe.workingSize).toEqual({ width: 256, height: 144 })
    expect(canvas.width).toBe(256)
    expect(canvas.height).toBe(144)
  })

  it('never upscales a source smaller than the target width', () => {
    const { canvas } = makeFakeCanvas(() => 100)
    const video = { videoWidth: 160, videoHeight: 120 }
    const probe = new CpuPipelineProbe(video, { createCanvas: () => canvas, clock: makeClock() })
    probe.onFrame({ now: 1 })
    expect(probe.workingSize).toEqual({ width: 160, height: 120 })
  })

  it('records per-stage timings from the injected clock', () => {
    const { canvas } = makeFakeCanvas(() => 100)
    const video = { videoWidth: 1280, videoHeight: 720 }
    const probe = new CpuPipelineProbe(video, { createCanvas: () => canvas, clock: makeClock(1) })
    probe.onFrame({ now: 1 })
    probe.onFrame({ now: 17 })
    const { stages } = probe.snapshot()
    // Clock steps 1 ms per read: each stage measures exactly 1 ms, total 3 ms.
    expect(stages.draw?.medianMs).toBe(1)
    expect(stages.read?.medianMs).toBe(1)
    expect(stages.reduce?.medianMs).toBe(1)
    expect(stages.total?.medianMs).toBe(3)
    expect(stages.total?.count).toBe(2)
  })

  it('re-seeds and counts a reset when the video dimensions change', () => {
    const { canvas } = makeFakeCanvas(() => 100)
    const video = { videoWidth: 1280, videoHeight: 720 }
    const probe = new CpuPipelineProbe(video, { createCanvas: () => canvas, clock: makeClock() })
    probe.onFrame({ now: 1 })
    video.videoWidth = 640
    video.videoHeight = 480
    probe.onFrame({ now: 17 })
    const snapshot = probe.snapshot()
    expect(snapshot.resets).toBe(2)
    expect(snapshot.workingWidth).toBe(256)
    expect(snapshot.workingHeight).toBe(192)
  })

  it('surfaces motion as strip energy after the seed frame', () => {
    let value = 100
    const { canvas } = makeFakeCanvas(() => value)
    const video = { videoWidth: 1280, videoHeight: 720 }
    const probe = new CpuPipelineProbe(video, { createCanvas: () => canvas, clock: makeClock() })
    probe.onFrame({ now: 1 }) // seeds at 100
    value = 200
    probe.onFrame({ now: 17 })
    const energies = probe.snapshot().lastEnergies
    expect(energies).toHaveLength(12)
    // Every pixel jumped by 100 > threshold 25: all 256×144 pixels are hot.
    expect(energies.reduce((a, b) => a + b, 0)).toBe(256 * 144)
  })

  it('passes the willReadFrequently hint through to getContext', () => {
    const { canvas, calls } = makeFakeCanvas(() => 100)
    void new CpuPipelineProbe(
      { videoWidth: 0, videoHeight: 0 },
      { createCanvas: () => canvas, clock: makeClock(), willReadFrequently: false },
    )
    expect(calls).toContain('getContext(willReadFrequently=false)')
  })

  it('counts errors without dying and reports the message', () => {
    const context: Context2dLike = {
      drawImage: () => {
        throw new Error('boom')
      },
      getImageData: () => {
        throw new Error('unreachable')
      },
    }
    const canvas: Canvas2dLike = { width: 0, height: 0, getContext: () => context }
    const probe = new CpuPipelineProbe(
      { videoWidth: 1280, videoHeight: 720 },
      { createCanvas: () => canvas, clock: makeClock() },
    )
    probe.onFrame({ now: 1 })
    probe.onFrame({ now: 17 })
    const snapshot = probe.snapshot()
    expect(snapshot.errors).toBe(2)
    expect(snapshot.lastError).toBe('boom')
    expect(snapshot.processed).toBe(0)
  })
})
