import { describe, expect, it } from 'vitest'
import type { NormalizedRect } from '../../core/detection/types'
import { beginRoiDrag, dragRoi, hitTestRoi, MIN_ROI_SIZE } from './roi-interaction'

const rect: NormalizedRect = { x: 0.2, y: 0.3, width: 0.4, height: 0.2 }
const tolerance = { x: 0.03, y: 0.05 }

describe('hitTestRoi', () => {
  it('hits each corner within tolerance', () => {
    expect(hitTestRoi(rect, 0.21, 0.32, tolerance)).toBe('nw')
    expect(hitTestRoi(rect, 0.59, 0.28, tolerance)).toBe('ne')
    expect(hitTestRoi(rect, 0.18, 0.51, tolerance)).toBe('sw')
    expect(hitTestRoi(rect, 0.62, 0.53, tolerance)).toBe('se')
  })

  it('corners win over the interior', () => {
    expect(hitTestRoi(rect, rect.x + 0.01, rect.y + 0.01, tolerance)).toBe('nw')
  })

  it('inside (away from corners) is move', () => {
    expect(hitTestRoi(rect, 0.4, 0.4, tolerance)).toBe('move')
  })

  it('outside is null', () => {
    expect(hitTestRoi(rect, 0.1, 0.1, tolerance)).toBeNull()
    expect(hitTestRoi(rect, 0.9, 0.9, tolerance)).toBeNull()
    expect(hitTestRoi(rect, 0.4, 0.1, tolerance)).toBeNull()
  })

  it('tolerance is per-axis', () => {
    expect(hitTestRoi(rect, rect.x - 0.029, rect.y - 0.049, tolerance)).toBe('nw')
    expect(hitTestRoi(rect, rect.x - 0.031, rect.y - 0.049, tolerance)).toBeNull()
    expect(hitTestRoi(rect, rect.x - 0.029, rect.y - 0.051, tolerance)).toBeNull()
  })
})

describe('dragRoi — move', () => {
  it('translates the rect keeping its size', () => {
    const drag = beginRoiDrag(rect, 'move', 0.4, 0.4)
    expect(dragRoi(drag, 0.5, 0.45)).toEqual({ x: 0.3, y: 0.35, width: 0.4, height: 0.2 })
  })

  it('clamps the position so the rect stays inside [0, 1]', () => {
    const drag = beginRoiDrag(rect, 'move', 0.4, 0.4)
    expect(dragRoi(drag, -2, -2)).toEqual({ x: 0, y: 0, width: 0.4, height: 0.2 })
    expect(dragRoi(drag, 3, 3)).toEqual({ x: 0.6, y: 0.8, width: 0.4, height: 0.2 })
  })
})

describe('dragRoi — corner resize', () => {
  it('se drags the right and bottom edges', () => {
    const drag = beginRoiDrag(rect, 'se', 0.6, 0.5)
    const next = dragRoi(drag, 0.7, 0.6)
    expect(next.x).toBeCloseTo(0.2)
    expect(next.y).toBeCloseTo(0.3)
    expect(next.width).toBeCloseTo(0.5)
    expect(next.height).toBeCloseTo(0.3)
  })

  it('nw drags the left and top edges', () => {
    const drag = beginRoiDrag(rect, 'nw', 0.2, 0.3)
    const next = dragRoi(drag, 0.1, 0.2)
    expect(next.x).toBeCloseTo(0.1)
    expect(next.y).toBeCloseTo(0.2)
    expect(next.width).toBeCloseTo(0.5)
    expect(next.height).toBeCloseTo(0.3)
  })

  it('clamps edges to [0, 1]', () => {
    const drag = beginRoiDrag(rect, 'se', 0.6, 0.5)
    const next = dragRoi(drag, 2, 2)
    expect(next.x + next.width).toBeCloseTo(1)
    expect(next.y + next.height).toBeCloseTo(1)
  })

  it('never shrinks below MIN_ROI_SIZE and never inverts on crossover', () => {
    const drag = beginRoiDrag(rect, 'se', 0.6, 0.5)
    const next = dragRoi(drag, -1, -1)
    expect(next.width).toBeCloseTo(MIN_ROI_SIZE)
    expect(next.height).toBeCloseTo(MIN_ROI_SIZE)
    expect(next.x).toBeCloseTo(rect.x)
    expect(next.y).toBeCloseTo(rect.y)
  })

  it('ne moves only the right and top edges', () => {
    const drag = beginRoiDrag(rect, 'ne', 0.6, 0.3)
    const next = dragRoi(drag, 0.65, 0.25)
    expect(next.x).toBeCloseTo(rect.x)
    expect(next.y).toBeCloseTo(0.25)
    expect(next.width).toBeCloseTo(0.45)
    expect(next.height).toBeCloseTo(0.25)
  })

  it('sw moves only the left and bottom edges', () => {
    const drag = beginRoiDrag(rect, 'sw', 0.2, 0.5)
    const next = dragRoi(drag, 0.25, 0.55)
    expect(next.x).toBeCloseTo(0.25)
    expect(next.y).toBeCloseTo(rect.y)
    expect(next.width).toBeCloseTo(0.35)
    expect(next.height).toBeCloseTo(0.25)
  })

  it('is stateless in the pointer path: only the latest point matters', () => {
    const drag = beginRoiDrag(rect, 'se', 0.6, 0.5)
    void dragRoi(drag, -5, -5)
    const next = dragRoi(drag, 0.7, 0.6)
    expect(next.width).toBeCloseTo(0.5)
    expect(next.height).toBeCloseTo(0.3)
  })
})
