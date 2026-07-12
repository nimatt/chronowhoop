# Phase 3 — Detection pipeline, pipeline lab, fixture tooling (v2 — post ADR 0009)

> **v2 note:** rewritten after ADR 0009 (CPU pipeline over WebCodecs capture superseded ADR 0002's WebGPU requirement). v1 of this doc — the WGSL/GPU version — is in git history. Intent, sequencing, and the fixture philosophy are unchanged; the substrate is now pure TypeScript fed by WebCodecs, which deletes the GPU-golden rig, canonical-texture design, device-loss recreation, and on-device GPU self-test items and makes determinism a node-test property instead of a SwiftShader project.

## Goal

The full reduction stage per `detection.md` runs on-device, visualized live in a hidden `/lab` route; replay is deterministic (bit-exact, node-testable); the fixture system (canonical raw ROI luma clips + annotation sidecars, regenerable strip-energy JSON) exists with capture and export; and the ROI-cropped capture cost is re-measured on the S22 (the ADR 0009 accepted-risk check). The race-speed pilot recording remains the ADR 0003 go/no-go, executed when drone+venue align (not code-gated).

## Scope

**In:** `FrameSource` abstraction (WebCodecs camera source, raw-clip replay source, synthetic source), dt-scaled EMA + integer strip counts in the reducer, `FrameSample` contract, frame ring buffer, fixture formats + recorder + regeneration tool + annotation tooling, `/lab` debug UI with touch ROI + wake lock + self-test, UI bridge pattern, backpressure + orientation policies, ROI-cropped cost re-measurement.

**Out:** the crossing state machine (Phase 4) — `/lab` shows raw strip energies only. Product screens. Persistence (fixtures leave the device via download/share, not OPFS writes). The corpus and pilot recording are field items — tracked, not exit criteria for the code.

## Work items (dependency order)

1. **`FrameSource` abstraction FIRST** — the pipeline consumes an interface (in `src/core/detection/`), never capture APIs directly:
   - `CameraSource`: `MediaStreamTrackProcessor` over the CameraService's track; ROI crop in `copyTo`; Y-plane luminance (per `detection.md`). Emits cropped, subsampled luma frames + `VideoFrame.timestamp` capture times.
   - `ClipSource`: replays the raw luma clip format (item 3) frame-exactly, honoring recorded inter-frame capture-timestamp gaps so a live EMA trajectory (including dropped frames) is reproduced exactly. Pure TS — runs in node and CI. (WebCodecs `VideoDecoder` is NOT needed: clips are raw luma planes by design.)
   - `SyntheticSource`: programmable moving blob over static/noisy backgrounds with known ground-truth crossing frames.
2. **`FrameSample` contract** — `{ captureTimeMs, energies }` (integer hot-pixel counts per strip + strip pixel counts for normalization) — the typed pipeline→state-machine seam every later layer builds against.
3. **Versioned fixture formats, frozen now — clip primacy declared:**
   - **Canonical corpus artifact: raw working-resolution luma clips + JSON annotation sidecars.** Container: JSON header (formatVersion, dims, per-frame capture timestamps, recording conditions) + concatenated raw Y planes — lossless by construction, no codec, replayable by reading bytes. At ~256×144 a 5 s / 60 fps clip is ~11 MB; a repo size budget applies (small/short clips in git;长 clips exported, not committed — decide budget in-phase).
   - Sidecars carry ground truth (crossing frame indices + directions), conditions, and a **tier**: `must-pass` vs `known-limitation` (defines Phase 4's acceptance gate; hard field fixtures commit without breaking CI).
   - **Strip-energy JSON is a regenerable derivative, not ground truth:** `{ formatVersion, tunables (provenance), frames: [{ captureTimeMs, energies[] }] }`; annotations attach to clips/frame indices, never to energy JSON.
4. **Reducer finalization** (in `src/core/detection/`, evolving the spike's `StripReducer`): two decisions written into `detection.md`:
   - **EMA alpha defined per unit time** (dt-scaled from inter-frame capture timestamps; restate "~0.05 per frame @60fps" as a time constant) — tunables transfer between 60 and 30 fps devices and dropped frames replay exactly.
   - **Strip energy stays an integer hot-pixel count**, normalized by strip pixel count downstream; determinism is exact equality.
   - Pause input (`crossingInProgress`) exists as a parameter now; Phase 4 wires it with the timeout contract.
5. **Determinism + golden tests in node** (replacing the GPU rig): hand-constructed frames with known blob positions → exact strip counts; same clip → bit-identical `FrameSample` sequence; `SyntheticSource` wave shapes; paused EMA does not absorb a stationary blob; a dropped-frame sequence matches the gap-free equivalent within tolerance (validates dt-scaling). The `test:webgpu` CI leg is retired; these run in the unit project.
6. **Frame ring buffer** (last ~2 s of working-resolution luma frames) — the video-capture seam, exercised as the clip recorder. Test asserts it holds the last K frames.
7. **Fixture recorder behind a debug flag** (ships now, stays in production builds): ring-buffer clip capture + continuous-clip mode for long events; strip-energy JSON convenience capture; anchor-download export (Web Share API with files is the Phase 7 polish; use it here if trivial).
8. **Fixture-regeneration tool:** clip → `ClipSource` → reducer → strip-energy JSON, runnable locally and in CI (plain node — regeneration is now a unit-test-speed operation). JSON caches re-derive whenever tunables move.
9. **Annotation tooling:** frame-stepper mode in `/lab` — load a clip, step frame by frame (exact by construction), mark crossing frames + directions + tier, emit the sidecar.
10. **`/lab` route** (thin Svelte over the framework-free pipeline): live preview (video element for eyes; detection runs off MSTP), touch-draggable/resizable ROI (normalized coords — prototypes the product calibration interaction), live strip-energy bars with adjustable trigger line, EMA/threshold/strip-count controls, fps + per-frame-cost readout, record buttons, **wake lock held whenever a camera source is active**, and a **self-test panel**: run the embedded golden vectors + one bundled clip through the pipeline and report pass/fail (trivial in CPU-land — kept as a field sanity check that the deployed bundle computes what CI computed).
11. **UI bridge pattern, established here as THE rule:** per-frame data (strip energies, preview overlays) drawn **directly to canvas from the frame callback**; `$state` reserved for low-frequency state (tunables, status).
12. **Backpressure + orientation policies** (written into `detection.md`): if reduction falls behind, MSTP's queue drops frames at the source — downstream logic tolerates gaps (all windows in milliseconds, never frame counts); orientation is **an app-state binding, not an OS screen lock** — ROI binds to the orientation captured at setup; on change, warn and invalidate detection until restored.
13. **ROI-cropped cost re-measurement on the S22** (ADR 0009 accepted-risk check, field item): `/lab`'s cost readout at a realistic gate ROI; record in ADR 0008/0009. Miss → WebGL2 fragment-pass rung, before Phase 4 tuning investment.
14. **Pilot recording checkpoint → ADR 0003 go/no-go** (field item, unchanged in substance): a handful of real race-speed fly-throughs reviewed offline for strips-per-frame advancement, SNR, blur. Output: capture guidance for the corpus, or an ADR 0003 revision while downstream investment is zero.
15. **Rolling corpus recording (started here, NOT an exit criterion):** 30+ annotated events across conditions per the tier scheme; gates Phase 4's acceptance/tuning items only.

## Verification (exit criteria — code items)

- CI (node): golden, determinism (bit-exact), dropped-frame-EMA, and regeneration-tool tests green.
- Deterministic replay proven: same clip → bit-identical `FrameSample` sequence.
- `/lab` works on desktop Chromium: bars track a hand-wave, ROI drag works, recorder exports a replayable clip, self-test passes.
- Field items (13–15) tracked in ADR 0008 / staging notes; not code-gated.

## Risks retired

- **Un-replayable pipeline** — raw luma clips + pure-TS reduction make all future tuning drone-free, deterministic, and bit-faithful to live behavior (stronger than the GPU version's tolerance-bounded fidelity).
- **Corpus invalidation by tuning** — clips are canonical and tunable-independent; JSON regenerates.
- **Ring-buffer seam rot, touch-ROI UX risk, per-frame reactivity jank, mid-capture screen lock** — exercised or ruled here.
- **ADR 0009's accepted risk** — the ROI-cropped cost gets a named on-device check before detector tuning builds on it.
