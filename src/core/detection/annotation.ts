// Annotation sidecars (plan 03 item 3): the GROUND TRUTH for a clip, attached
// to the clip and its frame indices — never to derived strip-energy JSON.
// Stored as a standalone JSON file next to the clip. The tier defines Phase
// 4's acceptance gate: `must-pass` clips gate CI; `known-limitation` lets
// hard field fixtures commit without breaking it.

import type { CrossingDirection } from './crossing-events'
import { isNonNegativeInteger, isRecord, isStringRecord } from './format-validation'

export const ANNOTATION_FORMAT_VERSION = 1

export type ClipTier = 'must-pass' | 'known-limitation'
// Re-exported for annotation consumers; the canonical home is
// crossing-events.ts (annotations describe the same directions the detector
// emits).
export type { CrossingDirection }

export interface ClipCrossing {
  frameIndex: number
  direction: CrossingDirection
}

export interface ClipAnnotation {
  formatVersion: typeof ANNOTATION_FORMAT_VERSION
  tier: ClipTier
  crossings: ClipCrossing[]
  conditions?: Record<string, string>
  notes?: string
}

export class AnnotationFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnnotationFormatError'
  }
}

function isTier(value: unknown): value is ClipTier {
  return value === 'must-pass' || value === 'known-limitation'
}

function isDirection(value: unknown): value is CrossingDirection {
  return value === 'ltr' || value === 'rtl'
}

function validateAnnotation(value: unknown): ClipAnnotation {
  if (!isRecord(value)) {
    throw new AnnotationFormatError('annotation is not a JSON object')
  }
  if (value.formatVersion !== ANNOTATION_FORMAT_VERSION) {
    throw new AnnotationFormatError(
      `unsupported annotation formatVersion ${JSON.stringify(value.formatVersion)}, expected ${ANNOTATION_FORMAT_VERSION}`,
    )
  }
  const { tier, crossings, conditions, notes } = value
  if (!isTier(tier)) {
    throw new AnnotationFormatError(
      `annotation tier must be "must-pass" or "known-limitation", got ${JSON.stringify(tier)}`,
    )
  }
  if (!Array.isArray(crossings)) {
    throw new AnnotationFormatError('annotation crossings must be an array')
  }
  const validatedCrossings = crossings.map((crossing, i): ClipCrossing => {
    if (!isRecord(crossing) || !isNonNegativeInteger(crossing.frameIndex)) {
      throw new AnnotationFormatError(`crossing ${i} frameIndex must be a non-negative integer`)
    }
    if (!isDirection(crossing.direction)) {
      throw new AnnotationFormatError(
        `crossing ${i} direction must be "ltr" or "rtl", got ${JSON.stringify(crossing.direction)}`,
      )
    }
    return { frameIndex: crossing.frameIndex, direction: crossing.direction }
  })
  if (conditions !== undefined && !isStringRecord(conditions)) {
    throw new AnnotationFormatError('annotation conditions must map string keys to string values')
  }
  if (notes !== undefined && typeof notes !== 'string') {
    throw new AnnotationFormatError('annotation notes must be a string')
  }
  return {
    formatVersion: ANNOTATION_FORMAT_VERSION,
    tier,
    crossings: validatedCrossings,
    ...(conditions !== undefined ? { conditions } : {}),
    ...(notes !== undefined ? { notes } : {}),
  }
}

// Never throws uncaught garbage: any malformed input becomes an
// AnnotationFormatError with a specific message. Unknown extra keys are
// ignored (forward compatibility for additive fields within a version).
export function parseAnnotation(json: string): ClipAnnotation {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new AnnotationFormatError(`annotation is not valid JSON: ${(error as Error).message}`)
  }
  return validateAnnotation(parsed)
}

// Canonical serialization (fixed key order, 2-space indent, trailing newline)
// so regenerated sidecars are byte-stable — used by the fixture-freshness
// test and the /lab annotation tooling.
export function serializeAnnotation(annotation: ClipAnnotation): string {
  return `${JSON.stringify(validateAnnotation(annotation), null, 2)}\n`
}
