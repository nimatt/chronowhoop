import type { CrossingDirection } from '../../core/detection/crossing-events'
import type { IsoDateString } from '../../core/domain/types'

// "1 session" / "12 sessions" — shared by Home's card meta and the delete
// screens' blast-radius copy, which must agree down to the last character.
export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

export function directionArrow(direction: CrossingDirection): string {
  return direction === 'ltr' ? '→' : '←'
}

export function directionLabel(direction: CrossingDirection): string {
  return direction === 'ltr' ? 'left → right' : 'right → left'
}

export function formatMinLap(minLapTimeMs: number): string {
  return `${(minLapTimeMs / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} s`
}

// Course-view / course-form subtitle line, mockup screen 03: "Left → Right ·
// min 3.0 s" (always one decimal on the min-lap seconds).
export function courseSubtitle(course: {
  direction: CrossingDirection
  minLapTimeMs: number
}): string {
  const direction = course.direction === 'ltr' ? 'Left → Right' : 'Right → Left'
  return `${direction} · min ${(course.minLapTimeMs / 1000).toFixed(1)} s`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "Jul 11" — the mockups' compact date for card meta lines and record tiles.
// Hand-rolled (fixed English month names) for locale-independent rendering,
// the same reasoning as fly-format's formatters.
export function formatShortDate(iso: IsoDateString): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${MONTHS[date.getMonth()]} ${String(date.getDate())}`
}

// "Jul 11 · 20:12" — session cards on the course view (mockup screen 03).
export function formatShortDateTime(iso: IsoDateString): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${formatShortDate(iso)} · ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
