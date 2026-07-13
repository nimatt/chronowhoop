// The ephemeral inline course behind the fly screen (no persisted courses
// until Phase 6): built fresh per test/arm from the setup fields, never
// stored.

import type { CrossingDirection } from '../../core/detection/crossing-events'
import type { Course } from '../../core/domain/types'
import type { WallClock } from '../../core/session/session-engine'

export const QUICK_SESSION_COURSE_NAME = 'Quick session'
export const DEFAULT_MIN_LAP_TIME_MS = 3000

// Lives here (plain TS) because svelte/prefer-svelte-reactivity bans raw
// `new Date()` in .svelte.ts modules; the SessionEngine clock is a plain
// wall-clock read, not reactive state.
export const wallClock: WallClock = () => new Date()

export function createQuickCourse(direction: CrossingDirection, minLapTimeMs: number): Course {
  return {
    id: crypto.randomUUID(),
    name: QUICK_SESSION_COURSE_NAME,
    direction,
    minLapTimeMs,
    createdAt: new Date().toISOString(),
  }
}
