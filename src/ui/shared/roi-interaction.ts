// Pure drag/resize math for the shared ROI overlay (plan 03 item 10; used by
// the lab and fly calibration screens alike). Everything is in
// coordinates normalized to the preview: the component converts pointer
// pixels via getBoundingClientRect and stays thin wiring.

import type { NormalizedRect } from '../../core/detection/types'

// Smallest ROI edge, normalized. Small enough for a tight gate crop, large
// enough that the corner handles never overlap into an ungrabbable rect.
export const MIN_ROI_SIZE = 0.05

export type RoiHandle = 'nw' | 'ne' | 'sw' | 'se' | 'move'

// Per-axis hit tolerance, normalized (the component derives it from a pixel
// radius so a corner is equally grabbable on any preview aspect).
export interface HitTolerance {
  x: number
  y: number
}

const CORNERS: Array<{ handle: Exclude<RoiHandle, 'move'>; cx: 0 | 1; cy: 0 | 1 }> = [
  { handle: 'nw', cx: 0, cy: 0 },
  { handle: 'ne', cx: 1, cy: 0 },
  { handle: 'sw', cx: 0, cy: 1 },
  { handle: 'se', cx: 1, cy: 1 },
]

// Corners win over the interior so a small rect is still resizable; outside
// the rect (and all corner zones) is null.
export function hitTestRoi(
  rect: NormalizedRect,
  x: number,
  y: number,
  tolerance: HitTolerance,
): RoiHandle | null {
  for (const { handle, cx, cy } of CORNERS) {
    const cornerX = rect.x + cx * rect.width
    const cornerY = rect.y + cy * rect.height
    if (Math.abs(x - cornerX) <= tolerance.x && Math.abs(y - cornerY) <= tolerance.y) {
      return handle
    }
  }
  const inside =
    x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
  return inside ? 'move' : null
}

export interface RoiDrag {
  handle: RoiHandle
  startRect: NormalizedRect
  startX: number
  startY: number
}

export function beginRoiDrag(
  rect: NormalizedRect,
  handle: RoiHandle,
  x: number,
  y: number,
): RoiDrag {
  return { handle, startRect: { ...rect }, startX: x, startY: y }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}

// Pointer at (x, y) → new rect. Move keeps the size and clamps the position
// into [0, 1]; a corner drag moves that corner's two edges, each clamped to
// [0, 1] and to MIN_ROI_SIZE away from its opposite edge (no inversion, no
// handle crossover). Given an input rect that satisfies the min size, the
// output always does too.
export function dragRoi(drag: RoiDrag, x: number, y: number): NormalizedRect {
  const dx = x - drag.startX
  const dy = y - drag.startY
  const r = drag.startRect
  if (drag.handle === 'move') {
    return {
      x: clamp(r.x + dx, 0, 1 - r.width),
      y: clamp(r.y + dy, 0, 1 - r.height),
      width: r.width,
      height: r.height,
    }
  }
  let left = r.x
  let right = r.x + r.width
  let top = r.y
  let bottom = r.y + r.height
  if (drag.handle === 'nw' || drag.handle === 'sw') left = clamp(left + dx, 0, right - MIN_ROI_SIZE)
  if (drag.handle === 'ne' || drag.handle === 'se') right = clamp(right + dx, left + MIN_ROI_SIZE, 1)
  if (drag.handle === 'nw' || drag.handle === 'ne') top = clamp(top + dy, 0, bottom - MIN_ROI_SIZE)
  if (drag.handle === 'sw' || drag.handle === 'se') bottom = clamp(bottom + dy, top + MIN_ROI_SIZE, 1)
  return { x: left, y: top, width: right - left, height: bottom - top }
}
