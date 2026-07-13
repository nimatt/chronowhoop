// Per-frame strip-energy bar rendering for the CPU-pipeline panels. Called
// from frame callbacks and draws straight to the canvas — per-frame data
// never goes through reactive state (roadmap per-frame rule).
//
// Colors mirror the mockup meter (canvas can't read CSS custom properties):
// --c-panel ground, --c-signal / --c-signal-dim bars — cyan is the "live
// sensor data" color role.
const PANEL_BG = '#131922'
const BAR_HOT = '#33decf'
const BAR_DIM = 'rgba(24, 95, 90, 0.5)'
const BAR_UNIFORM = 'rgba(51, 222, 207, 0.8)'

// With `hotThreshold` (a 0–1 fraction of per-strip capacity — the trigger
// level for normalized energies), bars at or above it draw hot cyan and the
// rest dim, per the mockup's .bar / .bar.hot two-tone. Without it (diag
// panels, no trigger concept) all bars draw uniform cyan at slight alpha.
export function drawStripBars(
  canvas: HTMLCanvasElement | null,
  energies: readonly number[],
  workingPixels: number,
  hotThreshold?: number,
): void {
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx || energies.length === 0) return
  const capacity = workingPixels / energies.length
  const barWidth = canvas.width / energies.length
  ctx.fillStyle = PANEL_BG
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  energies.forEach((energy, i) => {
    const level = capacity > 0 ? Math.min(1, energy / capacity) : 0
    ctx.fillStyle =
      hotThreshold === undefined ? BAR_UNIFORM : level >= hotThreshold ? BAR_HOT : BAR_DIM
    ctx.fillRect(i * barWidth + 1, canvas.height - level * canvas.height, barWidth - 2, level * canvas.height)
  })
}
