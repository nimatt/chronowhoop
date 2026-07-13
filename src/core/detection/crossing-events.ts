// The detector→session contract (plan 04 items 1–2): one event per detected
// gate crossing. `timestampMs` is the capture time of the frame where the
// wave's leading edge first reached the ROI's center boundary (detection.md
// "Crossing detector"). Direction is canonical strip-index order: `ltr` means
// the wave advanced from the strip-0 side toward strip N−1 — mirrored cameras
// are handled by the course's direction choice, and the Phase 3 orientation
// binding invalidates detection on rotation, so indices never remap.

export type CrossingDirection = 'ltr' | 'rtl'

export interface CrossingEvent {
  timestampMs: number
  direction: CrossingDirection
}
