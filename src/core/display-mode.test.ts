import { describe, expect, it } from 'vitest'
import { detectDisplayMode, type MatchMediaLike } from './display-mode'

function matchMediaMatching(matchingQuery: string): MatchMediaLike {
  return (query) => ({ matches: query === matchingQuery })
}

describe('detectDisplayMode', () => {
  it('detects standalone', () => {
    expect(detectDisplayMode(matchMediaMatching('(display-mode: standalone)'))).toBe('standalone')
  })

  it('detects a browser tab', () => {
    expect(detectDisplayMode(matchMediaMatching('(display-mode: browser)'))).toBe('browser')
  })

  it('prefers standalone over browser when both would match', () => {
    expect(detectDisplayMode(() => ({ matches: true }))).toBe('standalone')
  })

  it('reports unknown when nothing matches', () => {
    expect(detectDisplayMode(() => ({ matches: false }))).toBe('unknown')
  })

  it('reports unknown when matchMedia is unavailable', () => {
    expect(detectDisplayMode(undefined)).toBe('unknown')
  })

  it('reports unknown when matchMedia throws', () => {
    expect(
      detectDisplayMode(() => {
        throw new Error('bad query')
      }),
    ).toBe('unknown')
  })
})
