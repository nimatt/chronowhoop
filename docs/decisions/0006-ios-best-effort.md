# 0006 — iOS is best-effort, not a gating platform

**Status:** accepted, 2026-07-12. Refines [0001](0001-phone-first-pwa.md).

## Context

The build plans initially treated the iOS Safari 26 camera → WebGPU → readback path as the project's existential risk, gating phases on measurements taken on both an Android and an iOS device. iOS support is in fact a nice-to-have, not a requirement.

## Decision

The supported, gating platforms are **Android Chrome (primary) and desktop Chromium**. iOS Safari 26+ is **best-effort**: probe it and keep it working when an iOS device is at hand, but no phase gates on iOS results, iOS failures trigger documentation rather than architecture pivots, and iOS-specific work items are skipped without ceremony when no device is available.

## Consequences

- Phase 2's go/no-go thresholds and pivot ladder apply to Android Chrome only; iOS measurements are recorded as informational when possible.
- Phase gates phrased "on both phones" mean "on the Android phone; on iOS additionally if available".
- iOS-specific mitigations (share-sheet export path, install-before-data banner, speech re-prime quirks, OPFS partitioning posture) remain in the plans but are best-effort scope.
- Safari's newer WebGPU support stops constraining design choices; Chromium behavior is the reference.
