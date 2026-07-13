import { describe, expect, it } from 'vitest'
import { recTileValue } from './rec-format'

describe('recTileValue', () => {
  it('formats milliseconds as seconds with two decimals and the s unit', () => {
    expect(recTileValue(12840)).toEqual({ text: '12.84', unit: 's' })
    expect(recTileValue(39300)).toEqual({ text: '39.30', unit: 's' })
  })

  it('keeps two decimals at the extremes', () => {
    expect(recTileValue(0)).toEqual({ text: '0.00', unit: 's' })
    expect(recTileValue(9999)).toEqual({ text: '10.00', unit: 's' })
    expect(recTileValue(61550)).toEqual({ text: '61.55', unit: 's' })
  })

  it('renders an absent record as a bare em dash', () => {
    expect(recTileValue(undefined)).toEqual({ text: '—' })
  })
})
