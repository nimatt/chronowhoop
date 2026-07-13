// Record-tile value formatting (mockup .rec .v): seconds to two decimals with
// a small trailing unit, or a bare em dash when the record doesn't exist yet.

import { formatLapSeconds } from '../fly/fly-format'

export type RecTileValue = { text: string; unit: 's' } | { text: '—'; unit?: undefined }

export function recTileValue(ms: number | undefined): RecTileValue {
  if (ms === undefined) return { text: '—' }
  return { text: formatLapSeconds(ms), unit: 's' }
}
