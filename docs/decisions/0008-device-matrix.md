# 0008 — Device matrix: Phase 2 spike measurements and decisions

**Status:** in progress — measurements pending, 2026-07-12

## Context

Phase 2 ([plan](../plans/02-device-spike.md)) proves every un-mockable platform capability on the physical Android Chrome target, measured by the permanent `/diag` route and judged against thresholds declared **before** measurement. This document is that record: the thresholds below are normative and were written down before the first on-device number existed, so "it sort of works" cannot slide. The Android device is in hand; measurement waits on the first deploy. Per [0006](0006-ios-best-effort.md) no iOS device is available and the iOS sections are skipped, not deferred-blocking.

Fill TBD slots during the on-device session; then flip status to accepted.

**First session result (2026-07-12): the target device has no stock WebGPU** — see "WebGPU availability" below. The pivot ladder's final rung (ADR 0002 revision) is engaged; the GPU-dependent sections below stay TBD pending the CPU-pipeline probe's numbers and the resulting architecture decision.

## Decisions

| Decision | Outcome | Feeds |
|---|---|---|
| Texture-import path | Moot — no WebGPU on the target device ([0009](0009-cpu-pipeline-webcodecs.md)) | — |
| Timestamp source of truth + fallback | Expected: `VideoFrame.timestamp` (capture timestamp by construction, [0009](0009-cpu-pipeline-webcodecs.md)); on-device jitter measurement still owed | Phase 3/4 capture timestamps |
| Camera auto-control lockability consequence | TBD — if any control not lockable, global-transient rejection is mandatory | Phase 4 detector scope |
| Speech queue policy input | TBD — cancel-and-replace vs skip-stale-enqueue-next chosen from the matrix below | Phase 5 announcer |
| Atomic-write evidence | TBD — cited by the Phase 6 atomic-write ADR | Phase 6 storage |
| Device-loss facts | TBD | Phase 3 recreation path, Phase 5 interruption handling |
| iOS OPFS partitioning posture | **Decided now (default, no device): export/import is the migration path.** Phase 6 ships working export regardless. | Phase 6/7 |
| Pipeline compute substrate (WebGPU vs CPU) | **Decided ([0009](0009-cpu-pipeline-webcodecs.md)): CPU over WebCodecs capture.** WebCodecs route measured 30 proc/s, full-frame total median 14.1 ms / rolling 17.6 ms — misses the ½-interval budget full-frame, accepted with the ROI-crop mitigation and 30 fps floor; **ROI-cropped re-measured on device 2026-07-13: median 0.5 ms / p95 1.5 ms / max 7.7 ms — PASS** | Phase 3 pipeline, capability gate |

## Go/no-go thresholds (normative — declared before measurement)

Copied verbatim from the [plan](../plans/02-device-spike.md):

> - **Granted camera fps:** ≥ 60 fps target; 30 fps is acceptable only with an explicit note that ADR 0003's ±1-frame claim widens to ~33 ms and `detection.md`'s accuracy bound is re-stated accordingly.
> - **Sustained readback latency:** ≤ one frame interval at the granted rate, sustained over a 5-minute run with no upward drift or stalls.
> - **Timestamp jitter:** rVFC capture-time metadata is trusted only if jitter ≤ ~½ frame interval; otherwise the fallback (`performance.now()` at callback) becomes the source of truth and its measured jitter is recorded.
> - **Pivot ladder** (each step is a named next action, not a crisis; applies to Android measurements only): `importExternalTexture` → `copyExternalImageToTexture` fallback → reduced fps with widened accuracy claim → ADR 0003/0002 revision (project pivot). An iOS miss lands in the device-matrix report as a documented limitation, nothing more.

**Declared measurement tolerance (additive; declared before measurement, does not edit the quoted block):** the `/diag` fps verdict applies a 2 % tolerance to the fps thresholds — pass ≥ 58.8, degraded ≥ 29.4 — because real cameras grant NTSC rates (59.94 fps) that plainly meet intent; the recorded number is always the raw measured fps, only the verdict is tolerant. The readback verdict gates **both** median and p95 latency against the frame interval.

## Device identity

| Field | Value |
|---|---|
| Device model | Samsung Galaxy S22 (Exynos 2200, **Xclipse 920** GPU — European variant) |
| Android version | 16 |
| Chrome version | 150 |
| Screen (resolution, refresh) | TBD |
| Build id measured against | TBD |
| Measurement date | 2026-07-12 (WebGPU availability only; remaining panels TBD) |

