# Phase 2 — Device-risk spike: the permanent /diag screen

## Goal

On a physical Android Chrome phone, prove — with measured numbers on a permanent diagnostics screen, judged against **pre-declared thresholds** — every un-mockable platform capability the product depends on. This is the kill/pivot decision point for the architecture, and it ends with real decisions recorded.

Per ADR 0006, iOS is best-effort: if an iOS Safari 26 device is available, run the same probes on it and record the results informationally (they still steer the iOS-specific items in Phases 5–7), but no threshold, decision, or exit criterion depends on them. Where a work item below says "both platforms", the iOS half applies only if a device is at hand.

## Entry criteria

- The physical Android target device in hand and loading the deployed URL (Phase 1 item 11).

## Go/no-go thresholds (declare before the spike starts)

Written into the phase doc / device-matrix report *before* measurement, so "it sort of works" cannot slide:

- **Granted camera fps:** ≥ 60 fps target; 30 fps is acceptable only with an explicit note that ADR 0003's ±1-frame claim widens to ~33 ms and `detection.md`'s accuracy bound is re-stated accordingly.
- **Sustained readback latency:** ≤ one frame interval at the granted rate, sustained over a 5-minute run with no upward drift or stalls.
- **Timestamp jitter:** rVFC capture-time metadata is trusted only if jitter ≤ ~½ frame interval; otherwise the fallback (`performance.now()` at callback) becomes the source of truth and its measured jitter is recorded.
- **Pivot ladder** (each step is a named next action, not a crisis; applies to Android measurements only): `importExternalTexture` → `copyExternalImageToTexture` fallback → reduced fps with widened accuracy claim → ADR 0003/0002 revision (project pivot). An iOS miss lands in the device-matrix report as a documented limitation, nothing more.

## Scope

**In:** camera service, frame-callback loop, camera auto-control probing, minimal (luminance-only) WebGPU pass, readback benchmarking, GPU device-loss observation, audio/speech priming service with queue-pattern probing, OPFS probe including atomic-write behavior, wake-lock probe, the `/diag` route, and the written device-matrix decision record (including the iOS partitioning decision).

**Out:** the real detection pipeline (EMA, threshold, strips), any UI beyond `/diag`, any persistence beyond the probe. Throwaway-quality measurement code is acceptable here *except* the CameraService, AudioService, and timestamp plumbing, which are kept.

## Work items (dependency order)

