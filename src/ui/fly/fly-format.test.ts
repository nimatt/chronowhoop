import { describe, expect, it } from 'vitest'
import { formatLapSeconds, formatRunningClock, formatTimeOfDay } from './fly-format'

describe('formatRunningClock', () => {
  it('shows ss.hh under a minute, seconds zero-padded (mockup "08.42")', () => {
    expect(formatRunningClock(0)).toBe('00.00')
    expect(formatRunningClock(8420)).toBe('08.42')
    expect(formatRunningClock(14320)).toBe('14.32')
    expect(formatRunningClock(59999)).toBe('59.99')
  })

  it('truncates to the elapsed hundredth (a lap is not over until it is)', () => {
    expect(formatRunningClock(14329)).toBe('14.32')
  })

  it('switches to m:ss.hh at one minute', () => {
    expect(formatRunningClock(60000)).toBe('1:00.00')
    expect(formatRunningClock(74320)).toBe('1:14.32')
    expect(formatRunningClock(600000)).toBe('10:00.00')
  })

  it('clamps negative elapsed (clock-base race) to zero', () => {
    expect(formatRunningClock(-50)).toBe('00.00')
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