**This device is a hard requirement** (user decision, 2026-07-12) — it cannot be swapped for a Qualcomm/Mali phone, so its WebGPU posture constrains the architecture rather than the device list.

## WebGPU availability (measured 2026-07-12)

| Probe | Result |
|---|---|
| `chrome://gpu` feature status | "WebGPU: Hardware accelerated", Vulkan enabled — **misleading**; see below |
| Core adapter, stock Chrome (`requestAdapter()`) | **null** |
| Compatibility adapter, stock Chrome (`requestAdapter({ featureLevel: 'compatibility' })`) | **null** (both via the `/diag` capability probe and webgpureport.org) |
| Software fallback adapter | not supported (normal on Android) |
| With `chrome://flags/#enable-unsafe-webgpu` | adapter available — blocklist-gated, **rejected as a basis for the product** (capability gate assumes stock Chrome) |
| Samsung Internet, stock | no adapter |

Consequence: the pre-declared pivot ladder's final rung — **ADR 0002 revision** — is engaged. The candidate replacement is a CPU pipeline (probe below); WebGL2 fragment-pass reduction is the fallback candidate if the CPU numbers miss. Waiting for Chromium to enable Xclipse is not a plan for a required device (timeline unknown; track upstream anyway).

## Camera

Requested: `facingMode: environment`, 1280×720 ideal, 60 fps ideal.

| Field | Granted |
|---|---|
| Resolution | TBD |
| Frame rate | **60 fps** (frame-loop panel, 2026-07-12) |
| fps vs threshold (≥60 target / 30 floor) | **PASS** (≥ 60 target met) |

Auto-control probe (per control: capability-advertised modes, lock attempt, whether `getSettings()` reflects the lock):

| Control | Advertised modes | Lock ok? | Settings reflect? | Notes |
|---|---|---|---|---|
| exposureMode | TBD | TBD | TBD | |
| focusMode | TBD | TBD | TBD | |
| whiteBalanceMode | TBD | TBD | TBD | |

**Consequence for Phase 4:** TBD — if any of the three is not lockable, global-transient rejection in the state machine is mandatory, not an edge case.

## Frame loop / timestamps

Measured fps: TBD. Dropped-frame estimate (presentedFrames gaps over window): TBD.

Per-source stats (availability = fraction of window frames carrying the source; jitter per staging-notes definition: stddev of frameIndex-contiguous deltas + max |delta − median|):

| Source | Availability | Median delta (ms) | Jitter stddev (ms) | Max deviation (ms) | ≤ ½ frame interval? |
|---|---|---|---|---|---|
| captureTime | TBD | TBD | TBD | TBD | TBD |
| mediaTime | TBD | TBD | TBD | TBD | TBD |
| expectedDisplayTime | TBD | TBD | TBD | TBD | TBD |
| callback `performance.now()` | TBD | TBD | TBD | TBD | TBD |

Live-stream `mediaTime`/`expectedDisplayTime` semantics observed: TBD.

Note: the jitter stat is a successive-delta stddev, which inflates per-timestamp noise by ~√2 — the ½-frame-interval gate is therefore ~1.4× stricter than a per-timestamp reading (conservative, and fair across sources); give a marginal `captureTime` fail a second look before declaring the fallback the source of truth.

