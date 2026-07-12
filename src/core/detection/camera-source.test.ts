import { describe, expect, it, vi } from 'vitest'
import type { LumaFrame } from './types'
import {
  alignRoiToCropRect,
  CameraSource,
  subsampleLuma,
  subsamplePackedToLuma,
  TARGET_PIXELS,
  type CameraSourceOptions,
  type FrameReaderLike,
  type PixelRect,
  type VideoFrameLike,
} from './camera-source'

describe('subsampleLuma', () => {
  it('stride-subsamples with row padding and offset', () => {
    // 4×2 region, stride 6 (2 bytes padding per row), offset 1, target width 2
    // → step 2: samples (0,0),(2,0).
    const src = new Uint8Array([
      0, 10, 11, 12, 13, 0, // row 0 at offset 1: [10,11,12,13]
      0, 20, 21, 22, 23, 0,
    ])
    const { data, width, height } = subsampleLuma(src, 1, 6, 4, 2, 2)
    expect({ width, height }).toEqual({ width: 2, height: 1 })
    expect([...data]).toEqual([10, 12])
  })

  it('never upsamples: step is at least 1', () => {
    const src = new Uint8Array([1, 2, 3, 4])
    const { data, width, height } = subsampleLuma(src, 0, 2, 2, 2, 256)
    expect({ width, height }).toEqual({ width: 2, height: 2 })
    expect([...data]).toEqual([1, 2, 3, 4])
  })

  it('clamps the step so a flat wide region still yields one row', () => {
    // 8×1 with target width 2 would step 4 → height 0 without the clamp.
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const { data, width, height } = subsampleLuma(src, 0, 8, 8, 1, 2)
    expect(height).toBe(1)
    expect(width).toBe(8)
    expect(data.length).toBe(8)
  })

  it('bounds a narrow-tall ROI by the pixel budget, not just the target width', () => {
    // 300×700 with targetWidth 256: the width-derived step is 1 (210 000 px,
    // ~6× the budget); the budget forces step 3 → 100×233 = 23 300 px.
    const src = new Uint8Array(300 * 700)
    const { data, width, height } = subsampleLuma(src, 0, 300, 300, 700, 256)
    expect(width * height).toBeLessThanOrEqual(TARGET_PIXELS)
    expect({ width, height }).toEqual({ width: 100, height: 233 })
    expect(data.length).toBe(width * height)
  })

  it('keeps a crop already inside the budget at full resolution', () => {
    const src = new Uint8Array(256 * 144)
    const { width, height } = subsampleLuma(src, 0, 256, 256, 144, 256)
    expect({ width, height }).toEqual({ width: 256, height: 144 })
  })
})

describe('subsamplePackedToLuma', () => {
  it('converts RGBA and BGRA with the right channel order', () => {
    // One red pixel (255,0,0). Rec. 709 r-weight 0.2126 → 54 truncated.
    const rgba = new Uint8Array([255, 0, 0, 255])
    const bgra = new Uint8Array([0, 0, 255, 255])
    const fromRgba = subsamplePackedToLuma(rgba, 0, 4, 1, 1, 1, 0, 2)
    const fromBgra = subsamplePackedToLuma(bgra, 0, 4, 1, 1, 1, 2, 0)
    expect([...fromRgba.data]).toEqual([54])
    expect([...fromBgra.data]).toEqual([54])
  })

  it('honors offset into a larger buffer', () => {
    // Second pixel of a 2×1 row: green (255) → 0.7152 × 255 = 182 truncated.
    const src = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255])
    const { data } = subsamplePackedToLuma(src, 4, 8, 1, 1, 1, 0, 2)
    expect([...data]).toEqual([182])
  })
})

describe('alignRoiToCropRect', () => {
  it('rounds odd pixel edges outward to even values', () => {
    // 0.3–0.7 of 10 px → 3..7 → outward-even 2..8.
    const rect = alignRoiToCropRect({ x: 0.3, y: 0.3, width: 0.4, height: 0.4 }, 10, 10)
    expect(rect).toEqual({ x: 2, y: 2, width: 6, height: 6 })
  })

  it('maps the full-frame ROI to the coded size', () => {
    const rect = alignRoiToCropRect({ x: 0, y: 0, width: 1, height: 1 }, 640, 480)
    expect(rect).toEqual({ x: 0, y: 0, width: 640, height: 480 })
  })

  it('clamps out-of-range ROIs to the frame', () => {
    const rect = alignRoiToCropRect({ x: -0.5, y: 0.5, width: 2, height: 2 }, 16, 8)
    expect(rect).toEqual({ x: 0, y: 4, width: 16, height: 4 })
  })

  it('never yields a rect smaller than 2×2', () => {
    const zero = alignRoiToCropRect({ x: 0.5, y: 0.5, width: 0, height: 0 }, 16, 8)
    expect(zero).toEqual({ x: 8, y: 4, width: 2, height: 2 })
    const atRightEdge = alignRoiToCropRect({ x: 1, y: 1, width: 0, height: 0 }, 16, 8)
    expect(atRightEdge).toEqual({ x: 14, y: 6, width: 2, height: 2 })
  })
})

