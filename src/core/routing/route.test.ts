import { describe, expect, it } from 'vitest'
import { hashFor, isGateExempt, routeFromHash, shouldShowUnsupportedScreen, type Route } from './route'

describe('routeFromHash', () => {
  it('maps #/ and the empty hash to home', () => {
    expect(routeFromHash('#/')).toEqual({ id: 'home' })
    expect(routeFromHash('')).toEqual({ id: 'home' })
    expect(routeFromHash('#')).toEqual({ id: 'home' })
  })

  it('maps the parameterless routes', () => {
    expect(routeFromHash('#/diag')).toEqual({ id: 'diag' })
    expect(routeFromHash('#/lab')).toEqual({ id: 'lab' })
    expect(routeFromHash('#/course/new')).toEqual({ id: 'new-course' })
  })

  it('maps the parameterized routes with their id captured', () => {
    expect(routeFromHash('#/fly/abc-123')).toEqual({ id: 'fly', courseId: 'abc-123' })
    expect(routeFromHash('#/course/abc-123')).toEqual({ id: 'course', courseId: 'abc-123' })
    expect(routeFromHash('#/session/s-9')).toEqual({ id: 'session', sessionId: 's-9' })
    expect(routeFromHash('#/course/abc-123/edit')).toEqual({
      id: 'edit-course',
      courseId: 'abc-123',
    })
  })

  it('plain #/fly (no course) no longer exists', () => {
    expect(routeFromHash('#/fly')).toEqual({ id: 'home' })
  })

  it('maps unknown hashes to home', () => {
    expect(routeFromHash('#/nope')).toEqual({ id: 'home' })
    expect(routeFromHash('#garbage')).toEqual({ id: 'home' })
    expect(routeFromHash('#/diag/extra')).toEqual({ id: 'home' })
    expect(routeFromHash('#/lab/extra')).toEqual({ id: 'home' })
  })

  it('maps malformed or empty ids to home', () => {
    expect(routeFromHash('#/fly/')).toEqual({ id: 'home' })
    expect(routeFromHash('#/course/')).toEqual({ id: 'home' })
    expect(routeFromHash('#/course//edit')).toEqual({ id: 'home' })
    expect(routeFromHash('#/session/')).toEqual({ id: 'home' })
    expect(routeFromHash('#//')).toEqual({ id: 'home' })
  })

  it('maps trailing junk after an id to home', () => {
    expect(routeFromHash('#/fly/abc/extra')).toEqual({ id: 'home' })
    expect(routeFromHash('#/session/abc/extra')).toEqual({ id: 'home' })
    expect(routeFromHash('#/course/abc/nope')).toEqual({ id: 'home' })
    expect(routeFromHash('#/course/abc/edit/extra')).toEqual({ id: 'home' })
  })

  it('reserves "new" — #/course/new/edit is not an edit of a course named new', () => {
    expect(routeFromHash('#/course/new/edit')).toEqual({ id: 'home' })
  })
})

describe('hashFor', () => {
  const roundTrips: Route[] = [
    { id: 'home' },
    { id: 'diag' },
    { id: 'lab' },
    { id: 'fly', courseId: 'c-1' },
    { id: 'course', courseId: 'c-1' },
    { id: 'session', sessionId: 's-1' },
    { id: 'new-course' },
    { id: 'edit-course', courseId: 'c-1' },
  ]

  it.each(roundTrips)('round-trips $id through routeFromHash', (route) => {
    expect(routeFromHash(hashFor(route))).toEqual(route)
  })

  it('produces the documented hash forms', () => {
    expect(hashFor({ id: 'home' })).toBe('#/')
    expect(hashFor({ id: 'fly', courseId: 'c-1' })).toBe('#/fly/c-1')
    expect(hashFor({ id: 'new-course' })).toBe('#/course/new')
    expect(hashFor({ id: 'edit-course', courseId: 'c-1' })).toBe('#/course/c-1/edit')
  })
})

describe('capability gate exemption', () => {
  it('exempts diag and lab only', () => {
    expect(isGateExempt({ id: 'diag' })).toBe(true)
    expect(isGateExempt({ id: 'lab' })).toBe(true)
    expect(isGateExempt({ id: 'home' })).toBe(false)
    expect(isGateExempt({ id: 'fly', courseId: 'c-1' })).toBe(false)
    expect(isGateExempt({ id: 'course', courseId: 'c-1' })).toBe(false)
    expect(isGateExempt({ id: 'session', sessionId: 's-1' })).toBe(false)
    expect(isGateExempt({ id: 'new-course' })).toBe(false)
    expect(isGateExempt({ id: 'edit-course', courseId: 'c-1' })).toBe(false)
  })

  it('shows the unsupported screen on product routes when capabilities fail', () => {
    expect(shouldShowUnsupportedScreen(false, { id: 'home' })).toBe(true)
    expect(shouldShowUnsupportedScreen(false, { id: 'fly', courseId: 'c-1' })).toBe(true)
    expect(shouldShowUnsupportedScreen(false, { id: 'new-course' })).toBe(true)
  })

  it('never shows the unsupported screen on diag or lab', () => {
    expect(shouldShowUnsupportedScreen(false, { id: 'diag' })).toBe(false)
    expect(shouldShowUnsupportedScreen(false, { id: 'lab' })).toBe(false)
  })

  it('never shows the unsupported screen when capabilities pass', () => {
    expect(shouldShowUnsupportedScreen(true, { id: 'home' })).toBe(false)
    expect(shouldShowUnsupportedScreen(true, { id: 'diag' })).toBe(false)
  })
})
