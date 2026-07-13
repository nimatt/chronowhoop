// Pure formatting for the fly screen. The running clock shows tenths (the
// glanceable mid-flight precision); the lap table shows two decimals per
// product.md's session view.

import type { IsoDateString } from '../../core/domain/types'

export function formatRunningClock(elapsedMs: number): string {
  const totalTenths = Math.floor(Math.max(0, elapsedMs) / 100)
  const minutes = Math.floor(totalTenths / 600)
  const seconds = Math.floor((totalTenths % 600) / 10)
  const tenths = totalTenths % 10
  if (minutes === 0) return `${seconds}.${tenths}`
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`
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
