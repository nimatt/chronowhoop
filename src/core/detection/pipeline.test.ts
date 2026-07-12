import { describe, expect, it } from 'vitest'
import { DetectionPipeline } from './pipeline'
import { SyntheticSource } from './synthetic-source'
import type { SyntheticSourceOptions } from './synthetic-source'
import { EMA_TIME_CONSTANT_MS } from './types'
import type { DetectionTunables, FrameSample, LumaFrame } from './types'

// A blob flying left-to-right through an 8×2 frame in 4 strips: enters at
// frame 1, occupies exactly one 2-column strip per frame (4 pixels), exits
// after frame 4. Ground-truth crossing (center reaches midX 3.5) is frame 3.
const flyThroughOptions: SyntheticSourceOptions = {
  width: 8,
  height: 2,
  frameCount: 5,
  frameIntervalMs: 16.5,
  backgroundLevel: 20,
  blob: { widthPx: 2, intensity: 220, speedPxPerFrame: 2, direction: 1, startFrame: 0 },
}

function runPipeline(
  options: SyntheticSourceOptions,
  tunables: Partial<DetectionTunables> = {},
): { samples: FrameSample[]; pipeline: DetectionPipeline; source: SyntheticSource } {
  const source = new SyntheticSource(options)
  const pipeline = new DetectionPipeline(source, { stripCount: 4, threshold: 25, ...tunables })
  const samples: FrameSample[] = []
  pipeline.start((s) => samples.push(s))
  source.pumpAll()
  return { samples, pipeline, source }
}

