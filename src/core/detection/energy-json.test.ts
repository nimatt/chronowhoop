import { describe, expect, it } from 'vitest'
import {
  EnergyJsonFormatError,
  encodeEnergyJson,
  parseEnergyJson,
  type EnergyJson,
} from './energy-json'
import { DEFAULT_DETECTION_TUNABLES } from './types'

const valid: EnergyJson = {
  formatVersion: 1,
  tunables: { ...DEFAULT_DETECTION_TUNABLES, stripCount: 3 },
  frames: [
    { captureTimeMs: 0, energies: [0, 0, 0] },
    { captureTimeMs: 16.666666666666668, energies: [0, 12, 3] },
  ],
}

function mutated(patch: (doc: EnergyJson) => void): string {
  const doc = structuredClone(valid)
  patch(doc)
  return JSON.stringify(doc)
}

describe('encodeEnergyJson / parseEnergyJson', () => {
  it('round-trips', () => {
    expect(parseEnergyJson(encodeEnergyJson(valid))).toEqual(valid)
  })

  it('encoding is byte-stable across a round-trip', () => {
    const encoded = encodeEnergyJson(valid)
    expect(encodeEnergyJson(parseEnergyJson(encoded))).toBe(encoded)
  })

  it('ignores unknown extra keys when parsing', () => {
    const parsed = parseEnergyJson(JSON.stringify({ ...valid, extra: 'ignored' }))
    expect(parsed).toEqual(valid)
  })

  it('throws typed errors for malformed documents', () => {
    expect(() => parseEnergyJson('nope')).toThrow(EnergyJsonFormatError)
    expect(() => parseEnergyJson('nope')).toThrow(/not valid JSON/)
    expect(() => parseEnergyJson('[]')).toThrow(/not a JSON object/)
    expect(() => parseEnergyJson(mutated((d) => (d.formatVersion = 2 as never)))).toThrow(
      /unsupported energy JSON formatVersion/,
    )
    expect(() => parseEnergyJson(mutated((d) => ((d as { tunables?: unknown }).tunables = undefined)))).toThrow(
      /tunables/,
    )
    expect(() => parseEnergyJson(mutated((d) => (d.tunables.roi.x = Infinity)))).toThrow(/roi/)
    expect(() => parseEnergyJson(mutated((d) => (d.tunables.stripCount = 0)))).toThrow(/stripCount/)
    expect(() => parseEnergyJson(mutated((d) => (d.tunables.emaTimeConstantMs = 0)))).toThrow(
      /emaTimeConstantMs/,
    )
    expect(() => parseEnergyJson(mutated((d) => (d.frames = {} as never)))).toThrow(
      /frames must be an array/,
    )
    expect(() => parseEnergyJson(mutated((d) => (d.frames[1].captureTimeMs = NaN)))).toThrow(
      /frame 1 captureTimeMs/,
    )
    expect(() => parseEnergyJson(mutated((d) => (d.frames[1].energies[0] = -1)))).toThrow(
      /frame 1 energies/,
    )
    expect(() => parseEnergyJson(mutated((d) => (d.frames[1].energies[0] = 0.5)))).toThrow(
      /frame 1 energies/,
    )
    expect(() => parseEnergyJson(mutated((d) => d.frames[1].energies.push(0)))).toThrow(
      /has 4 energies but tunables.stripCount is 3/,
    )
  })

  it('encode validates too (it is the same schema)', () => {
    const bad = structuredClone(valid)
    bad.frames[0].energies = [1]
    expect(() => encodeEnergyJson(bad)).toThrow(EnergyJsonFormatError)
  })
})
