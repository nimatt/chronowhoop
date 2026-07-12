// Number/error formatting for the /diag measurement tables. Undefined and
// null render as an em dash so "not measured" never looks like zero.

export function fmtNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}

export function fmtMs(value: number | null | undefined, digits = 2): string {
  const formatted = fmtNumber(value, digits)
  return formatted === '—' ? formatted : `${formatted} ms`
}

export function fmtUs(value: number | null | undefined, digits = 1): string {
  const formatted = fmtNumber(value, digits)
  return formatted === '—' ? formatted : `${formatted} µs`
}

export function fmtFps(value: number | null | undefined): string {
  const formatted = fmtNumber(value, 1)
  return formatted === '—' ? formatted : `${formatted} fps`
}

export function fmtPct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return '—'
  return `${(fraction * 100).toFixed(1)}%`
}

export function fmtBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${value} B`
}

export function fmtClock(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message
  }
  return String(error)
}
