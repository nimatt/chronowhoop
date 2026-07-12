import { describe, expect, it } from 'vitest'
import { ClipSource } from './clip-source'
import { SyntheticSource, type SyntheticSourceOptions } from './synthetic-source'
import { DetectionPipeline } from './pipeline'
import { decodeClip, encodeClip } from './clip-format'
import type { LumaFrame, FrameSample } from './types'

// A scene with the awkward parts of a live run: timestamp jitter and dropped
// frames — exactly what replay must reproduce.
const sceneOptions: SyntheticSourceOptions = {
  width: 32,
  height: 8,
  frameCount: 24,
  frameJitterMs: (f) => (f % 3) * 0.4,
  noise: (x, y, f) => ((x * 7 + y * 5 + f * 3) % 3) - 1,
  blob: { widthPx: 4, intensity: 220, speedPxPerFrame: 2, direction: 1, startFrame: 1 },
  isFrameDropped: (f) => f === 5 || f === 6,
}

function recordScene(): LumaFrame[] {
  const source = new SyntheticSource(sceneOptions)
  const frames: LumaFrame[] = []
  source.start((frame) => frames.push(frame))
  source.pumpAll()
  source.stop()
  return frames
}

function runPipeline(source: SyntheticSource | ClipSource): FrameSample[] {
  const samples: FrameSample[] = []
  const pipeline = new DetectionPipeline(source, { stripCount: 8 })
  pipeline.start((sample) => samples.push(sample))
  source.pumpAll()
  pipeline.stop()
  return samples
}

describe('ClipSource', () => {
  it('replays frames and recorded timestamps exactly, gaps included', () => {
    const recorded = recordScene()
    const clip = encodeClip(recorded)
    const replayed: LumaFrame[] = []
    const source = new ClipSource(decodeClip(clip).frames)
    source.start((frame) => replayed.push(frame))
    expect(source.pumpAll()).toBe(recorded.length)
    expect(replayed).toEqual(recorded)
  })

  it('pump() is on-demand: counts delivered frames and stops at the end', () => {
    const source = new ClipSource(recordScene())
    expect(() => source.pump()).toThrow(/before start/)
    const seen: number[] = []
    source.start((frame) => seen.push(frame.captureTimeMs))
    expect(source.pump(3)).toBe(3)
    expect(source.nextFrameIndex).toBe(3)
    expect(seen).toHaveLength(3)
    expect(source.pump(1000)).toBe(source.frameCount - 3)
    expect(source.pump()).toBe(0)
  })

  it('rejects an empty clip', () => {
    expect(() => new ClipSource([])).toThrow(/at least one frame/)
  })

  it('emits consumer-owned copies: mutating an emitted frame cannot corrupt replays', () => {
    const frames = recordScene()
    const first = new ClipSource(frames)
    const emitted: LumaFrame[] = []
    first.start((frame) => emitted.push(frame))
    first.pumpAll()
    for (const frame of emitted) frame.data.fill(0)

    const second = new ClipSource(frames)
    const replayed: LumaFrame[] = []
    second.start((frame) => replayed.push(frame))
    second.pumpAll()
    expect(replayed).toEqual(recordScene())
  })

  it('drives the pipeline to a bit-identical FrameSample sequence across runs', () => {
    const clip = encodeClip(recordScene())
    const runA = runPipeline(new ClipSource(decodeClip(clip).frames))
    const runB = runPipeline(new ClipSource(decodeClip(clip).frames))
    expect(runA.length).toBeGreaterThan(0)
    expect(runA).toEqual(runB)
  })

  it('reproduces the LIVE run bit-exactly: recorded clip ≡ original source through the pipeline', () => {
    const liveSamples = runPipeline(new SyntheticSource(sceneOptions))
    const clip = encodeClip(recordScene())
    const replaySamples = runPipeline(new ClipSource(decodeClip(clip).frames))
    expect(replaySamples).toEqual(liveSamples)
  })
})
