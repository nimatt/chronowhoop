# 0002 — WebGPU is a hard requirement, no fallback pipeline

**Status:** accepted, 2026-07-12

## Context

Frame-differencing a small ROI is light enough that a CPU/Canvas2D path could work; WebGPU is partly a deliberate technology choice. A fallback would mean implementing the same algorithm twice (WGSL + TS) with double the test surface and risk of behavioral drift.

## Decision

One pipeline, WebGPU only. Startup performs a capability check (WebGPU, camera, OPFS, speech synthesis) and shows an explanatory unsupported-browser screen listing supported browsers.

## Consequences

- Firefox and pre-Safari-26 devices are excluded.
- The GPU stage stays decision-free (per-strip reduction only) so all logic remains CPU-side and unit-testable despite the GPU dependency — see `docs/specs/detection.md`.
