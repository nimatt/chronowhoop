// Canvas rendering for the shared (lab + fly) energy views. Called from frame callbacks —
// per-frame data draws straight to the canvas, never through reactive state
// (the UI bridge rule, plan 03 item 11).

import { drawStripBars } from '../diag/strip-bars'
import { timelinePoints } from './energy-math'

const TRIGGER_COLOR = '#ffd27e'

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function drawTriggerLine(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  triggerLevel: number,
): void {
  const y = (1 - clamp01(triggerLevel)) * canvas.height
  ctx.strokeStyle = TRIGGER_COLOR
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, y)
  ctx.lineTo(canvas.width, y)
  ctx.stroke()
}

// Strip bars over NORMALIZED energies (0–1, count / strip pixel count) with a
// horizontal trigger-level line. Passing `energies.length` as the working
// pixel count makes drawStripBars' per-strip capacity exactly 1, so the bar
// heights are the normalized values themselves — a wrapper, not a fork.
// hudText (frames seen, rolling fps) renders onto the canvas too: canvas is
// the per-frame channel, so the readout never touches reactive state OR the
// DOM tree.
export function drawNormalizedStripBars(
  canvas: HTMLCanvasElement | null,
  normalizedEnergies: readonly number[],
  triggerLevel: number,
  hudText?: string,
): void {
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  drawStripBars(canvas, normalizedEnergies, normalizedEnergies.length)
  drawTriggerLine(canvas, ctx, triggerLevel)
  if (hudText !== undefined) {
    ctx.font = '12px monospace'
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#e8edf7'
    ctx.fillText(hudText, 4, 4)
  }
}

// Replay timeline: x = frame index, y = max normalized strip energy, with the
// trigger line for eyeballing signal-to-noise of a recorded pass.
export function drawEnergyTimeline(
  canvas: HTMLCanvasElement | null,
  maxEnergyPerFrame: readonly number[],
  triggerLevel: number,
): void {
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  ctx.fillStyle = '#16233c'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const points = timelinePoints(maxEnergyPerFrame, canvas.width, canvas.height)
  if (points.length > 0) {
    ctx.strokeStyle = '#7ea6ff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    points.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
  drawTriggerLine(canvas, ctx, triggerLevel)
}
