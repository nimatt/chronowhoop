import { describe, expect, it } from 'vitest'
import { centeredRoi } from './luminance-pass'

describe('centeredRoi', () => {
  it('centers the ROI in the frame', () => {
    expect(centeredRoi(1280, 720, 64)).toEqual({ x: 608, y: 328, width: 64, height: 64 })
  })

  it('floors an odd centering remainder', () => {
    expect(centeredRoi(100, 100, 63)).toEqual({ x: 18, y: 18, width: 63, height: 63 })
  })

  it('clamps to the origin when dimensions are unknown (zero)', () => {
    expect(centeredRoi(0, 0, 64)).toEqual({ x: 0, y: 0, width: 64, height: 64 })
  })

  it('clamps to the origin when the frame is smaller than the ROI', () => {
    expect(centeredRoi(32, 720, 64)).toEqual({ x: 0, y: 328, width: 64, height: 64 })
  })
})