1. **CameraService** (`src/core`, injectable): `getUserMedia` with `facingMode: environment` + 60 fps ideal constraints; permission pre-prompt explainer; denied/blocked recovery UX (per-OS re-enable instructions); track teardown on navigation. Log what resolution/fps each device actually grants.
2. **Camera auto-control probe:** read `MediaTrackCapabilities` and attempt `applyConstraints` locks for `exposureMode`, `focusMode`, `whiteBalanceMode` on both platforms. AE/AF/AWB steps and focus hunting are a primary false-positive source for frame differencing; whether they can be locked changes Phase 4 scope — if locking is unavailable (likely on iOS), **global-transient rejection in the state machine is mandatory, not an edge case**. Record per-platform answers in the device-matrix report.
3. **Frame loop on `requestVideoFrameCallback`** with capture-time metadata; display measured fps and timestamp jitter. Confirm `mediaTime`/`expectedDisplayTime` semantics for live streams on both platforms; decide the **timestamp source of truth** and fallback against the declared jitter threshold.
4. **Texture-import spike:** `importExternalTexture` from the live stream; implement and benchmark the fallback (`copyExternalImageToTexture` from the video element / `VideoFrame`) — still worth measuring on Android even though Chromium's external-texture path is expected to just work, and it's the likely iOS path if that platform is ever probed. Also try `importExternalTexture`/`copyExternalImageToTexture` from a *constructed* `VideoFrame` — Phase 3 wants this for running the real import pass in CI and replay.
5. **Minimal WGSL pass + readback benchmark:** luminance mean of a fixed ROI to a single value; `mapAsync` readback through a 3-deep staging-buffer ring. Measure sustained end-to-end readback latency at camera rate against the threshold; confirm no pipeline stalls.
6. **GPU device-loss observation:** register a `device.lost` listener; background/foreground the app, let the screen lock, run the 5-minute sustain — record whether and when each platform loses the device. Phase 3 builds the recreation path; this phase gathers the facts.
7. **AudioService singleton** (`src/core`, kept): unlock/prime WebAudio + `speechSynthesis` on a user gesture; `voiceschanged` handling; utterance retention (iOS GC bug); rate setting; short beep; "test voice" button on `/diag`. **Probe the exact patterns Phase 5's announcer depends on:** rapid back-to-back utterances; `cancel()` mid-utterance followed by an immediate `speak()` (historically wedges iOS Safari); `speak()` after a background/foreground cycle *without* a new gesture. Observe and document iOS mute-switch behavior and behavior with the screen dimmed. Phase 5 chooses cancel-and-replace vs skip-stale-enqueue-next from these measurements.
8. **OPFS probe** (via `src/core/storage/` probe functions, per the Phase 1 lint seam): `createWritable` write-commit round trip; then **atomic-write behavior**: write a file, open a second writable, write partial content, then (a) abort, (b) never close, (c) kill the tab — verify on reload that the original content is intact each time, and note any leftover swap artifacts. The Phase 6 atomic-write ADR must cite this measured device behavior, not desktop-WebKit inference. Also report `navigator.storage.persist()` grant state and `display-mode` (standalone vs tab) on both platforms.
9. **Wake Lock probe:** acquire/release + reacquisition on `visibilitychange`, verified on both phones.
10. **Device-matrix report + decisions** written as an ADR / decision record:
    - Chosen texture-import path per platform; timestamp source of truth + fallback; measured fps/latency/jitter envelopes vs thresholds.
    - Camera-control lockability per platform (feeds Phase 4).
    - Speech behavior matrix (feeds Phase 5's queue policy).
    - Atomic-write behavior (feeds Phase 6's ADR).
    - Device-loss behavior (feeds Phase 3's recreation path and Phase 5's interruption handling).
    - **The iOS OPFS partitioning posture, decided now if an iOS device is available** (otherwise default to "export/import is the migration path" and move on): compare tab vs installed-PWA storage contexts from the `/diag` evidence (documented WebKit behavior: home-screen web apps get separate storage, and non-installed apps face eviction pressure). Decide between "install before first data on iOS" (Phase 6 ships the guidance banner) and "export/import is the migration path" (Phase 6 ships working export either way).
11. `/diag` stays as a **permanent hidden route** for field support.

## Verification

- Manual, on the Android device at the deployed URL: all `/diag` panels green **within the pre-declared thresholds**, numbers recorded into the device-matrix report; any miss triggers the pivot ladder, not an ad-hoc judgment call. iOS numbers recorded informationally if measured.
- Unit tests for CameraService/AudioService state logic with injected browser APIs.

## Risks retired

- **The phone WebGPU camera path** (the round table's top risk, originally framed around iOS before ADR 0006) — external-texture availability and sustained readback latency are measured facts with pass/fail semantics, decided while the codebase is hundreds of lines.
- **Capture-timestamp integrity** — the source of truth is decided by on-device measurement against a declared jitter bound.
- **Camera auto-control false positives** — lockability is known before the detector is designed, so Phase 4's global-transient scope is evidence-based.
- **iOS speech field failures** — gesture priming, utterance GC, `cancel()` reliability, and re-prime-after-background are measured now, so Phase 5's queue policy is chosen from facts.
- **Atomic-write assumption** — Phase 6's storage design will rest on measured iOS behavior, honoring the spike's purpose.
- **iOS partitioning surprise** — decided before any durable user data exists, not after.
- **60 fps readback viability** — the staging-ring benchmark answers whether per-frame `mapAsync` can feed the CPU state machine without stalls.
