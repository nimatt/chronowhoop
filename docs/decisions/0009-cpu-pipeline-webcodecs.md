# 0009 — CPU detection pipeline over WebCodecs capture

**Status:** accepted, 2026-07-12. **Supersedes [0002](0002-webgpu-hard-requirement.md)** (WebGPU hard requirement). Leaves [0003](0003-strip-frame-differencing.md)'s algorithm (EMA background, strip motion energy, GPU-reduces/CPU-decides layering) intact — only the substrate executing the reduction changes.

## Context

The required target device — Samsung Galaxy S22, Exynos 2200 / Xclipse 920, Android 16, Chrome 150 — serves **no stock WebGPU adapter, core or compatibility**, in Chrome or Samsung Internet ([0008](0008-device-matrix.md), measured 2026-07-12). Only `enable-unsafe-webgpu` yields one, which cannot be the basis of the product's capability gate. This engaged the Phase 2 pivot ladder's final rung exactly as pre-declared.

The workload never needed WebGPU-scale compute: at the ~256 px working width [0003] already chose, the per-frame reduction is ~35 k pixels of luminance/EMA/threshold/strip-sum arithmetic. Two capture routes into CPU memory were measured on the S22 (`/diag` CPU-pipeline panels, thresholds pre-declared in 0008):

- **Canvas route** (`drawImage` + `getImageData`): 16.3 processed fps (CPU-backed canvas) / 30 fps (GPU-backed) against a granted 60 — FAIL; the canvas readback is the bottleneck.
- **WebCodecs route** (`MediaStreamTrackProcessor` → `VideoFrame.copyTo` → Y-plane subsample → reduce): 30 processed fps, **full-frame** total median 14.1 ms (rolling 17.6 ms).

## Decision

The detection pipeline's reduction stage runs on the **CPU**, fed by **WebCodecs capture**: `MediaStreamTrackProcessor` delivers `VideoFrame`s off the camera track; the ROI is cropped in `copyTo`; the Y plane is read directly as luminance (NV12/I420 — the Android camera formats), stride-subsampled to the working resolution, and reduced to per-strip hot-pixel counts in TypeScript. `VideoFrame.timestamp` — a capture timestamp by construction — is the expected capture-time source of truth (jitter measurement on device still owed to 0008).

The capability gate requires `MediaStreamTrackProcessor` + camera + OPFS + speech; WebGPU is no longer probed as a requirement.

**Accepted risk, eyes open:** 14.1 ms full-frame misses the declared ½-frame-interval budget at 60 fps. The leap is taken because (a) the probe copies and reduces the **entire 1280×720 frame**, while production copies only the ROI rect — typically 5–10× less data — and (b) 30 fps operation is the pre-declared threshold floor (accuracy ~±33 ms, constant per-setup bias cancels between laps). **Phase 3 must re-measure the ROI-cropped path on the S22**; if even the cropped path cannot hold the delivered camera rate, the next rung is a WebGL2 fragment-pass reduction (universally supported), not a return to WebGPU.

**Risk resolved (measured 2026-07-13):** `/lab` on the S22 measured the ROI-cropped pipeline at **median 0.5 ms / p95 1.5 ms / max 7.7 ms** per frame — comfortably inside the ½-frame-interval budget even at 60 fps. The full-frame 14.1 ms was indeed copy volume, not compute.

## Consequences

- **Everything downstream of the reduction is unchanged:** strip-energy semantics, the crossing state machine, session layering, storage. "GPU reduces, CPU decides" becomes "the capture pipeline reduces, the state machine decides" — the seam is the same `FrameSample` stream.
- **Determinism gets radically simpler.** The reduction is pure TypeScript: golden tests, replay, and the full detection loop run in node with exact equality — no SwiftShader flags, no GPU-in-CI, no shader-variant drift risk, and the Phase 2 SwiftShader-VideoFrame CI hazard (0008) evaporates along with the WGSL pipeline.
- **Fixture clips need no video codec:** working-resolution luminance planes are small enough to store raw (lossless by construction) in a self-defined container, replayable by reading bytes — `VideoDecoder` is not required for replay.
- **Detection capture code is seam-isolated** in `src/core/detection/` (lint-enforced, like the OPFS seam): the rest of the app consumes `FrameSample`s and never touches `MediaStreamTrackProcessor`/`VideoFrame`. This keeps the capture route swappable — relevant for iOS Safari (best-effort per [0006](0006-ios-best-effort.md)), where `MediaStreamTrackProcessor` is unavailable and the measured-viable-at-30fps canvas route is the candidate fallback if iOS support is ever pursued.
- The `/diag` GPU panels and `src/core/gpu/` spike modules remain as diagnostic instruments (they documented this decision) but nothing product-facing depends on them.
- `docs/specs/product.md` (platform requirements, non-goals) and `docs/specs/detection.md` (capture + reduction stage) are amended in the same change; Phase 3's plan is rewritten for the CPU pipeline.
