import type { CrossingDirection } from '../../core/detection/crossing-events'

export function directionArrow(direction: CrossingDirection): string {
  return direction === 'ltr' ? '→' : '←'
}

export function directionLabel(direction: CrossingDirection): string {
  return direction === 'ltr' ? 'left → right' : 'right → left'
}

export function formatMinLap(minLapTimeMs: number): string {
  return `${(minLapTimeMs / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} s`
}
