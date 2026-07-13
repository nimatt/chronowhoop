// Records (product.md "Records", ADR 0004): always computed from lap data,
// never stored. Pure functions over the ordered lap lists.
//
// Decided semantics (tests pin each; see 05-flyable-timer.notes.md):
// - bestLap: minimum durationMs over status 'valid' laps. Ties: the first
//   occurrence (lowest lap index / earliest session) wins — strict `<`.
// - bestThreeConsecutive: minimum sum over every window of 3 SUCCESSIVE valid
//   laps; a discarded lap breaks consecutiveness, so windows never span one
//   (product.md). Ties: first occurrence wins.
// - courseRecords (all-time per course): best lap is the global minimum
//   across every session's valid laps; best-three windows are within-session
//   only — laps in different sessions are never consecutive, so a window
//   spanning a session boundary would be meaningless.

import type { Lap, Session } from '../domain/types'

export interface BestThreeConsecutive {
  laps: [Lap, Lap, Lap]
  totalMs: number
}

export interface Records {
  bestLap: Lap | undefined
  bestThreeConsecutive: BestThreeConsecutive | undefined
}

export function bestLap(laps: readonly Lap[]): Lap | undefined {
  let best: Lap | undefined
  for (const lap of laps) {
    if (lap.status !== 'valid') continue
    if (best === undefined || lap.durationMs < best.durationMs) best = lap
  }
  return best
}

export function bestThreeConsecutive(laps: readonly Lap[]): BestThreeConsecutive | undefined {
  let best: BestThreeConsecutive | undefined
  for (let i = 0; i + 2 < laps.length; i++) {
    const window = [laps[i], laps[i + 1], laps[i + 2]] as const
    if (!window.every((lap) => lap.status === 'valid')) continue
    const totalMs = window[0].durationMs + window[1].durationMs + window[2].durationMs
    if (best === undefined || totalMs < best.totalMs) {
      best = { laps: [...window], totalMs }
    }
  }
  return best
}

export function sessionRecords(laps: readonly Lap[]): Records {
  return { bestLap: bestLap(laps), bestThreeConsecutive: bestThreeConsecutive(laps) }
}

export function courseRecords(sessions: readonly Session[]): Records {
  let lap: Lap | undefined
  let three: BestThreeConsecutive | undefined
  for (const session of sessions) {
    const candidate = sessionRecords(session.laps)
    if (
      candidate.bestLap !== undefined &&
      (lap === undefined || candidate.bestLap.durationMs < lap.durationMs)
    ) {
      lap = candidate.bestLap
    }
    if (
      candidate.bestThreeConsecutive !== undefined &&
      (three === undefined || candidate.bestThreeConsecutive.totalMs < three.totalMs)
    ) {
      three = candidate.bestThreeConsecutive
    }
  }
  return { bestLap: lap, bestThreeConsecutive: three }
}
