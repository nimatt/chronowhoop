// Per-frame strip-energy bar rendering for the CPU-pipeline panels. Called
// from frame callbacks and draws straight to the canvas — per-frame data
// never goes through reactive state (roadmap per-frame rule).
export function drawStripBars(
  canvas: HTMLCanvasElement | null,
  energies: readonly number[],
  workingPixels: number,
): void {
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx || energies.length === 0) return
  const capacity = workingPixels / energies.length
  const barWidth = canvas.width / energies.length
  ctx.fillStyle = '#16233c'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#7ea6ff'
  energies.forEach((energy, i) => {
    const h = capacity > 0 ? Math.min(1, energy / capacity) * canvas.height : 0
    ctx.fillRect(i * barWidth + 1, canvas.height - h, barWidth - 2, h)
  })
}
