// Shared primitives for validating parsed fixture-format JSON (clip headers,
// annotation sidecars, strip-energy JSON). Internal to the detection module.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string')
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

export function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1
}
