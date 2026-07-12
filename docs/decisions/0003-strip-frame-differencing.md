# 0003 — Detection: frame differencing + strip motion energy

**Status:** accepted, 2026-07-12

## Context

Alternatives considered: two-zone diff (coarse direction, false-positive prone), dense optical flow (heavy, unreliable on tiny motion-blurred drones), ML object detection (needs training data, latency, overkill).

## Decision

Maintain an exponential-moving-average background model of the ROI; per frame, threshold the diff and reduce to motion energy per vertical strip (default 12). A crossing is a motion wave traversing the strips; direction falls out of traversal order. GPU reduces, CPU decides. Accepted accuracy: ±1 camera frame, timestamped with frame capture time — consistent bias cancels between laps.

## Consequences

- Robust to gradual lighting drift; abrupt lighting changes need brief re-adaptation.
- Direction filtering + minimum lap time debounce handle most false triggers; discard-last-lap covers the rest.
- The CPU state machine is testable with recorded strip-energy fixtures, no camera or GPU needed.
