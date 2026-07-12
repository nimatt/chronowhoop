import { describe, expect, it } from 'vitest'
import { timestampedFilename } from './filenames'

describe('timestampedFilename', () => {
  it('formats local time, colon-free, with zero padding', () => {
    const date = new Date(2026, 6, 13, 9, 5, 7)
    expect(timestampedFilename('clip', 'cwclip', date)).toBe('clip-2026-07-13T09-05-07.cwclip')
  })

  it('carries any prefix and extension', () => {
    const date = new Date(2026, 11, 31, 23, 59, 59)
    expect(timestampedFilename('energy', 'json', date)).toBe('energy-2026-12-31T23-59-59.json')
  })
})
