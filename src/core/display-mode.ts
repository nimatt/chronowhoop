export type DisplayMode = 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser' | 'unknown'

export type MatchMediaLike = (query: string) => { matches: boolean }

function defaultMatchMedia(): MatchMediaLike | undefined {
  const global = globalThis as { matchMedia?: MatchMediaLike }
  return typeof global.matchMedia === 'function' ? global.matchMedia.bind(globalThis) : undefined
}

const candidateModes = ['standalone', 'fullscreen', 'minimal-ui', 'browser'] as const

export function detectDisplayMode(
  matchMedia: MatchMediaLike | undefined = defaultMatchMedia(),
): DisplayMode {
  if (!matchMedia) return 'unknown'
  try {
    for (const mode of candidateModes) {
      if (matchMedia(`(display-mode: ${mode})`).matches) return mode
    }
  } catch {
    return 'unknown'
  }
  return 'unknown'
}
