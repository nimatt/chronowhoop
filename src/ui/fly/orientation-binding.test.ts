import { describe, expect, it } from 'vitest'
import {
  orientationEffect,
  orientationFromPortraitMatch,
  type OrientationBinding,
} from './orientation-binding'

const bound = (mismatch: boolean): OrientationBinding => ({ bound: 'portrait', mismatch })

describe('orientationFromPortraitMatch', () => {
  it('maps the (orientation: portrait) match to the orientation name', () => {
    expect(orientationFromPortraitMatch(true)).toBe('portrait')
    expect(orientationFromPortraitMatch(false)).toBe('landscape')
  })
})

describe('orientationEffect', () => {
  it('is inert while unbound (camera not running)', () => {
    expect(orientationEffect(null, 'portrait')).toBe('none')
    expect(orientationEffect(null, 'landscape')).toBe('none')
  })

  it('invalidates on leaving the bound orientation', () => {
    expect(orientationEffect(bound(false), 'landscape')).toBe('invalidate')
  })

  it('staying in the bound orientation is a no-op', () => {
    expect(orientationEffect(bound(false), 'portrait')).toBe('none')
  })

  it('repeated change events while already mismatched do not re-invalidate', () => {
    expect(orientationEffect(bound(true), 'landscape')).toBe('none')
  })

  it('restores exactly when a mismatched binding sees the bound orientation again', () => {
    expect(orientationEffect(bound(true), 'portrait')).toBe('restore')
  })

  it('works symmetrically for a landscape binding', () => {
    const landscapeBound: OrientationBinding = { bound: 'landscape', mismatch: false }
    expect(orientationEffect(landscapeBound, 'portrait')).toBe('invalidate')
    expect(orientationEffect({ ...landscapeBound, mismatch: true }, 'landscape')).toBe('restore')
  })
})