**Decision — timestamp source of truth:** TBD. **Fallback:** TBD (record fallback's measured jitter if it becomes the source of truth).

## Texture import

"Works?" = the import call **plus** a minimal bind/dispatch/submit passes without a validation error (the probe's `ok`) — an import call can succeed while the path fails at bind/dispatch/submit.

| Path | Works? | Per-frame cost | Notes |
|---|---|---|---|
| `importExternalTexture` from live stream | TBD | TBD | |
| `copyExternalImageToTexture` from video element | TBD | TBD | |
| `importExternalTexture` from constructed `VideoFrame` | TBD | TBD | Phase 3 wants this for CI/replay |
| `copyExternalImageToTexture` from constructed `VideoFrame` | TBD | TBD | Phase 3 wants this for CI/replay |

**Decision — texture-import path:** TBD (apply pivot ladder on a miss).

**CI environment (SwiftShader) observations:** on headless SwiftShader Chromium (measured on the dev machine, 2026-07-12), *any* WebGPU use of a constructed `VideoFrame` — either import path, whatever the frame's source — drops the WebGPU instance and makes subsequent `requestAdapter()` flaky; canvas and ImageBitmap copy sources are stable. Open question whether this reproduces on real hardware adapters — it directly threatens Phase 3's plan to run the real import pass in CI via constructed VideoFrames (fallbacks: ImageBitmap/canvas `copyExternalImageToTexture` in CI, or a GPU-backed runner). The on-device probe row above answers the real-hardware half.

## Readback

Luminance pass + `mapAsync` through 3-deep staging ring, at camera rate. Frame interval at granted rate: TBD ms.

Two runs: **full-frame** (the deliberately-crude single-workgroup reduction, which may dominate the number) and **small-ROI** (same chain, minimal pass cost). Delta between the two medians ≈ pass cost; the remainder is the import/readback path — apply the pivot ladder only to the readback-path portion, not to crude-pass cost.

| Metric | Full-frame | Small-ROI | Threshold |
|---|---|---|---|
| Median latency (ms) | TBD | TBD | ≤ 1 frame interval |
| p95 latency (ms) | TBD | TBD | ≤ 1 frame interval |
| Max latency (ms) | TBD | TBD | — |
| Overruns (readback > frame interval) | TBD | TBD | none sustained |
| 5-min sustain: upward drift / stalls | TBD | TBD (only on full-frame miss) | none |
| 5-min sustain: end-of-run rolling tick rate (fps) | TBD | TBD (only on full-frame miss) | transcribe next to the latency numbers |

**Declared sustain-attribution rule (additive; declared before measurement, 2026-07-12):** the small-ROI sustain column is filled only if the full-frame sustain misses its gate. If the full-frame vs small-ROI short-run delta shows the crude pass dominates the miss, the normative sustain gate is judged on the small-ROI run — the crude single-workgroup reduction is spike scaffolding, not the pipeline being qualified. Otherwise the full-frame result stands and the pivot ladder applies.

Caveats: measured latency is submit → CPU-visible, bundling GPU execution + Dawn IPC + main-thread task scheduling — a borderline miss cannot be attributed from the number alone; rerun with the readback panel's **Half rate** control (the harness processes every 2nd frame-loop tick, halving GPU/readback load while rVFC delivery is untouched; its reported tick rate is the processed rate, ~½ the camera rate) to disambiguate before applying the pivot ladder. Do not hide the preview to shed load — rVFC is the tick source, and hiding the element can stop frame delivery instead of isolating scheduling. The sustain records a rolling tick rate alongside latency because thermal throttling can drop granted fps mid-run while latency *looks* better — end-of-run fps must be transcribed next to the latency numbers.

**Go/no-go vs threshold:** TBD.

## CPU-pipeline probe (added 2026-07-12, after the WebGPU availability finding)

WebGPU-free candidate: rVFC tick → `drawImage` downscale to ~256 px working width → `getImageData` → luminance/EMA-diff/threshold/strip-sum in TypeScript (`/diag` "CPU pipeline" panel). Run twice: `willReadFrequently` **on** (CPU-backed canvas: CPU-side drawImage, cheap getImageData) and **off** (GPU-backed canvas: GPU drawImage, sync readback) — whichever wins on this device is the candidate's shape.

**Declared threshold (before measurement, 2026-07-12):** total per-frame cost (downscale + readback + reduce), median **and** p95, ≤ **½ frame interval** at the granted rate — the other half of the frame budget stays free for the state machine, UI, and speech on the same thread. 5-minute sustain: no upward drift. The fps threshold and 2 % tolerance from the main block apply unchanged (the pipeline substrate doesn't alter ADR 0003's accuracy claim, which rests on capture timestamps, not on where the reduction runs).

| Metric | willReadFrequently on | willReadFrequently off | Threshold |
|---|---|---|---|
| drawImage median / p95 (ms) | not transcribed | not transcribed | — (attribution) |
| getImageData median / p95 (ms) | not transcribed | not transcribed | — (attribution) |
| reduce median / p95 (ms) | not transcribed | not transcribed | — (attribution) |
| **Total median / p95 (ms)** | not transcribed | not transcribed | **≤ ½ frame interval** |
| Processed rate vs camera rate | **16.3/s vs 60 — FAIL** | **30/s vs 60 — FAIL** | ≈ granted fps |
| 5-min sustain: drift / end-of-run tick rate | — (short run failed) | — (short run failed) | no upward drift |
| Hand-wave visible in strip bars? | TBD | TBD | sanity, not a gate |

**Canvas-route result (measured 2026-07-12): FAIL.** With the camera granting 60 fps, the CPU-backed canvas sustains only 16.3 processed frames/s and the GPU-backed canvas 30/s — the pipeline halves (or worse) frame delivery, so the tick-rate gate fails before the per-frame budget is even judged. The canvas readback route (`drawImage` + `getImageData`) is the bottleneck, not the reduction math. Stage medians were not transcribed; not needed, the rate verdict is decisive.

### WebCodecs capture route (declared 2026-07-12, before measurement)

Second candidate, same thresholds: `MediaStreamTrackProcessor` → `VideoFrame.copyTo` → Y-plane stride-subsample → strip reduce (no canvas). The `/diag` "CPU pipeline (WebCodecs)" panel measures it. Its per-frame `VideoFrame.timestamp` deltas are also recorded — if their jitter passes the ½-interval gate, the WebCodecs frame timestamp becomes a timestamp-source candidate alongside the rVFC sources.

| Metric | Value | Threshold |
|---|---|---|
| Frame format / coded size | TBD | informational (NV12/I420 expected → Y-plane path) |
| copyTo median / p95 (ms) | TBD | — (attribution) |
| subsample+reduce median / p95 (ms) | TBD | — (attribution) |
| **Total median / p95 (ms)** | TBD | **≤ ½ frame interval** |
| Processed rate vs camera rate (60) | TBD | ≈ granted fps |
| Frame-timestamp median Δ / jitter σ | TBD | jitter σ ≤ ½ median Δ (timestamp-source candidate) |
| 5-min sustain: drift / end-of-run frame rate | TBD | no upward drift |
| Hand-wave visible in strip bars? | TBD | sanity, not a gate |

**Decision:** TBD — WebCodecs pass → write the ADR 0002-superseding decision (CPU pipeline over WebCodecs capture, gate drops the WebGPU requirement, requires `MediaStreamTrackProcessor`) and amend the Phase 3 plan; miss → measure the WebGL2 fragment-pass fallback before touching ADR 0003.

## GPU device loss

| Scenario | Device lost? | When | `lost.reason` / message |
|---|---|---|---|
| Background → foreground | TBD | TBD | TBD |
| Screen lock | TBD | TBD | TBD |
| 5-minute sustain | TBD | TBD | TBD |

Feeds Phase 3 recreation path and Phase 5 armed-session interruption handling.

## Speech

| Scenario | Outcome (per-utterance start/end/error events, timeouts) |
|---|---|
| Rapid back-to-back utterances (3) | TBD |
| `cancel()` mid-utterance → immediate `speak()` | TBD |
| `speak()` after background/foreground without new gesture | TBD |
| `cancel()`ed utterance fires `error` (code?) or `end`? | TBD |

Mute-switch / screen-dim observations: TBD. Default voice stability across `voiceschanged`: TBD.

Feeds Phase 5's queue policy (cancel-and-replace vs skip-stale-enqueue-next).

## OPFS

| Probe | Result |
|---|---|
| `createWritable` write-commit round trip | TBD |
| Atomic write — second writable, partial write, `abort()` | original intact? TBD |
| Atomic write — second writable, partial write, never close | original intact? TBD |
| Atomic write — second writable, partial write, kill tab | original intact? TBD |
| Leftover swap artifacts (`.crswap` etc.) | TBD |
| `navigator.storage.persist()` grant | TBD |
| `display-mode` (standalone vs tab) | TBD |

Feeds the Phase 6 atomic-write ADR (must cite this measured behavior, not desktop-WebKit inference).

## Wake lock

| Behavior | Observed |
|---|---|
| Acquire / release | TBD |
| Reacquire on `visibilitychange` → visible | TBD |
| Platform `release` fired on screen lock? Timing vs `visibilitychange` | TBD |
| Platform `release` fired on tab hide? Timing vs `visibilitychange` | TBD |

## iOS

**Not measured — no device (ADR [0006](0006-ios-best-effort.md)); revisit if a device becomes available.** No threshold, decision, or exit criterion depends on iOS results.

Partitioning posture recorded now as the plan's default: **export/import is the migration path.** Phase 6 ships working export regardless; the "install before first data" banner is not adopted (revisit only with device evidence on tab-vs-installed-PWA storage contexts).

## References

- Plan: [docs/plans/02-device-spike.md](../plans/02-device-spike.md) (thresholds, work item 10)
- [0003](0003-strip-frame-differencing.md) — ±1-frame accuracy claim; widens to ~33 ms if only 30 fps is granted
- [0006](0006-ios-best-effort.md) — iOS best-effort
- Measurement instrument: the permanent `/diag` route
