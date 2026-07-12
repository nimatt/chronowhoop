// /lab self-test (plan 03 item 10): run the bundled fixture clip through
// regenerateEnergyJson with DEFAULT tunables and compare against the
// committed strip-energy JSON — the deployed bundle proving it computes what
// CI computed. The comparison is semantic, not byte-level: energies are
// integers and captureTimeMs round-trips exactly through JSON, so exact
// equality holds wherever the reducer is correct, while byte comparison (and
// comparing the computed default τ) would couple the verdict to one engine's
// float formatting / Math.log ULPs (see staging notes, Waves 2–3).

import { parseEnergyJson } from '../../core/detection/energy-json'
import { regenerateEnergyJson } from '../../core/detection/regenerate'

export interface SelfTestDivergence {
  frameIndex: number
  field: 'captureTimeMs' | 'energies'
  expected: string
  actual: string
}

export interface SelfTestReport {
  pass: boolean
  frameCount: number
  detail?: string
  divergence?: SelfTestDivergence
}

// Throws (ClipFormatError / EnergyJsonFormatError) on malformed inputs — the
// caller reports that as its own failure mode.
export function runSelfTest(clipBytes: Uint8Array, expectedEnergyJson: string): SelfTestReport {
  const expected = parseEnergyJson(expectedEnergyJson)
  const actual = regenerateEnergyJson(clipBytes)

  if (actual.tunables.stripCount !== expected.tunables.stripCount) {
    return {
      pass: false,
      frameCount: expected.frames.length,
      detail:
        `default stripCount is ${actual.tunables.stripCount} but the committed fixture ` +
        `was generated with ${expected.tunables.stripCount} — regenerate the fixture`,
    }
  }
  if (actual.frames.length !== expected.frames.length) {
    return {
      pass: false,
      frameCount: expected.frames.length,
      detail: `computed ${actual.frames.length} frames, fixture has ${expected.frames.length}`,
    }
  }

  for (let i = 0; i < expected.frames.length; i++) {
    const want = expected.frames[i]
    const got = actual.frames[i]
    if (got.captureTimeMs !== want.captureTimeMs) {
      return {
        pass: false,
        frameCount: expected.frames.length,
        divergence: {
          frameIndex: i,
          field: 'captureTimeMs',
          expected: String(want.captureTimeMs),
          actual: String(got.captureTimeMs),
        },
      }
    }
    const sameEnergies =
      got.energies.length === want.energies.length &&
      got.energies.every((energy, strip) => energy === want.energies[strip])
    if (!sameEnergies) {
      return {
        pass: false,
        frameCount: expected.frames.length,
        divergence: {
          frameIndex: i,
          field: 'energies',
          expected: `[${want.energies.join(', ')}]`,
          actual: `[${got.energies.join(', ')}]`,
        },
      }
    }
  }
  return { pass: true, frameCount: expected.frames.length }
}
