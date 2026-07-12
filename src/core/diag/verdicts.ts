// Go/no-go verdict logic for the /diag measurement panels. These are the
// device spike's kill/pivot thresholds (ADR 0008, declared before
// measurement) rendered as PASS/FAIL chips during the one-shot on-device
// session — a flipped comparison would silently misreport the go/no-go, so
// the boundary semantics live here as pure functions and are pinned by unit
// tests. Panels render the returned verdict only.

export type DiagVerdict = 'pass' | 'warn' | 'fail' | 'na'

// ADR 0008's declared 2 % measurement tolerance on the fps thresholds
// (pass ≥ 58.8, degraded ≥ 29.4): real cameras grant NTSC rates (59.94 fps)
// that plainly meet intent. The recorded number is always the raw measured
// fps; only the verdict is tolerant.
const FPS_TOLERANCE = 0.98

// ≥ 60 pass, ≥ 30 degraded (ADR 0003's ±1-frame claim widens to ~33 ms),
// else fail — thresholds inclusive after tolerance.
export function fpsVerdict(measuredFps: number | undefined): DiagVerdict {
  if (measuredFps === undefined) return 'na'
  if (measuredFps >= 60 * FPS_TOLERANCE) return 'pass'
  if (measuredFps >= 30 * FPS_TOLERANCE) return 'warn'
  return 'fail'
}

// Timestamp-source gate: jitter stddev ≤ ½ × median delta, inclusive —
// exactly ½ passes (the threshold is declared as "≤ ~½ frame interval", and
// ADR 0008 already notes the successive-delta stddev overstates per-timestamp
// noise by ~√2, so the boundary leans lenient).
export function jitterVerdict(source: {
  jitterStddevMs: number | undefined
  medianDeltaMs: number | undefined
}): DiagVerdict {
  if (source.jitterStddevMs === undefined || source.medianDeltaMs === undefined) return 'na'
  return source.jitterStddevMs <= 0.5 * source.medianDeltaMs ? 'pass' : 'fail'
}

// The latency gate compares against the frame interval at the granted rate;
// before the frame-loop panel has measured, 60 fps is assumed (the panel
// labels the assumption next to the gate).
export const ASSUMED_FPS = 60

export function frameIntervalForFps(measuredFps: number | null): number {
  return 1000 / (measuredFps ?? ASSUMED_FPS)
}

// ADR 0008 gates BOTH median and p95 readback latency ≤ one frame interval
// (inclusive) — a good median with a blown p95 is not a pass.
export function latencyVerdict(
  stats: { medianMs: number; p95Ms: number } | undefined,
  frameIntervalMs: number,
): DiagVerdict {
  if (stats === undefined) return 'na'
  return Math.max(stats.medianMs, stats.p95Ms) <= frameIntervalMs ? 'pass' : 'fail'
}
