import { describe, expect, it } from 'vitest'
import { CLIP_FORMAT_VERSION, ClipFormatError, decodeClip, encodeClip } from './clip-format'
import type { LumaFrame } from './types'

function frame(captureTimeMs: number, width = 4, height = 3, fill = 7): LumaFrame {
  return { data: new Uint8Array(width * height).fill(fill), width, height, captureTimeMs }
}

function testClipFrames(): LumaFrame[] {
  return [frame(0, 4, 3, 10), frame(16.666666666666668, 4, 3, 20), frame(50.25, 4, 3, 30)]
}

describe('encodeClip / decodeClip', () => {
  it('round-trips frames, timestamps, and conditions byte-exactly', () => {
    const frames = testClipFrames()
    const conditions = { scene: 'unit test', light: 'none' }
    const bytes = encodeClip(frames, conditions)

    const { header, frames: decoded } = decodeClip(bytes)
    expect(header).toEqual({
      formatVersion: CLIP_FORMAT_VERSION,
      width: 4,
      height: 3,
      frameCount: 3,
      captureTimesMs: [0, 16.666666666666668, 50.25],
      conditions,
    })
    expect(decoded).toEqual(frames)

    expect(encodeClip(decoded, conditions)).toEqual(bytes)
  })

  it('starts with the CWCL magic and a little-endian header length', () => {
    const bytes = encodeClip([frame(0)])
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('CWCL')
    const headerLength = new DataView(bytes.buffer).getUint32(4, true)
    expect(bytes.length).toBe(8 + headerLength + 4 * 3)
  })

  it('decodes from a view with a nonzero byteOffset (fs Buffers)', () => {
    const bytes = encodeClip(testClipFrames())
    const padded = new Uint8Array(bytes.length + 16)
    padded.set(bytes, 16)
    const view = padded.subarray(16)
    expect(decodeClip(view).frames).toEqual(testClipFrames())
  })

  it('decoded frames own their data (mutating them leaves the bytes intact)', () => {
    const bytes = encodeClip([frame(0)])
    const first = decodeClip(bytes)
    first.frames[0].data.fill(255)
    expect(decodeClip(bytes).frames[0].data[0]).toBe(7)
  })

  it('omits conditions from the header when not given', () => {
    expect(decodeClip(encodeClip([frame(0)])).header.conditions).toBeUndefined()
  })

  it('rejects zero frames, mixed dimensions, short planes, and bad timestamps', () => {
    expect(() => encodeClip([])).toThrow(ClipFormatError)
    expect(() => encodeClip([frame(0, 4, 3), frame(1, 4, 4)])).toThrow(/frame 1 is 4×4/)
    const short: LumaFrame = { data: new Uint8Array(5), width: 4, height: 3, captureTimeMs: 0 }
    expect(() => encodeClip([short])).toThrow(/frame 0 luma plane has 5 bytes/)
    expect(() => encodeClip([frame(NaN)])).toThrow(/captureTimeMs/)
  })

  it('rejects non-cwclip and truncated inputs with clear errors', () => {
    expect(() => decodeClip(new Uint8Array(0))).toThrow(/truncated clip/)
    expect(() => decodeClip(new Uint8Array(4))).toThrow(/truncated clip/)

    const notAClip = new TextEncoder().encode('{"json": "not a clip"}')
    expect(() => decodeClip(notAClip)).toThrow(/not a \.cwclip/)

    const bytes = encodeClip(testClipFrames())
    expect(() => decodeClip(bytes.slice(0, 20))).toThrow(ClipFormatError)
    expect(() => decodeClip(bytes.slice(0, bytes.length - 1))).toThrow(/truncated or trailing/)

    const trailing = new Uint8Array(bytes.length + 1)
    trailing.set(bytes)
    expect(() => decodeClip(trailing)).toThrow(/truncated or trailing/)
  })

  it('rejects corrupt headers: bad JSON, wrong version, inconsistent fields', () => {
    const withHeader = (header: unknown, planeBytesCount = 0): Uint8Array => {
      const headerBytes = new TextEncoder().encode(JSON.stringify(header))
      const bytes = new Uint8Array(8 + headerBytes.length + planeBytesCount)
      bytes.set(new TextEncoder().encode('CWCL'))
      new DataView(bytes.buffer).setUint32(4, headerBytes.length, true)
      bytes.set(headerBytes, 8)
      return bytes
    }

    const garbageJson = withHeader({})
    garbageJson[8] = 0x7b + 1
    expect(() => decodeClip(garbageJson)).toThrow(/not valid JSON/)

    expect(() => decodeClip(withHeader([1, 2]))).toThrow(/not a JSON object/)
    const valid = {
      formatVersion: 1,
      width: 2,
      height: 1,
      frameCount: 1,
      captureTimesMs: [0],
    }
    expect(() => decodeClip(withHeader({ ...valid, formatVersion: 2 }, 2))).toThrow(
      /unsupported clip formatVersion 2/,
    )
    expect(() => decodeClip(withHeader({ ...valid, width: 0 }, 2))).toThrow(/width\/height/)
    expect(() => decodeClip(withHeader({ ...valid, frameCount: 0 }, 2))).toThrow(/frameCount/)
    expect(() => decodeClip(withHeader({ ...valid, captureTimesMs: [] }, 2))).toThrow(
      /captureTimesMs/,
    )
    expect(() => decodeClip(withHeader({ ...valid, captureTimesMs: ['0'] }, 2))).toThrow(
      /captureTimesMs/,
    )
    expect(() => decodeClip(withHeader({ ...valid, conditions: { a: 1 } }, 2))).toThrow(
      /conditions/,
    )
    expect(decodeClip(withHeader(valid, 2)).frames).toHaveLength(1)
  })
})
