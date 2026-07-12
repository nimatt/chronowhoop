import { describe, expect, it } from 'vitest'
import {
  AnnotationFormatError,
  parseAnnotation,
  serializeAnnotation,
  type ClipAnnotation,
} from './annotation'

const valid: ClipAnnotation = {
  formatVersion: 1,
  tier: 'must-pass',
  crossings: [
    { frameIndex: 14, direction: 'ltr' },
    { frameIndex: 90, direction: 'rtl' },
  ],
  conditions: { venue: 'garage', light: 'led' },
  notes: 'two clean fly-throughs',
}

describe('parseAnnotation / serializeAnnotation', () => {
  it('round-trips a full annotation', () => {
    expect(parseAnnotation(serializeAnnotation(valid))).toEqual(valid)
  })

  it('parses a minimal annotation and ignores unknown keys', () => {
    const parsed = parseAnnotation(
      JSON.stringify({ formatVersion: 1, tier: 'known-limitation', crossings: [], extra: true }),
    )
    expect(parsed).toEqual({ formatVersion: 1, tier: 'known-limitation', crossings: [] })
  })

  it('serialization is byte-stable regardless of input key order', () => {
    const shuffled: ClipAnnotation = {
      notes: valid.notes,
      crossings: valid.crossings.map((c) => ({ direction: c.direction, frameIndex: c.frameIndex })),
      tier: valid.tier,
      conditions: valid.conditions,
      formatVersion: 1,
    }
    expect(serializeAnnotation(shuffled)).toBe(serializeAnnotation(valid))
  })

  it('throws typed errors, never uncaught garbage', () => {
    expect(() => parseAnnotation('not json')).toThrow(AnnotationFormatError)
    expect(() => parseAnnotation('not json')).toThrow(/not valid JSON/)
    expect(() => parseAnnotation('[]')).toThrow(/not a JSON object/)
    expect(() => parseAnnotation('{"formatVersion":2}')).toThrow(/unsupported annotation formatVersion/)

    const base = { formatVersion: 1, tier: 'must-pass', crossings: [] }
    const withField = (patch: object) => JSON.stringify({ ...base, ...patch })
    expect(() => parseAnnotation(withField({ tier: 'mustpass' }))).toThrow(/tier/)
    expect(() => parseAnnotation(withField({ crossings: {} }))).toThrow(/crossings must be an array/)
    expect(() => parseAnnotation(withField({ crossings: [{ frameIndex: -1, direction: 'ltr' }] }))).toThrow(
      /crossing 0 frameIndex/,
    )
    expect(() => parseAnnotation(withField({ crossings: [{ frameIndex: 1.5, direction: 'ltr' }] }))).toThrow(
      /crossing 0 frameIndex/,
    )
    expect(() => parseAnnotation(withField({ crossings: [{ frameIndex: 1, direction: 'up' }] }))).toThrow(
      /crossing 0 direction/,
    )
    expect(() => parseAnnotation(withField({ conditions: { a: 1 } }))).toThrow(/conditions/)
    expect(() => parseAnnotation(withField({ notes: 42 }))).toThrow(/notes/)
  })
})
