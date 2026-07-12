// The .cwclip container (plan 03 item 3): the CANONICAL corpus artifact —
// raw working-resolution luma clips, lossless by construction, replayable by
// reading bytes. Layout:
//
//   bytes 0–3   ASCII magic "CWCL" (added over the staging-notes sketch so a
//               wrong or truncated file fails with a clear error, not a
//               garbage header length)
//   bytes 4–7   u32 little-endian header length
//   then        UTF-8 JSON header (ClipHeader)
//   then        frameCount concatenated raw Y planes, width×height bytes
//               each, row-major, no padding
//
// Strip-energy JSON is a regenerable derivative of clips; annotations attach
// to clips and frame indices. Spec: docs/specs/detection.md "Fixture formats".

import type { LumaFrame } from './types'
import { isFiniteNumber, isPositiveInteger, isRecord, isStringRecord } from './format-validation'

export const CLIP_MAGIC = 'CWCL'
export const CLIP_FORMAT_VERSION = 1

export interface ClipHeader {
  formatVersion: typeof CLIP_FORMAT_VERSION
  width: number
  height: number
  frameCount: number
  // One capture timestamp per frame, recorded as given (monotonicity is the
  // source's property, not the container's — replays must reproduce whatever
  // the live run saw, gaps and jitter included).
  captureTimesMs: number[]
  // Free-form recording circumstances (venue, light, camera, truncation
  // markers) — string values only.
  conditions?: Record<string, string>
}

export class ClipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClipFormatError'
  }
}

export function encodeClip(
  frames: readonly LumaFrame[],
  conditions?: Record<string, string>,
): Uint8Array {
  if (frames.length === 0) {
    throw new ClipFormatError('cannot encode a clip with zero frames')
  }
  const { width, height } = frames[0]
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    throw new ClipFormatError(`frame dimensions must be positive integers, got ${width}×${height}`)
  }
  const planeBytes = width * height
  frames.forEach((frame, i) => {
    if (frame.width !== width || frame.height !== height) {
      throw new ClipFormatError(
        `frame ${i} is ${frame.width}×${frame.height}, expected uniform ${width}×${height}`,
      )
    }
    if (frame.data.length < planeBytes) {
      throw new ClipFormatError(
        `frame ${i} luma plane has ${frame.data.length} bytes, needs ${planeBytes}`,
      )
    }
    if (!isFiniteNumber(frame.captureTimeMs)) {
      throw new ClipFormatError(`frame ${i} captureTimeMs is not a finite number`)
    }
  })

  const header: ClipHeader = {
    formatVersion: CLIP_FORMAT_VERSION,
    width,
    height,
    frameCount: frames.length,
    captureTimesMs: frames.map((frame) => frame.captureTimeMs),
    ...(conditions !== undefined ? { conditions } : {}),
  }
  const encoder = new TextEncoder()
  const headerBytes = encoder.encode(JSON.stringify(header))

  const bytes = new Uint8Array(8 + headerBytes.length + planeBytes * frames.length)
  bytes.set(encoder.encode(CLIP_MAGIC), 0)
  new DataView(bytes.buffer).setUint32(4, headerBytes.length, true)
  bytes.set(headerBytes, 8)
  let offset = 8 + headerBytes.length
  for (const frame of frames) {
    bytes.set(frame.data.subarray(0, planeBytes), offset)
    offset += planeBytes
  }
  return bytes
}

function validateHeader(value: unknown): ClipHeader {
  if (!isRecord(value)) {
    throw new ClipFormatError('clip header is not a JSON object')
  }
  if (value.formatVersion !== CLIP_FORMAT_VERSION) {
    throw new ClipFormatError(
      `unsupported clip formatVersion ${JSON.stringify(value.formatVersion)}, expected ${CLIP_FORMAT_VERSION}`,
    )
  }
  const { width, height, frameCount, captureTimesMs, conditions } = value
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    throw new ClipFormatError('clip header width/height must be positive integers')
  }
  if (!isPositiveInteger(frameCount)) {
    throw new ClipFormatError('clip header frameCount must be a positive integer')
  }
  if (
    !Array.isArray(captureTimesMs) ||
    captureTimesMs.length !== frameCount ||
    !captureTimesMs.every(isFiniteNumber)
  ) {
    throw new ClipFormatError(
      `clip header captureTimesMs must be ${frameCount} finite numbers (one per frame)`,
    )
  }
  if (conditions !== undefined && !isStringRecord(conditions)) {
    throw new ClipFormatError('clip header conditions must map string keys to string values')
  }
  return {
    formatVersion: CLIP_FORMAT_VERSION,
    width,
    height,
    frameCount,
    captureTimesMs,
    ...(conditions !== undefined ? { conditions } : {}),
  }
}

// Hard validation throughout: any malformed input becomes a ClipFormatError
// with a specific message, never a crash or a silently wrong clip. The byte
// length must match the header exactly — truncation AND trailing bytes are
// errors. Decoded frames own fresh data copies (LumaFrame ownership rule).
export function decodeClip(bytes: Uint8Array): { header: ClipHeader; frames: LumaFrame[] } {
  if (bytes.length < 8) {
    throw new ClipFormatError(`truncated clip: ${bytes.length} bytes, need at least 8 for magic + header length`)
  }
  const decoder = new TextDecoder()
  const magic = decoder.decode(bytes.subarray(0, 4))
  if (magic !== CLIP_MAGIC) {
    throw new ClipFormatError(`not a .cwclip file: magic is ${JSON.stringify(magic)}, expected "${CLIP_MAGIC}"`)
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)
  if (8 + headerLength > bytes.length) {
    throw new ClipFormatError(
      `truncated clip: header claims ${headerLength} bytes but only ${bytes.length - 8} follow`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(bytes.subarray(8, 8 + headerLength)))
  } catch (error) {
    throw new ClipFormatError(`clip header is not valid JSON: ${(error as Error).message}`)
  }
  const header = validateHeader(parsed)

  const planeBytes = header.width * header.height
  const expectedLength = 8 + headerLength + planeBytes * header.frameCount
  if (bytes.length !== expectedLength) {
    throw new ClipFormatError(
      `clip is ${bytes.length} bytes but the header implies exactly ${expectedLength} ` +
        `(${header.frameCount} frames × ${planeBytes} bytes after the header) — truncated or trailing data`,
    )
  }

  const frames: LumaFrame[] = []
  for (let i = 0; i < header.frameCount; i++) {
    const start = 8 + headerLength + i * planeBytes
    frames.push({
      data: bytes.slice(start, start + planeBytes),
      width: header.width,
      height: header.height,
      captureTimeMs: header.captureTimesMs[i],
    })
  }
  return { header, frames }
}
