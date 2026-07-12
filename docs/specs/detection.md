# Detection pipeline spec

Camera side-on to the gate; user crops a region of interest (ROI) around the gate opening. Goal: detect the moment a tiny whoop crosses the gate plane, with direction, at ±1 camera frame accuracy.

## Capture (ADR 0009)

- `getUserMedia`, rear camera preferred on phones; request 60 fps, accept what the device gives (auto-exposure may halve delivered rate in low light — accuracy follows the delivered rate).
- Frames arrive as WebCodecs `VideoFrame`s via `MediaStreamTrackProcessor` — no video element, no canvas in the capture path. Only the ROI is copied out (`copyTo` with a crop rect), and the Y plane is read directly as luminance for the planar formats Android cameras deliver (NV12/I420), stride-subsampled to a fixed working resolution (target ~256 px wide) so cost is independent of camera resolution.
- Each processed frame is timestamped with `VideoFrame.timestamp` — a capture timestamp by construction; lap boundaries use these timestamps, not processing-completion time.
- All capture-API use lives inside the detection module (`src/core/detection/`, lint-enforced seam); the rest of the app consumes `FrameSample`s only.

## Reduction stage (CPU, per frame)

1. Subsampled ROI luminance (from the Y plane; packed-RGB formats convert during subsampling).
2. Diff against a background model: a per-pixel exponential moving average of past luminance frames, seeded from the first processed frame. The EMA adapts **per unit time, not per frame**: each frame applies `alphaEff = 1 − exp(−dt/τ)`, where `dt` is the capture-timestamp delta to the previous processed frame (clamped to [1, 1000] ms — non-monotonic timestamps become a minimal step, stalls never over-adapt) and `τ` is the `emaTimeConstantMs` tunable. dt-scaling means tunables transfer between 60 fps and 30 fps devices, and dropped-frame replays reproduce live trajectories. The default τ ≈ 325 ms restates the historical "alpha ≈ 0.05 per frame" measured at 60 fps: a per-frame factor `a` at frame interval `dt` is the time constant `τ = −dt / ln(1 − a)`, so `τ = −(1000/60) / ln(1 − 0.05) ≈ 324.9 ms`. EMA updating is paused while a crossing is in progress (diffs and counts are still computed against the frozen background) so the drone doesn't get absorbed into it.
3. Threshold the absolute difference into a binary motion mask: a pixel is hot when its diff strictly exceeds the threshold (0–255 luma scale).
4. Divide the ROI into **N vertical strips** (default 12) along the travel axis; reduce the mask to one motion-energy value per strip. Strip energy is an **integer hot-pixel count** — determinism is exact equality. Normalization happens downstream on the CPU: consumers divide by the strip's pixel count (uneven strip widths and working resolutions cancel out), which is why each sample carries the counts.
5. Emit one `FrameSample` `{ captureTimeMs, energies, stripPixelCounts }` per frame. This tiny per-frame record is the entire pipeline→state-machine interface.

The reduction makes no decisions — it only reduces frames to strip energies. It is pure TypeScript, so golden tests, replay, and the full detection loop run deterministically in node.

## CPU stage (TypeScript state machine)

Consumes the per-frame strip-energy vector plus timestamp. Detects a **crossing** as a motion wave traversing the strips:

- Track which strips are "hot" (energy above trigger level) per frame.
- A crossing = hot region entering at one edge and progressing to the other within a plausible time window; direction = order of traversal.
- Emit `crossing(timestamp, direction)` events. Crossing timestamp = capture time of the frame where the wave reached the gate-center strips.

Above that, the session layer applies the semantics from `product.md`: arming, direction filter, minimum lap time debounce, lap emission.

The state machine is pure TS with no GPU dependency and is unit-tested against synthetic and recorded strip-energy sequences. Recording real sequences to JSON fixtures from a debug flag is part of the design.

## Backpressure

If reduction falls behind the delivered camera rate, frames drop **at the source**: the capture queue keeps only the newest frame, and undelivered frames are discarded before any processing cost is paid. Everything downstream must tolerate gaps — all detection windows, debounces, and timeouts are expressed in **milliseconds of capture time, never frame counts**. The dt-scaled EMA makes a dropped frame a tolerance-level perturbation of the background trajectory, not a semantic change.

