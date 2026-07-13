// The Course/Session/Lap shapes from docs/specs/storage.md, verbatim (plan 04
// item 7): defined here with no persistence attached, so the shapes Phase 5
// field-validates are the shapes Phase 6 freezes. Deliberately absent until
// Phase 6's schema freeze: the `schemaVersion` file envelopes and any
// migration machinery.

import type { CrossingDetectorConfig } from '../detection/crossing-detector'
import type { CrossingDirection } from '../detection/crossing-events'
import type { DetectionTunables } from '../detection/types'

// Dates are ISO 8601 strings, exactly as they appear in the JSON files —
// domain objects serialize without conversion.
export type IsoDateString = string

export interface Course {
  id: string
  name: string
  // Which strip-traversal direction through the gate counts.
  direction: CrossingDirection
  minLapTimeMs: number
  createdAt: IsoDateString
}

// The full detection snapshot stored per session: the pipeline tunables plus
// the crossing-detector config, composed at the session layer (the detector
// config stays out of DetectionTunables so energy-JSON fixtures don't widen).
// Phase 6's schema freeze validates this exact shape.
export interface SessionDetectionConfig {
  tunables: DetectionTunables
  detector: CrossingDetectorConfig
}

export interface Session {
  id: string
  courseId: string
  startedAt: IsoDateString
  note: string
  // Snapshot of the detection config actually used (storage.md).
  detectionConfig: SessionDetectionConfig
  laps: Lap[]
}

export interface Lap {
  // Sequential from 1, counting every lap including later-discarded ones.
  n: number
  // From crossing timestamps (capture-time domain); completedAt is wall-clock
  // display metadata.
  durationMs: number
  completedAt: IsoDateString
  status: 'valid' | 'discarded'
}
