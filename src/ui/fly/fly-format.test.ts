import { describe, expect, it } from 'vitest'
import { formatLapSeconds, formatRunningClock, formatTimeOfDay } from './fly-format'

describe('formatRunningClock', () => {
  it('shows seconds.tenths under a minute', () => {
    expect(formatRunningClock(0)).toBe('0.0')
    expect(formatRunningClock(14320)).toBe('14.3')
    expect(formatRunningClock(59999)).toBe('59.9')
  })

  it('truncates to the elapsed tenth (a lap is not over until it is)', () => {
    expect(formatRunningClock(14399)).toBe('14.3')
  })

  it('switches to m:ss.t at one minute', () => {
    expect(formatRunningClock(60000)).toBe('1:00.0')
    expect(formatRunningClock(74320)).toBe('1:14.3')
    expect(formatRunningClock(600000)).toBe('10:00.0')
  })

  it('clamps negative elapsed (clock-base race) to zero', () => {
    expect(formatRunningClock(-50)).toBe('0.0')
  })
})

describe('formatLapSeconds', () => {
  it('renders two decimals per product.md', () => {
    expect(formatLapSeconds(14320)).toBe('14.32')
    expect(formatLapSeconds(13333)).toBe('13.33')
    expect(formatLapSeconds(3000)).toBe('3.00')
  })
})

describe('formatTimeOfDay', () => {
  it('renders local HH:MM:SS from an ISO timestamp', () => {
    const local = new Date(2026, 6, 13, 9, 5, 7)
    expect(formatTimeOfDay(local.toISOString())).toBe('09:05:07')
  })

  it('renders an em dash for an unparseable timestamp', () => {
    expect(formatTimeOfDay('not-a-date')).toBe('—')
  })
})