interface FakeFrameEvents {
  closed: number[]
  rectCopyAttempts: number
}

interface FakeNv12Options {
  index?: number
  width?: number
  height?: number
  timestamp?: number | null
  lumaAt?: (x: number, y: number) => number
  // Extra bytes per Y row in the copied layout, exercising stride handling.
  rowPadding?: number
  rejectRectCopy?: boolean
}

// Fake NV12 VideoFrame implementing copyTo rect semantics against a
// lumaAt(x, y) master plane. Rejects odd-aligned or out-of-bounds rects the
// way a real NV12 frame would, so integration tests prove the source only
// ever requests aligned rects.
function makeNv12Frame(events: FakeFrameEvents, options: FakeNv12Options = {}): VideoFrameLike {
  const {
    index = 0,
    width = 16,
    height = 8,
    timestamp = index * 16_667,
    lumaAt = (x, y) => y * 16 + x,
    rowPadding = 0,
    rejectRectCopy = false,
  } = options
  const layoutFor = (rect: PixelRect) => {
    const stride = rect.width + rowPadding
    const ySize = stride * rect.height
    return { stride, ySize, total: ySize + ySize / 2 }
  }
  const resolveRect = (rect?: PixelRect) => rect ?? { x: 0, y: 0, width, height }
  return {
    format: 'NV12',
    codedWidth: width,
    codedHeight: height,
    timestamp,
    allocationSize: (copyOptions) => layoutFor(resolveRect(copyOptions?.rect)).total,
    copyTo: (dest, copyOptions) => {
      if (copyOptions?.rect) {
        events.rectCopyAttempts++
        if (rejectRectCopy) return Promise.reject(new Error('rect copy unsupported'))
        const r = copyOptions.rect
        if (r.x % 2 || r.y % 2 || r.width % 2 || r.height % 2) {
          return Promise.reject(new Error(`NV12 rect must be even-aligned: ${JSON.stringify(r)}`))
        }
        if (r.x < 0 || r.y < 0 || r.x + r.width > width || r.y + r.height > height) {
          return Promise.reject(new Error(`rect out of bounds: ${JSON.stringify(r)}`))
        }
      }
      const rect = resolveRect(copyOptions?.rect)
      const { stride, ySize } = layoutFor(rect)
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
          dest[y * stride + x] = lumaAt(rect.x + x, rect.y + y)
        }
      }
      dest.fill(128, ySize, ySize + ySize / 2)
      return Promise.resolve([
        { offset: 0, stride },
        { offset: ySize, stride },
      ])
    },
    close: () => {
      events.closed.push(index)
    },
  }
}

function makeRgbaFrame(
  events: FakeFrameEvents,
  options: { width?: number; height?: number; pixel?: [number, number, number] } = {},
): VideoFrameLike {
  const { width = 2, height = 2, pixel = [255, 0, 0] } = options
  return {
    format: 'RGBA',
    codedWidth: width,
    codedHeight: height,
    timestamp: 0,
    allocationSize: (copyOptions) => (copyOptions?.rect ?? { width, height }).width * 4 * (copyOptions?.rect ?? { width, height }).height,
    copyTo: (dest, copyOptions) => {
      if (copyOptions?.rect) events.rectCopyAttempts++
      const rect = copyOptions?.rect ?? { x: 0, y: 0, width, height }
      const rectStride = rect.width * 4
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
          dest.set([...pixel, 255], y * rectStride + x * 4)
        }
      }
      return Promise.resolve([{ offset: 0, stride: rectStride }])
    },
    close: () => {
      events.closed.push(0)
    },
  }
}

// Reader delivering scripted frames, then pending forever like a live camera
// between frames.
function makeReader(frames: VideoFrameLike[]) {
  let next = 0
  let cancelled = false
  const reader: FrameReaderLike = {
    read: () => {
      if (cancelled) return Promise.resolve({ done: true })
      if (next < frames.length) return Promise.resolve({ done: false, value: frames[next++] })
      return new Promise(() => {})
    },
    cancel: () => {
      cancelled = true
    },
  }
  return { reader, isCancelled: () => cancelled }
}

function makeSource(frames: VideoFrameLike[], options: Omit<CameraSourceOptions, 'createTrackProcessor'> = {}) {
  const { reader, isCancelled } = makeReader(frames)
  const emitted: LumaFrame[] = []
  const source = new CameraSource({} as MediaStreamTrack, {
    createTrackProcessor: () => ({ readable: { getReader: () => reader } }),
    ...options,
  })
  return { source, emitted, isCancelled }
}

