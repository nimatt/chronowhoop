import { describe, expect, it } from 'vitest'
import { StripReducer } from './strip-reduce'

// Gray pixels (r = g = b = v) have luminance exactly v: the Rec. 709
// coefficients sum to 1, so hand-computed expectations stay exact.
function grayFrame(values: number[]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(values.length * 4)
  values.forEach((v, i) => {
    rgba[i * 4] = v
    rgba[i * 4 + 1] = v
    rgba[i * 4 + 2] = v
    rgba[i * 4 + 3] = 255
  })
  return rgba
}

describe('StripReducer', () => {
  it('seeds the background on the first frame and reports zero energy', () => {
    const reducer = new StripReducer({ stripCount: 2, alpha: 0.5, threshold: 10 })
    const energies = reducer.process(grayFrame([10, 20, 30, 40, 50, 60, 70, 80]), 4, 2)
    expect([...energies]).toEqual([0, 0])
    expect(reducer.seeded).toBe(true)
  })

  it('counts hot pixels per strip against the seeded background', () => {
    const reducer = new StripReducer({ stripCount: 2, alpha: 0.5, threshold: 10 })
    // 4×2: strips are x∈{0,1} and x∈{2,3}.
    reducer.process(grayFrame([100, 100, 100, 100, 100, 100, 100, 100]), 4, 2)
    // Diffs vs background 100: strip 0 gets 50 (hot) and 0; strip 1 gets
    // 11 (hot), 10 (NOT hot — strictly greater-than), then row 2 all 0.
    const energies = reducer.process(grayFrame([150, 100, 111, 110, 100, 100, 100, 100]), 4, 2)
    expect([...energies]).toEqual([1, 1])
  })

  it('adapts the background by alpha (alpha=1 absorbs a change in one frame)', () => {
    const reducer = new StripReducer({ stripCount: 1, alpha: 1, threshold: 10 })
    reducer.process(grayFrame([100]), 1, 1)
    expect([...reducer.process(grayFrame([200]), 1, 1)]).toEqual([1])
    // Background is now 200, so the same frame again is quiet.
    expect([...reducer.process(grayFrame([200]), 1, 1)]).toEqual([0])
  })

  it('keeps the background frozen at alpha=0', () => {
    const reducer = new StripReducer({ stripCount: 1, alpha: 0, threshold: 10 })
    reducer.process(grayFrame([100]), 1, 1)
    expect([...reducer.process(grayFrame([200]), 1, 1)]).toEqual([1])
    expect([...reducer.process(grayFrame([200]), 1, 1)]).toEqual([1])
  })

  it('re-seeds on dimension change and on reset()', () => {
    const reducer = new StripReducer({ stripCount: 1, alpha: 0.5, threshold: 10 })
    reducer.process(grayFrame([100]), 1, 1)
    // New dimensions: this frame seeds, so no energy despite the jump.
    expect([...reducer.process(grayFrame([200, 200]), 2, 1)]).toEqual([0])
    expect([...reducer.process(grayFrame([255, 255]), 2, 1)]).toEqual([2])
    reducer.reset()
    expect([...reducer.process(grayFrame([0, 0]), 2, 1)]).toEqual([0])
  })

  it('distributes uneven widths across strips by floor(x·N/width)', () => {
    const reducer = new StripReducer({ stripCount: 3, alpha: 0.5, threshold: 10 })
    reducer.process(grayFrame([0, 0, 0, 0, 0]), 5, 1)
    // Width 5, 3 strips: x=0,1 → strip 0; x=2,3 → strip 1; x=4 → strip 2.
    const energies = reducer.process(grayFrame([255, 255, 255, 255, 255]), 5, 1)
    expect([...energies]).toEqual([2, 2, 1])
  })

  it('processLuminance matches the RGBA path for gray frames', () => {
    const rgbaReducer = new StripReducer({ stripCount: 2, alpha: 0.5, threshold: 10 })
    const lumaReducer = new StripReducer({ stripCount: 2, alpha: 0.5, threshold: 10 })
    const frame1 = [100, 100, 100, 100, 100, 100, 100, 100]
    const frame2 = [150, 100, 111, 110, 100, 100, 100, 100]
    rgbaReducer.process(grayFrame(frame1), 4, 2)
    lumaReducer.processLuminance(new Uint8Array(frame1), 4, 2)
    const fromRgba = [...rgbaReducer.process(grayFrame(frame2), 4, 2)]
    const fromLuma = [...lumaReducer.processLuminance(new Uint8Array(frame2), 4, 2)]
    expect(fromLuma).toEqual(fromRgba)
    expect(fromLuma).toEqual([1, 1])
  })

  it('processLuminance re-seeds on dimension change and rejects short buffers', () => {
    const reducer = new StripReducer({ stripCount: 1, alpha: 0.5, threshold: 10 })
    reducer.processLuminance(new Uint8Array([100]), 1, 1)
    expect([...reducer.processLuminance(new Uint8Array([200, 200]), 2, 1)]).toEqual([0])
    expect([...reducer.processLuminance(new Uint8Array([255, 255]), 2, 1)]).toEqual([2])
    expect(() => reducer.processLuminance(new Uint8Array(1), 2, 1)).toThrow(/too small/)
  })

  it('rejects a too-small pixel buffer and a non-positive strip count', () => {
    const reducer = new StripReducer({ stripCount: 1, alpha: 0.5, threshold: 10 })
    expect(() => reducer.process(new Uint8ClampedArray(4), 2, 1)).toThrow(/too small/)
    expect(() => new StripReducer({ stripCount: 0, alpha: 0.5, threshold: 10 })).toThrow(
      /positive integer/,
    )
  })
})
