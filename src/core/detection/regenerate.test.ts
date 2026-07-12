import { describe, expect, it } from 'vitest'
import { regenerateEnergyJson } from './regenerate'
import { encodeClip, ClipFormatError } from './clip-format'
import { encodeEnergyJson } from './energy-json'
import { SyntheticSource } from './synthetic-source'
import { DEFAULT_DETECTION_TUNABLES } from './types'
import type { LumaFrame } from './types'

function smallClip(): Uint8Array {
  const source = new SyntheticSource({
    width: 24,
    height: 6,
    frameCount: 12,
    blob: { widthPx: 3, intensity: 200, speedPxPerFrame: 2, direction: 1, startFrame: 1 },
  })
  const frames: LumaFrame[] = []
  source.start((frame) => frames.push(frame))
  source.pumpAll()
  return encodeClip(frames)
}

describe('regenerateEnergyJson', () => {
  it('produces one energy frame per clip frame with the recorded timestamps', () => {
    const result = regenerateEnergyJson(smallClip())
    expect(result.formatVersion).toBe(1)
    expect(result.tunables).toEqual(DEFAULT_DETECTION_TUNABLES)
    expect(result.frames).toHaveLength(12)
    expect(result.frames.map((f) => f.captureTimeMs)).toEqual(
      Array.from({ length: 12 }, (_, f) => f * (1000 / 60)),
    )
    expect(result.frames[0].energies).toEqual(new Array(12).fill(0))
    expect(result.frames.some((f) => f.energies.some((e) => e > 0))).toBe(true)
  })

  it('records tunables overrides as provenance and applies them', () => {
    const result = regenerateEnergyJson(smallClip(), { stripCount: 6, threshold: 40 })
    expect(result.tunables.stripCount).toBe(6)
    expect(result.tunables.threshold).toBe(40)
    for (const frame of result.frames) expect(frame.energies).toHaveLength(6)
  })

  it('is deterministic: two regenerations encode to identical bytes', () => {
    const clip = smallClip()
    expect(encodeEnergyJson(regenerateEnergyJson(clip))).toBe(
      encodeEnergyJson(regenerateEnergyJson(clip)),
    )
  })

  it('propagates clip validation errors', () => {
    expect(() => regenerateEnergyJson(new Uint8Array(3))).toThrow(ClipFormatError)
  })
})