describe('DetectionPipeline', () => {
  it('reduces a synthetic fly-through to the exact expected strip-count sequence', () => {
    const { samples, source } = runPipeline(flyThroughOptions)
    expect(samples).toHaveLength(5)
    // Frame 0 seeds. Frames 1–4: the 4-pixel blob lights one strip per frame;
    // the strip it just left stays quiet (one EMA step moved the background
    // only ~10 of the 200-unit gap, well under the 25 threshold — but the
    // blob's own diff of 200 is far above it).
    expect(samples.map((s) => [...s.energies])).toEqual([
      [0, 0, 0, 0],
      [4, 0, 0, 0],
      [0, 4, 0, 0],
      [0, 0, 4, 0],
      [0, 0, 0, 4],
    ])
    for (const sample of samples) {
      expect([...sample.stripPixelCounts]).toEqual([4, 4, 4, 4])
    }
    expect(samples.map((s) => s.captureTimeMs)).toEqual([0, 16.5, 33, 49.5, 66])
    // The ground-truth crossing frame peaks in a gate-center strip.
    const crossing = source.groundTruth!
    expect(crossing.crossingFrameIndex).toBe(3)
    const crossingSample = samples[crossing.crossingFrameIndex]
    expect(crossingSample.captureTimeMs).toBe(crossing.crossingTimeMs)
    expect(crossingSample.energies[2]).toBe(4)
  })

  it('produces bit-identical FrameSample sequences for the same input (determinism)', () => {
    const first = runPipeline(flyThroughOptions).samples
    const second = runPipeline(flyThroughOptions).samples
    expect(second).toEqual(first)
  })

  it('stays deterministic with dropped frames in the input', () => {
    const withDrops: SyntheticSourceOptions = {
      ...flyThroughOptions,
      isFrameDropped: (f) => f === 2,
    }
    const first = runPipeline(withDrops).samples
    const second = runPipeline(withDrops).samples
    expect(first).toHaveLength(4)
    expect(second).toEqual(first)
  })

  it('pushes every processed frame into the ring buffer with last-K semantics', () => {
    const source = new SyntheticSource({ width: 2, height: 1, frameCount: 5, frameIntervalMs: 10 })
    const pipeline = new DetectionPipeline(source, {}, 3)
    pipeline.start(() => {})
    source.pumpAll()
    expect(pipeline.ringBuffer.frames().map((f) => f.captureTimeMs)).toEqual([20, 30, 40])
  })

  it('setPause(true) keeps a stationary blob hot; unpausing lets the background absorb it', () => {
    const source = new SyntheticSource({
      width: 4,
      height: 1,
      frameCount: 20,
      frameIntervalMs: 1000 / 60,
      backgroundLevel: 20,
      blob: {
        widthPx: 2,
        intensity: 220,
        speedPxPerFrame: 0,
        direction: 1,
        startFrame: 1,
        startCenterX: 0.5,
      },
    })
    const pipeline = new DetectionPipeline(source, {
      stripCount: 2,
      threshold: 25,
      emaTimeConstantMs: 30,
    })
    const samples: FrameSample[] = []
    pipeline.start((s) => samples.push(s))
    source.pump(1)
    pipeline.setPause(true)
    source.pump(8)
    // Paused: the blob stays hot for all 8 frames — never absorbed.
    expect(samples.slice(1).map((s) => [...s.energies])).toEqual(
      new Array(8).fill([2, 0]),
    )
    pipeline.setPause(false)
    source.pump(11)
    // Unpaused with τ = 30 ms, the background absorbs the blob in a few
    // frames; the tail of the run must be quiet.
    expect([...samples.at(-1)!.energies]).toEqual([0, 0])
    expect(samples.slice(1, 9).every((s) => s.energies[0] === 2)).toBe(true)
  })

  it('applies updateTunables on the next frame; stripCount changes re-bucket without re-seeding', () => {
    const source = new SyntheticSource({
      width: 8,
      height: 1,
      frameCount: 10,
      backgroundLevel: 20,
      blob: {
        widthPx: 2,
        intensity: 220,
        speedPxPerFrame: 0,
        direction: 1,
        startFrame: 1,
        startCenterX: 0.5,
      },
    })
    const pipeline = new DetectionPipeline(source, { stripCount: 2, threshold: 25 })
    pipeline.setPause(true)
    const samples: FrameSample[] = []
    pipeline.start((s) => samples.push(s))
    source.pump(2)
    expect([...samples.at(-1)!.energies]).toEqual([2, 0])
    pipeline.updateTunables({ stripCount: 4 })
    source.pump(1)
    // A re-seed would report all zeros; the persisted background keeps the
    // blob hot, re-bucketed into 4 strips.
    expect([...samples.at(-1)!.energies]).toEqual([2, 0, 0, 0])
    expect([...samples.at(-1)!.stripPixelCounts]).toEqual([2, 2, 2, 2])
    pipeline.updateTunables({ threshold: 250 })
    source.pump(1)
    expect([...samples.at(-1)!.energies]).toEqual([0, 0, 0, 0])
  })

  it('merges partial tunables over the documented defaults', () => {
    const pipeline = new DetectionPipeline(new SyntheticSource({ width: 1, height: 1, frameCount: 1 }))
    const tunables = pipeline.tunables
    expect(tunables.stripCount).toBe(12)
    expect(tunables.threshold).toBe(25)
    expect(tunables.emaTimeConstantMs).toBe(EMA_TIME_CONSTANT_MS)
    expect(tunables.roi).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    pipeline.updateTunables({ roi: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } })
    expect(pipeline.tunables.roi).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })
    expect(pipeline.tunables.stripCount).toBe(12)
  })

  it('stop() is a hard barrier: a frame in flight during stop() emits nothing', () => {
    let deliver: ((frame: LumaFrame) => void) | undefined
    const source = {
      start: (onFrame: (frame: LumaFrame) => void) => {
        deliver = onFrame
      },
      stop: () => {},
    }
    const pipeline = new DetectionPipeline(source)
    const samples: FrameSample[] = []
    pipeline.start((s) => samples.push(s))
    const frame = { data: new Uint8Array(1), width: 1, height: 1, captureTimeMs: 0 }
    deliver!(frame)
    expect(samples).toHaveLength(1)
    pipeline.stop()
    deliver!({ ...frame, captureTimeMs: 16 })
    expect(samples).toHaveLength(1)
    expect(pipeline.ringBuffer.frames()).toHaveLength(1)
  })

  it('resetBackground() re-seeds the EMA so a moved same-size ROI is not phantom-hot', () => {
    const source = new SyntheticSource({
      width: 4,
      height: 1,
      frameCount: 10,
      backgroundLevel: 20,
      blob: {
        widthPx: 2,
        intensity: 220,
        speedPxPerFrame: 0,
        direction: 1,
        startFrame: 1,
        startCenterX: 0.5,
      },
    })
    const pipeline = new DetectionPipeline(source, { stripCount: 2, threshold: 25 })
    pipeline.setPause(true)
    const samples: FrameSample[] = []
    pipeline.start((s) => samples.push(s))
    source.pump(2)
    // The scene changed against the seeded background (an ROI move looks
    // exactly like this): hot without a reset...
    expect([...samples.at(-1)!.energies]).toEqual([2, 0])
    pipeline.resetBackground()
    source.pump(1)
    // ...but the next frame after resetBackground() re-seeds instead.
    expect([...samples.at(-1)!.energies]).toEqual([0, 0])
    source.pump(1)
    expect([...samples.at(-1)!.energies]).toEqual([0, 0])
  })

  it('rejects double start and stops its source on stop()', () => {
    const source = new SyntheticSource({ width: 1, height: 1, frameCount: 5 })
    const pipeline = new DetectionPipeline(source)
    pipeline.start(() => {})
    expect(() => pipeline.start(() => {})).toThrow()
    pipeline.stop()
    expect(() => source.pump()).toThrow()
  })
})
