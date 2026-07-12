// Strip-energy JSON (plan 03 item 3): a REGENERABLE DERIVATIVE of a clip,
// never ground truth — annotations attach to clips and frame indices. The
// embedded tunables are provenance: when tunables move, re-derive from the
// clip (regenerateEnergyJson). Format frozen by the plan:
// { formatVersion, tunables, frames: [{ captureTimeMs, energies[] }] }.
// stripPixelCounts are deliberately absent — they derive from the clip's
// dimensions plus tunables.stripCount (see staging notes, Wave 2).

import type { DetectionTunables } from './types'
import { isFiniteNumber, isNonNegativeInteger, isPositiveInteger, isRecord } from './format-validation'

export const ENERGY_JSON_FORMAT_VERSION = 1

export interface EnergyJsonFrame {
  captureTimeMs: number
  energies: number[]
}

export interface EnergyJson {
  formatVersion: typeof ENERGY_JSON_FORMAT_VERSION
  tunables: DetectionTunables
  frames: EnergyJsonFrame[]
}

export class EnergyJsonFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnergyJsonFormatError'
  }
}

function validateTunables(value: unknown): DetectionTunables {
  if (!isRecord(value) || !isRecord(value.roi)) {
    throw new EnergyJsonFormatError('tunables must be an object with an roi rect')
  }
  const { x, y, width, height } = value.roi
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    throw new EnergyJsonFormatError('tunables.roi x/y/width/height must be finite numbers')
  }
  const { stripCount, triggerLevel, emaTimeConstantMs, threshold } = value
  if (!isPositiveInteger(stripCount)) {
    throw new EnergyJsonFormatError('tunables.stripCount must be a positive integer')
  }
  if (!isFiniteNumber(triggerLevel) || !isFiniteNumber(threshold)) {
    throw new EnergyJsonFormatError('tunables triggerLevel/threshold must be finite numbers')
  }
  if (!isFiniteNumber(emaTimeConstantMs) || emaTimeConstantMs <= 0) {
    throw new EnergyJsonFormatError('tunables.emaTimeConstantMs must be a positive finite number')
  }
  return { roi: { x, y, width, height }, stripCount, triggerLevel, emaTimeConstantMs, threshold }
}

function validateEnergyJson(value: unknown): EnergyJson {
  if (!isRecord(value)) {
    throw new EnergyJsonFormatError('energy JSON is not a JSON object')
  }
  if (value.formatVersion !== ENERGY_JSON_FORMAT_VERSION) {
    throw new EnergyJsonFormatError(
      `unsupported energy JSON formatVersion ${JSON.stringify(value.formatVersion)}, expected ${ENERGY_JSON_FORMAT_VERSION}`,
    )
  }
  const tunables = validateTunables(value.tunables)
  if (!Array.isArray(value.frames)) {
    throw new EnergyJsonFormatError('energy JSON frames must be an array')
  }
  const frames = value.frames.map((frame, i): EnergyJsonFrame => {
    if (!isRecord(frame) || !isFiniteNumber(frame.captureTimeMs)) {
      throw new EnergyJsonFormatError(`frame ${i} captureTimeMs must be a finite number`)
    }
    const { energies } = frame
    if (!Array.isArray(energies) || !energies.every(isNonNegativeInteger)) {
      throw new EnergyJsonFormatError(`frame ${i} energies must be non-negative integers`)
    }
    if (energies.length !== tunables.stripCount) {
      throw new EnergyJsonFormatError(
        `frame ${i} has ${energies.length} energies but tunables.stripCount is ${tunables.stripCount}`,
      )
    }
    return { captureTimeMs: frame.captureTimeMs, energies: [...energies] }
  })
  return { formatVersion: ENERGY_JSON_FORMAT_VERSION, tunables, frames }
}

// Typed errors only, like the other fixture parsers. Unknown extra keys are
// ignored (forward compatibility within a version).
export function parseEnergyJson(json: string): EnergyJson {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new EnergyJsonFormatError(`energy JSON is not valid JSON: ${(error as Error).message}`)
  }
  return validateEnergyJson(parsed)
}

// Canonical serialization (validated, fixed key order, 2-space indent,
// trailing newline) so regeneration is byte-stable for identical inputs.
export function encodeEnergyJson(doc: EnergyJson): string {
  return `${JSON.stringify(validateEnergyJson(doc), null, 2)}\n`
}
