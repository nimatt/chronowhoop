// Pure strip-energy math for the /lab visualizations. FrameSamples carry
// integer hot-pixel counts plus per-strip pixel counts; normalization (the
// division) is the consumer's job per detection.md, and a zero denominator
// (stripCount > working width leaves empty strips) normalizes to 0 rather
// than NaN.

export function normalizeEnergies(
  energies: ArrayLike<number>,
  stripPixelCounts: ArrayLike<number>,
): number[] {
  const normalized = new Array<number>(energies.length)
  for (let i = 0; i < energies.length; i++) {
    const count = stripPixelCounts[i]
    normalized[i] = count > 0 ? energies[i] / count : 0
  }
  return normalized
}

export function maxNormalizedEnergy(
  energies: ArrayLike<number>,
  stripPixelCounts: ArrayLike<number>,
): number {
  let max = 0
  for (let i = 0; i < energies.length; i++) {
    const count = stripPixelCounts[i]
    if (count > 0) max = Math.max(max, energies[i] / count)
  }
  return max
}

// Scales a value-per-frame series onto a canvas: x spreads frame indices over
// [0, width] (a single frame lands at x = 0), y maps value 0 to the bottom
// edge and value 1 to the top, clamping out-of-range values to the edges.
export function timelinePoints(
  values: readonly number[],
  width: number,
  height: number,
): Array<[number, number]> {
  const lastIndex = values.length - 1
  return values.map((value, i) => {
    const x = lastIndex > 0 ? (i / lastIndex) * width : 0
    const clamped = Math.min(1, Math.max(0, value))
    return [x, (1 - clamped) * height]
  })
}
