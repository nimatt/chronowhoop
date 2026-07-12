import { describe, expect, it } from 'vitest'
import { isGateExempt, routeFromHash, shouldShowUnsupportedScreen } from './route'

describe('routeFromHash', () => {
  it('maps #/ to home', () => {
    expect(routeFromHash('#/')).toBe('home')
  })

  it('maps an empty hash to home', () => {
    expect(routeFromHash('')).toBe('home')
  })

  it('maps #/diag to diag', () => {
    expect(routeFromHash('#/diag')).toBe('diag')
  })

  it('maps #/lab to lab', () => {
    expect(routeFromHash('#/lab')).toBe('lab')
  })

  it('maps unknown hashes to home', () => {
    expect(routeFromHash('#/nope')).toBe('home')
    expect(routeFromHash('#garbage')).toBe('home')
    expect(routeFromHash('#/diag/extra')).toBe('home')
  })
})

describe('capability gate exemption', () => {
  it('exempts diag and lab, not home', () => {
    expect(isGateExempt('diag')).toBe(true)
    expect(isGateExempt('lab')).toBe(true)
    expect(isGateExempt('home')).toBe(false)
  })

  it('shows the unsupported screen on home when capabilities fail', () => {
    expect(shouldShowUnsupportedScreen(false, 'home')).toBe(true)
  })

  it('never shows the unsupported screen on diag or lab', () => {
    expect(shouldShowUnsupportedScreen(false, 'diag')).toBe(false)
    expect(shouldShowUnsupportedScreen(false, 'lab')).toBe(false)
  })

  it('never shows the unsupported screen when capabilities pass', () => {
    expect(shouldShowUnsupportedScreen(true, 'home')).toBe(false)
    expect(shouldShowUnsupportedScreen(true, 'diag')).toBe(false)
  })
})