const waitUntil = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true))

describe('CameraSource', () => {
  it('crops the ROI via a rect copy, subsamples the Y plane, and stamps capture time', async () => {
    const events: FakeFrameEvents = { closed: [], rectCopyAttempts: 0 }
    // 16×8 frame with luma = y·16 + x; ROI quarter-inset → rect {4,2,8,4};
    // targetWidth 4 → step 2 → 4×2 samples at x ∈ {4,6,8,10}, y ∈ {2,4}.
    const frames = [makeNv12Frame(events, { rowPadding: 4, timestamp: 33_333 })]
    const { source, emitted } = makeSource(frames, {
      roi: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      targetWidth: 4,
    })
    source.start((frame) => emitted.push(frame))
    await waitUntil(() => emitted.length === 1)

    expect(emitted[0].width).toBe(4)
    expect(emitted[0].height).toBe(2)
    expect([...emitted[0].data]).toEqual([36, 38, 40, 42, 68, 70, 72, 74])
    expect(emitted[0].captureTimeMs).toBeCloseTo(33.333, 6)

    const stats = source.stats()
    expect(stats).toMatchObject({
      frames: 1,
      emitted: 1,
      errors: 0,
      format: 'NV12',
      codedWidth: 16,
      codedHeight: 8,
      cropRect: { x: 4, y: 2, width: 8, height: 4 },
      usedRectCopy: true,
    })
    expect(events.rectCopyAttempts).toBe(1)
    expect(events.closed).toEqual([0])
    source.stop()
  })

  it('rounds an odd ROI outward to an even rect the fake NV12 frame accepts', async () => {
    const events: FakeFrameEvents = { closed: [], rectCopyAttempts: 0 }
    const frames = [makeNv12Frame(events)]
    // 0.2–0.75 of 16 px → 3.2..12 → 2..12; 0.2–0.75 of 8 px → 1.6..6 → 0..6.
    const { source, emitted } = makeSource(frames, {
      roi: { x: 0.2, y: 0.2, width: 0.55, height: 0.55 },
      targetWidth: 16,
    })
    source.start((frame) => emitted.push(frame))
    await waitUntil(() => emitted.length === 1)

    expect(source.stats().errors).toBe(0)
    expect(source.stats().cropRect).toEqual({ x: 2, y: 0, width: 10, height: 6 })
    expect(emitted[0].width).toBe(10)
    expect(emitted[0].height).toBe(6)
    expect(emitted[0].data[0]).toBe(2) // luma at (2, 0)
    source.stop()
  })

  it('setRoi takes effect on the next frame', async () => {
    const events: FakeFrameEvents = { closed: [], rectCopyAttempts: 0 }
    const frames = [makeNv12Frame(events, { index: 0 }), makeNv12Frame(events, { index: 1 })]
    const { source, emitted } = makeSource(frames, { targetWidth: 16 })
    source.start((frame) => {
      emitted.push(frame)
      if (emitted.length === 1) {
        source.setRoi({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })
      }
    })
    await waitUntil(() => emitted.length === 2)

    expect({ width: emitted[0].width, height: emitted[0].height }).toEqual({ width: 16, height: 8 })
    expect({ width: emitted[1].width, height: emitted[1].height }).toEqual({ width: 8, height: 4 })
    expect(emitted[1].data[0]).toBe(2 * 16 + 4) // luma at (4, 2)
    expect(source.stats().cropRect).toEqual({ x: 4, y: 2, width: 8, height: 4 })
    source.stop()
  })

  it('falls back to full-frame copy + crop-in-subsample when rect copy throws, once', async () => {
    const events: FakeFrameEvents = { closed: [], rectCopyAttempts: 0 }
    const frames = [
      makeNv12Frame(events, { index: 0, rejectRectCopy: true, rowPadding: 4 }),
      makeNv12Frame(events, { index: 1, rejectRectCopy: true, rowPadding: 4 }),
    ]
    const { source, emitted } = makeSource(frames, {
      roi: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      targetWidth: 4,
    })
    source.start((frame) => emitted.push(frame))
    await waitUntil(() => emitted.length === 2)

    // Same output as the rect-copy path: the crop happened during subsampling.
    expect([...emitted[0].data]).toEqual([36, 38, 40, 42, 68, 70, 72, 74])
    expect([...emitted[1].data]).toEqual([36, 38, 40, 42, 68, 70, 72, 74])
    const stats = source.stats()
    expect(stats.usedRectCopy).toBe(false)
    expect(stats.errors).toBe(0)
    expect(stats.emitted).toBe(2)
    expect(stats.cropRect).toEqual({ x: 4, y: 2, width: 8, height: 4 })
    // The failing frame retried with a full copy; later frames never re-try.
    expect(events.rectCopyAttempts).toBe(1)
    source.stop()
  })

  it('converts packed RGBA to luma during subsampling', async () => {
    const events: FakeFrameEvents = { closed: [], rectCopyAttempts: 0 }
    const { source, emitted } = makeSource([makeRgbaFrame(events)], { targetWidth: 2 })
    source.start((frame) => emitted.push(frame))
    await waitUntil(() => emitted.length === 1)

    expect({ width: emitted[0].width, height: emitted[0].height }).toEqual({ width: 2, height: 2 })
    expect([...emitted[0].data]).toEqual([54, 54, 54, 54])
    expect(source.stats().format).toBe('RGBA')
    source.stop()
  })

  it('stop() cancels the reader; every delivered frame is closed', async () => {
    const events: FakeFrameEvents = { closed: [], rectCopyAttempts: 0 }
    const { source, emitted, isCancelled } = makeSource([makeNv12Frame(events)])
    source.start((frame) => emitted.push(frame))
    await waitUntil(() => emitted.length === 1)
    source.stop()

    expect(isCancelled()).toBe(true)
    expect(events.closed).toEqual([0])
  })

  it('skips a null-timestamp frame as an error instead of inventing a time', async () => {
    const events: FakeFrameEvents = { closed: [], rectCopyAttempts: 0 }
    const frames = [
      makeNv12Frame(events, { index: 0, timestamp: null }),
      makeNv12Frame(events, { index: 1, timestamp: 16_667 }),
    ]
    const { source, emitted } = makeSource(frames)
    source.start((frame) => emitted.push(frame))
    await waitUntil(() => emitted.length === 1)

    const stats = source.stats()
    expect(stats.frames).toBe(2)
    expect(stats.emitted).toBe(1)
    expect(stats.errors).toBe(1)
    expect(stats.lastError).toContain('timestamp')
    expect(emitted[0].captureTimeMs).toBeCloseTo(16.667, 3)
    expect(events.closed).toEqual([0, 1])
    source.stop()
  })

  it('counts an unsupported format as an error and still closes the frame', async () => {
    const events: FakeFrameEvents = { closed: [], rectCopyAttempts: 0 }
    const frame = { ...makeNv12Frame(events), format: 'P010' }
    const { source } = makeSource([frame])
    source.start(() => {})
    await waitUntil(() => source.stats().errors === 1)

    expect(source.stats().lastError).toContain('unsupported VideoFrame format: P010')
    expect(source.stats().emitted).toBe(0)
    expect(events.closed).toEqual([0])
    source.stop()
  })

  it('emits consumer-owned frames: consecutive data arrays are distinct', async () => {
    const events: FakeFrameEvents = { closed: [], rectCopyAttempts: 0 }
    const frames = [makeNv12Frame(events, { index: 0 }), makeNv12Frame(events, { index: 1 })]
    const { source, emitted } = makeSource(frames)
    source.start((frame) => emitted.push(frame))
    await waitUntil(() => emitted.length === 2)

    expect(emitted[0].data).not.toBe(emitted[1].data)
    expect([...emitted[0].data]).toEqual([...emitted[1].data])
    emitted[0].data[0] = 255
    expect(emitted[1].data[0]).not.toBe(255)
    source.stop()
  })

  it('a read() rejection ends capture instead of busy-looping on the errored reader', async () => {
    let reads = 0
    const reader: FrameReaderLike = {
      read: () => {
        reads++
        return Promise.reject(new Error('track ended abruptly'))
      },
      cancel: () => {},
    }
    const source = new CameraSource({} as MediaStreamTrack, {
      createTrackProcessor: () => ({ readable: { getReader: () => reader } }),
    })
    source.start(() => {})
    await waitUntil(() => source.stats().errors === 1)
    // An errored ReadableStream rejects every read() immediately; the pump
    // must have exited after the first one instead of spinning microtasks.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(reads).toBe(1)
    expect(source.stats().errors).toBe(1)
    expect(source.stats().lastError).toBe('track ended abruptly')
    expect(source.stats().emitted).toBe(0)
    source.stop()
    expect(reads).toBe(1)
  })

  it('is single-use: start twice throws, restart after stop throws', async () => {
    const events: FakeFrameEvents = { closed: [], rectCopyAttempts: 0 }
    const { source, emitted } = makeSource([makeNv12Frame(events)])
    source.start((frame) => emitted.push(frame))
    expect(() => source.start(() => {})).toThrow('already started')
    await waitUntil(() => emitted.length === 1)
    source.stop()
    expect(() => source.start(() => {})).toThrow('cannot restart')
  })
})
