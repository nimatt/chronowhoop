// Deterministic trigger-level auto-suggestion (plan 04 item 6), replacing
// detection.md's former "auto-suggested" hand-wave: observe normalized
// per-strip energies over a quiet window of at least quietWindowMs, take the
// 95th percentile (nearest-rank over every strip-level observed), multiply by
// marginFactor, clamp to [TRIGGER_SUGGESTION_MIN, TRIGGER_SUGGESTION_MAX].
// Spec: detection.md "Trigger-level auto-suggestion".

import type { FrameSample } from './types'

export interface TriggerSuggestionConfig {
  // Minimum capture-time span (ms) of quiet observation before a suggestion
  // is available.
  quietWindowMs: number
  // Multiplied onto the noise percentile to sit safely above the floor.
  marginFactor: number
}

export const DEFAULT_TRIGGER_SUGGESTION_CONFIG: TriggerSuggestionConfig = {
  quietWindowMs: 3000,
  marginFactor: 3,
}

const QUIET_NOISE_PERCENTILE = 0.95
export const TRIGGER_SUGGESTION_MIN = 0.02
export const TRIGGER_SUGGESTION_MAX = 0.5

// Incremental collector for live setup use: feed every FrameSample captured
// while the scene is quiet; `suggestion` becomes available once the observed
// capture-time span reaches quietWindowMs and keeps refining as samples
// accumulate. Observations grow without bound while fed (~strips × fps
// numbers per second), so callers stop feeding — or reset() — when the quiet
// observation phase ends or the scene/ROI changes.
export class TriggerLevelCollector {
  #config: TriggerSuggestionConfig
  #levels: number[] = []
  #firstTimeMs: number | undefined
  #lastTimeMs: number | undefined

  constructor(config: Partial<TriggerSuggestionConfig> = {}) {
    this.#config = { ...DEFAULT_TRIGGER_SUGGESTION_CONFIG, ...config }
    if (!(this.#config.quietWindowMs > 0)) {
      throw new Error(`quietWindowMs must be > 0, got ${this.#config.quietWindowMs}`)
    }
    if (!(this.#config.marginFactor > 0)) {
      throw new Error(`marginFactor must be > 0, got ${this.#config.marginFactor}`)
    }
  }

  add(sample: FrameSample): void {
    const n = sample.energies.length
    for (let i = 0; i < n; i++) {
      const pixels = sample.stripPixelCounts[i]
      if (pixels === 0) continue
      this.#levels.push(sample.energies[i] / pixels)
    }
    this.#firstTimeMs ??= sample.captureTimeMs
    this.#lastTimeMs = sample.captureTimeMs
  }

  get observedSpanMs(): number {
    if (this.#firstTimeMs === undefined || this.#lastTimeMs === undefined) return 0
    return this.#lastTimeMs - this.#firstTimeMs
  }

  get ready(): boolean {
    return this.#levels.length > 0 && this.observedSpanMs >= this.#config.quietWindowMs
  }

  get suggestion(): number | undefined {
    if (!this.ready) return undefined
    const sorted = [...this.#levels].sort((a, b) => a - b)
    const rank = Math.max(0, Math.ceil(QUIET_NOISE_PERCENTILE * sorted.length) - 1)
    const suggested = sorted[rank] * this.#config.marginFactor
    return Math.min(TRIGGER_SUGGESTION_MAX, Math.max(TRIGGER_SUGGESTION_MIN, suggested))
  }

  reset(): void {
    this.#levels = []
    this.#firstTimeMs = undefined
    this.#lastTimeMs = undefined
  }
}

// Pure form over a recorded quiet window (fixtures, replay). Returns
// undefined when the samples span less than quietWindowMs of capture time.
export function suggestTriggerLevel(
  samples: readonly FrameSample[],
  config: Partial<TriggerSuggestionConfig> = {},
): number | undefined {
  const collector = new TriggerLevelCollector(config)
  for (const sample of samples) collector.add(sample)
  return collector.suggestion
}
