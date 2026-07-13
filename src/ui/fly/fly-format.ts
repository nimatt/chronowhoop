// Pure formatting for the fly screen. The running clock shows hundredths with
// two-digit seconds ("08.42", mockup 06) — the same precision as lap
// durations; the lap table shows two decimals per product.md's session view.

import type { IsoDateString } from '../../core/domain/types'

export function formatRunningClock(elapsedMs: number): string {
  const totalHundredths = Math.floor(Math.max(0, elapsedMs) / 10)
  const minutes = Math.floor(totalHundredths / 6000)
  const seconds = Math.floor((totalHundredths % 6000) / 100)
  const hundredths = totalHundredths % 100
  const ssHh = `${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
  return minutes === 0 ? ssHh : `${minutes}:${ssHh}`
}

export function formatLapSeconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(2)
}

// Local time of day, HH:MM:SS — hand-rolled so the rendering is
// locale-independent (toLocaleTimeString varies across environments).
export function formatTimeOfDay(completedAt: IsoDateString): string {
  const date = new Date(completedAt)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// Local date + time to the minute (session headers and lists), hand-rolled
// for the same locale-independence reason.
export function formatDateTime(iso: IsoDateString): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