## Orientation

The ROI is bound to the device orientation captured at setup — an **app-state binding, not an OS screen lock**. On an orientation change while a course is configured, the app warns and invalidates detection until the setup orientation is restored; it never remaps the ROI across orientations.

## Calibration UX

Setup screen renders: camera preview, draggable/resizable ROI rectangle, live per-strip energy bars with the trigger-level line, and sensitivity controls. Test mode (see product spec) confirms end-to-end detection before arming.

## Tunables

Snapshotted into each session (seeded from the course's previous session):

| Parameter | Default | Notes |
|---|---|---|
| ROI rect | — | normalized to camera frame |
| Strip count | 12 | along travel axis |
| Trigger level | auto-suggested | normalized strip energy (count / strip pixel count); from observed background noise, user-adjustable |
| EMA time constant (`emaTimeConstantMs`) | ~325 ms | background adaptation speed; per-frame `alphaEff = 1 − exp(−dt/τ)`. Equivalent to the former "alpha ≈ 0.05 per frame" at 60 fps |
| Diff threshold | 25 | 0–255 luma scale; a pixel is hot when its diff strictly exceeds this |
| Min lap time | 3 s | lives on the course |
| Direction | — | lives on the course |

## Video-capture seam

The pipeline keeps a short ring buffer of recent downscaled ROI frames. v1 uses it for nothing user-facing, but per-crossing clip export must be addable later purely by consuming this buffer on `crossing` events.

## Fixture formats (replay corpus)

Recorded fixtures make tuning drone-free: raw clips replay through the pipeline in node, bit-exactly reproducing live behavior (dropped-frame gaps and timestamp jitter included). Three artifact kinds, each carrying an integer `formatVersion` (currently 1); a breaking layout or semantics change bumps the version, and decoders hard-reject versions they don't know.

- **Raw luma clip (`.cwclip`) — the canonical corpus artifact.** Binary container: 4-byte ASCII magic `CWCL`, u32 little-endian header length, UTF-8 JSON header `{ formatVersion, width, height, frameCount, captureTimesMs[], conditions? }`, then `frameCount` concatenated raw Y planes (width × height bytes each, row-major, no padding). Lossless by construction — no codec; replay is reading bytes. `captureTimesMs` records exactly what the live run saw (one entry per frame; monotonicity is not enforced by the container). `conditions` is a free-form string→string map for recording circumstances (venue, light, camera, truncation markers). Decoders validate magic, version, header shape, and that the total byte length matches the header exactly — truncation and trailing bytes are both hard errors.
- **Annotation sidecar (JSON, next to the clip) — the ground truth.** `{ formatVersion, tier, crossings: [{ frameIndex, direction: 'ltr' | 'rtl' }], conditions?, notes? }`. Annotations attach to clips and frame indices, never to derived data. `tier` is `must-pass` (gates Phase 4 acceptance in CI) or `known-limitation` (hard field fixtures commit without breaking CI).
- **Strip-energy JSON — a regenerable derivative, never ground truth.** `{ formatVersion, tunables, frames: [{ captureTimeMs, energies[] }] }`. The embedded tunables are provenance: whenever tunables or the reducer move, energy JSON re-derives from the clip (`regenerateEnergyJson`, plain node at unit-test speed). Strip pixel counts are not stored — they derive from the clip's dimensions plus `tunables.stripCount`.

Committed fixtures live under `fixtures/` (`clips/`, `annotations/`, `energies/`) with a total repo budget of ≤ ~5 MB — short/small clips in git; long clips leave the device via download/share and stay out of the repo. Committed files are pinned by fixture-freshness tests: rebuilding them from their in-repo definition must be byte-identical (`UPDATE_FIXTURES=1` rewrites them).

## Known limitations

- Accuracy is bounded by camera frame interval (~17–33 ms). Constant per-setup bias cancels out between laps of the same session.
- Two objects moving through the ROI simultaneously (pilot walking during flight) can confuse the wave detector; direction + min-lap-time filtering mitigates, discard-last-lap recovers.
- Large lighting changes (clouds, lights toggling) may need a moment of background re-adaptation; test mode reveals this.
