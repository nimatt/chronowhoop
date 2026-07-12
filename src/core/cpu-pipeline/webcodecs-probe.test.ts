import { describe, expect, it, vi } from 'vitest'
import {
  subsamplePacked,
  subsamplePlane,
  WebCodecsPipelineProbe,
  type FrameReaderLike,
  type VideoFrameCaptureLike,
} from './webcodecs-probe'

describe('subsamplePlane', () => {
  it('stride-subsamples with row padding and offset', () => {
    // 4×2 plane, stride 6 (2 bytes padding per row), offset 1, target width 2
    // → step 2: samples (0,0),(2,0),(0,1),(2,1).
    const src = new Uint8Array([
      0, 10, 11, 12, 13, 0, // row 0 at offset 1: [10,11,12,13]
      0, 20, 21, 22, 23, 0,
    ])
    const out = new Uint8Array(4)
    const dims = subsamplePlane(src, 1, 6, 4, 2, 2, out)
    expect(dims).toEqual({ width: 2, height: 1 })
    expect([...out.subarray(0, 2)]).toEqual([10, 12])
  })

  it('never upsamples: step is at least 1', () => {
    const src = new Uint8Array([1, 2, 3, 4])
    const out = new Uint8Array(4)
    const dims = subsamplePlane(src, 0, 2, 2, 2, 256, out)
    expect(dims).toEqual({ width: 2, height: 2 })
    expect([...out]).toEqual([1, 2, 3, 4])
  })
})

describe('subsamplePacked', () => {
  it('converts RGBA and BGRA with the right channel order', () => {
    // One red pixel (255,0,0). Rec. 709: r-weight 0.2126 → 54.2; b-weight 18.4.
    const rgba = new Uint8Array([255, 0, 0, 255])
    const bgra = new Uint8Array([0, 0, 255, 255]) // same red pixel, BGRA order
    const out = new Uint8Array(1)
    subsamplePacked(rgba, 4, 1, 1, 1, 0, 2, out)
    const fromRgba = out[0]
    subsamplePacked(bgra, 4, 1, 1, 1, 2, 0, out)
    expect(out[0]).toBe(fromRgba)
    // 0.2126 × 255 = 54.213, truncated by the Uint8Array store.
    expect(fromRgba).toBe(54)
  })
})

// Fake reader delivering scripted NV12 frames, then pending forever.
function makeFakeFrames(count: number, valueForFrame: (i: number) => number) {
  const closed: number[] = []
  let cancelled = false
  const width = 8
  const height = 4
  const frames: VideoFrameCaptureLike[] = Array.from({ length: count }, (_, i) => ({
    format: 'NV12',
    codedWidth: width,
    codedHeight: height,
    timestamp: i * 16_667,
    allocationSize: () => width * height + (width * height) / 2,
    copyTo: (dest: Uint8Array) => {
      dest.fill(valueForFrame(i), 0, width * height)
      return Promise.resolve([
        { offset: 0, stride: width },
        { offset: width * height, stride: width },
      ])
    },
    close: () => {
      closed.push(i)
    },
  }))
  let next = 0
  const reader: FrameReaderLike = {
    read: () => {
      if (cancelled) return Promise.resolve({ done: true })
      if (next < frames.length) return Promise.resolve({ done: false, value: frames[next++] })
      return new Promise(() => {}) // pending forever, like a live camera between frames
    },
    cancel: () => {
      cancelled = true
    },
  }
  return { reader, closed, isCancelled: () => cancelled }
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

const waitUntil = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true))

describe('WebCodecsPipelineProbe', () => {
  it('processes frames off the reader, closes every frame, and reports stages', async () => {
    const { reader, closed } = makeFakeFrames(3, (i) => (i === 0 ? 100 : 200))
    const energiesSeen: number[][] = []
    const probe = new WebCodecsPipelineProbe({} as MediaStreamTrack, {
      createTrackProcessor: () => ({ readable: { getReader: () => reader } }),
      clock: makeClock(1),
      targetWidth: 8,
      onFrame: (energies) => energiesSeen.push([...energies]),
    })
    probe.start()
    await waitUntil(() => probe.snapshot().processed === 3)
    const snapshot = probe.snapshot()

    expect(closed).toEqual([0, 1, 2])
    expect(snapshot.format).toBe('NV12')
    expect(snapshot.workingWidth).toBe(8)
    expect(snapshot.workingHeight).toBe(4)
    // Injected clock steps 1 ms per call: copy = 1 ms, reduce = 1 ms, total 2 ms.
    expect(snapshot.stages.copy?.medianMs).toBe(1)
    expect(snapshot.stages.reduce?.medianMs).toBe(1)
    expect(snapshot.stages.total?.medianMs).toBe(2)
    // Frame 0 seeds (all zero); frames 1–2: value jump of 100 → all 32 px hot.
    expect(energiesSeen[0].reduce((a, b) => a + b, 0)).toBe(0)
    expect(energiesSeen[1].reduce((a, b) => a + b, 0)).toBe(32)
    // 16.667 ms deltas from the frame timestamps, zero jitter.
    expect(snapshot.frameTimestamps.count).toBe(2)
    expect(snapshot.frameTimestamps.medianDeltaMs).toBeCloseTo(16.667, 3)
    expect(snapshot.frameTimestamps.jitterStddevMs).toBeCloseTo(0, 6)
    probe.stop()
  })

  it('stop() cancels the reader and the pump exits', async () => {
    const { reader, isCancelled } = makeFakeFrames(1, () => 100)
    const probe = new WebCodecsPipelineProbe({} as MediaStreamTrack, {
      createTrackProcessor: () => ({ readable: { getReader: () => reader } }),
      clock: makeClock(),
      targetWidth: 8,
    })
    probe.start()
    await waitUntil(() => probe.snapshot().processed === 1)
    probe.stop()
    expect(isCancelled()).toBe(true)
    expect(probe.snapshot().running).toBe(false)
  })

  it('an unsupported frame format counts an error and still closes the frame', async () => {
    const closed: number[] = []
    const frame: VideoFrameCaptureLike = {
      format: 'P010',
      codedWidth: 8,
      codedHeight: 4,
      timestamp: 0,
      allocationSize: () => 64,
      copyTo: () => Promise.resolve([{ offset: 0, stride: 8 }]),
      close: () => {
        closed.push(0)
      },
    }
    let delivered = false
    const reader: FrameReaderLike = {
      read: () => {
        if (delivered) return new Promise(() => {})
        delivered = true
        return Promise.resolve({ done: false, value: frame })
      },
      cancel: () => {},
    }
    const probe = new WebCodecsPipelineProbe({} as MediaStreamTrack, {
      createTrackProcessor: () => ({ readable: { getReader: () => reader } }),
      clock: makeClock(),
      targetWidth: 8,
    })
    probe.start()
    await waitUntil(() => probe.snapshot().errors === 1)
    const snapshot = probe.snapshot()
    expect(snapshot.lastError).toContain('unsupported VideoFrame format: P010')
    expect(snapshot.processed).toBe(0)
    expect(closed).toEqual([0])
    probe.stop()
  })
})
