import {
  DEFAULT_TRIGGER_SUGGESTION_CONFIG,
  TriggerLevelCollector,
} from '../../core/detection/trigger-suggest'
import type { CaptureSession } from './capture-session'

export interface TriggerCollection {
  readonly quietWindowMs: number
  readonly collecting: boolean
  readonly observedMs: number
  readonly suggestion: number | null
  readonly aborted: boolean
  start(): void
  apply(): void
}

// The suggest-trigger flow shared by the lab test-mode panel and the fly
// setup step: observe the next quietWindowMs of samples on a quiet scene,
// then offer the collector's suggestion. Must be called during component init
// — it owns two $effects (the tunables-identity abort and unmount cleanup).
export function createTriggerCollection(session: CaptureSession): TriggerCollection {
  let collecting = $state(false)
  let observedMs = $state(0)
  let suggestion = $state<number | null>(null)
  let aborted = $state(false)
  let stopCollecting: (() => void) | null = null
  // Identity snapshot of session.tunables at collection start: the session
  // replaces the object wholesale on every update (ROI included), so an
  // identity change means the observed scene's settings changed.
  let collectionTunables: unknown = null

  function start(): void {
    if (collecting || !session.captureRunning) return
    suggestion = null
    aborted = false
    observedMs = 0
    collectionTunables = session.tunables
    const collector = new TriggerLevelCollector()
    const offSamples = session.addSampleListener((sample) => collector.add(sample))
    const poll = setInterval(() => {
      observedMs = collector.observedSpanMs
      const ready = collector.suggestion
      if (ready !== undefined) {
        suggestion = ready
        stopCollecting?.()
      } else if (!session.captureRunning) {
        stopCollecting?.()
      }
    }, 200)
    stopCollecting = () => {
      offSamples()
      clearInterval(poll)
      stopCollecting = null
      collecting = false
    }
    collecting = true
  }

  function apply(): void {
    if (suggestion !== null) session.updateTunables({ triggerLevel: suggestion })
  }

  // detection.md: the collector's quiet observation resets when the scene
  // setup changes. Any tunables update mid-window (slider or ROI — both flow
  // through session.tunables) invalidates the samples already observed, so
  // abort rather than suggest from a mixed window.
  $effect(() => {
    const current = session.tunables
    if (collecting && current !== collectionTunables) {
      stopCollecting?.()
      aborted = true
    }
  })

  $effect(() => () => stopCollecting?.())

  return {
    quietWindowMs: DEFAULT_TRIGGER_SUGGESTION_CONFIG.quietWindowMs,
    get collecting() {
      return collecting
    },
    get observedMs() {
      return observedMs
    },
    get suggestion() {
      return suggestion
    },
    get aborted() {
      return aborted
    },
    start,
    apply,
  }
}
