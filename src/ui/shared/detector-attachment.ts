// Plain-TS adapter between a capture session's sample fan-out and the
// crossing detector's attach helper — the one place the PausableFrameSource
// shim lives (previously forked across the lab test-mode panel and the fly
// session).

import {
  attachDetectorToPipeline,
  type CrossingDetector,
  type PausableFrameSource,
} from '../../core/detection/crossing-detector'
import type { CrossingEvent } from '../../core/detection/crossing-events'
import type { FrameSample } from '../../core/detection/types'

// CrossingDetector's validator rejects triggerLevel ≤ 0. The tunables slider
// min already matches, but clamp anyway: any other tunables writer reaching 0
// would otherwise throw uncaught inside a live-tracking $effect (killing the
// flush) or an arm click handler.
export const MIN_DETECTOR_TRIGGER_LEVEL = 0.01

export function detectorTriggerLevel(level: number): number {
  return Math.max(MIN_DETECTOR_TRIGGER_LEVEL, level)
}

// The capture-session slice the detector needs: the sample fan-out plus the
// EMA-pause seam — enough to satisfy PausableFrameSource without handing out
// the pipeline itself.
export interface CaptureSessionLike {
  addSampleListener(listener: (sample: FrameSample) => void): () => void
  setPipelinePause(paused: boolean): void
}

// Subscribes the detector to the session's (already running) sample stream —
// start() subscribes instead of starting the pipeline, setPause forwards to
// it. Returns a detach that unsubscribes AND un-pauses: the detector may have
// left the EMA paused mid-candidate.
export function attachDetectorToCaptureSession(
  session: CaptureSessionLike,
  detector: CrossingDetector,
  onCrossing: (event: CrossingEvent) => void,
): () => void {
  let unsubscribe: (() => void) | null = null
  const source: PausableFrameSource = {
    start(onSample) {
      unsubscribe = session.addSampleListener(onSample)
    },
    stop() {
      unsubscribe?.()
      unsubscribe = null
    },
    setPause(paused) {
      session.setPipelinePause(paused)
    },
  }
  attachDetectorToPipeline(source, detector, onCrossing)
  return () => {
    source.stop()
    session.setPipelinePause(false)
  }
}
