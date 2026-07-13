# Detection pipeline spec

Camera side-on to the gate; user crops a region of interest (ROI) around the gate opening. Goal: detect the moment a tiny whoop crosses the gate plane, with direction, at ±1 camera frame accuracy.

## Capture (ADR 0009)

- `getUserMedia`, rear camera preferred on phones; request 60 fps, accept what the device gives (auto-exposure may halve delivered rate in low light — accuracy follows the delivered rate).
- Frames arrive as WebCodecs `VideoFrame`s via `MediaStreamTrackProcessor` — no video element, no canvas in the capture path. Only the ROI is copied out (`copyTo` with a crop rect), and the Y plane is read directly as luminance for the planar formats Android cameras deliver (NV12/I420), stride-subsampled to a fixed working resolution (target ~256 px wide) so cost is independent of camera resolution.
- Each processed frame is timestamped with `VideoFrame.timestamp` — a capture timestamp by construction; lap boundaries use these timestamps, not processing-completion time.
- All capture-API use lives inside the detection module (`src/core/detection/`, lint-enforced seam); the rest of the app consumes `FrameSample`s only.

## Reduction stage (CPU, per frame)

1. Subsampled ROI luminance (from the Y plane; packed-RGB formats convert during subsampling).
2. Diff against a background model: a per-pixel exponential moving average of past luminance frames, seeded from the first processed frame. The EMA adapts **per unit time, not per frame**: each frame applies `alphaEff = 1 − exp(−dt/τ)`, where `dt` is the capture-timestamp delta to the previous processed frame (clamped to [1, 1000] ms — non-monotonic timestamps become a minimal step, stalls never over-adapt) and `τ` is the `emaTimeConstantMs` tunable. dt-scaling means tunables transfer between 60 fps and 30 fps devices, and dropped-frame replays reproduce live trajectories. The default τ ≈ 325 ms restates the historical "alpha ≈ 0.05 per frame" measured at 60 fps: a per-frame factor `a` at frame interval `dt` is the time constant `τ = −dt / ln(1 − a)`, so `τ = −(1000/60) / ln(1 − 0.05) ≈ 324.9 ms`. EMA updating is paused while a crossing is in progress (diffs and counts are still computed against the frozen background) so the drone doesn't get absorbed into it — timing and cap in the EMA-pause contract below.
3. Threshold the absolute difference into a binary motion mask: a pixel is hot when its diff strictly exceeds the threshold (0–255 luma scale).
4. Divide the ROI into **N vertical strips** (default 12) along the travel axis; reduce the mask to one motion-energy value per strip. Strip energy is an **integer hot-pixel count** — determinism is exact equality. Normalization happens downstream on the CPU: consumers divide by the strip's pixel count (uneven strip widths and working resolutions cancel out), which is why each sample carries the counts.
5. Emit one `FrameSample` `{ captureTimeMs, energies, stripPixelCounts }` per frame. This tiny per-frame record is the entire pipeline→state-machine interface.

The reduction makes no decisions — it only reduces frames to strip energies. It is pure TypeScript, so golden tests, replay, and the full detection loop run deterministically in node.

## Crossing detector (TypeScript state machine)

Consumes the per-frame `FrameSample` stream and emits `crossing { timestampMs, direction }` events plus a per-frame `crossingInProgress` flag (`src/core/detection/crossing-detector.ts`). Pure TS: all timing derives from `captureTimeMs` — never wall clock — and every window is milliseconds, never frame counts. The synthetic suite (`crossing-detector.test.ts` over the `synthetic-sequences.ts` generator, which carries mathematical ground truth) is the executable form of this section; behavior is defined here and there, never implicitly by the implementation.

- **Normalized strip energy** = `energies[i] / stripPixelCounts[i]`. A strip with zero pixels is never hot (division guard).
- **Hot hysteresis.** A strip becomes hot when its normalized energy reaches the trigger level (≥ `triggerLevel`) and stays hot until it falls below `hysteresisRatio × triggerLevel`. Flutter between the two levels cannot re-trigger hot transitions.
- **Candidate start.** A crossing candidate starts when a strip within an entry zone — the outermost `entryZoneStrips` strips on each side — goes hot while the detector is quiet (no live candidate, re-arm satisfied, no transient holdoff). The zone fixes the direction: strip-0 side ⇒ `ltr`, strip-(N−1) side ⇒ `rtl`. The canonical frame of reference is strip index order; mirrored cameras are handled by the course's direction choice, and the orientation binding (above) invalidates detection on rotation, so indices never remap. If both zones transition on the same frame, the strip closest to its own edge wins; exact ties go `ltr`.
- **Wave progression.** The candidate tracks its leading edge: the furthest hot strip in the travel direction, measured as the maximum ever reached (furthest-hot-strip advance). Strip-skipping is allowed — the edge may advance any number of strips per frame (race speed is 2–4). A per-frame dip of up to `maxBackstepStrips` below the furthest advance is tolerated flutter; regression beyond that aborts the candidate. If every strip goes non-hot mid-candidate, the candidate aborts and the detector is immediately quiet again.
- **Completion and plausibility.** The crossing completes when the leading edge reaches the far entry zone. It emits an event only if the candidate is no older than `maxTraversalMs`, at least `minTraversalMs` old (default 0 — disabled; single-frame all-hot scenes are handled by transient rejection, not a minimum), and at least `minParticipatingStrips` distinct strips were hot at some point during the candidate. A candidate exceeding `maxTraversalMs` expires and emits nothing (partial traversal).
- **Crossing timestamp.** `captureTimeMs` of the frame where the leading edge first reached or passed the **center boundary**: between strips N/2−1 and N/2 for even N (the first frame the leading edge is past the center boundary in its travel direction); entry into the center strip (N−1)/2 for odd N. Uniformly: the first frame with leading-edge progress ≥ ⌊N/2⌋.
- **Re-arm.** After a completed or backstep-aborted candidate, new candidates wait until every strip is non-hot, so the tail of the same wave cannot re-trigger. Expiry re-arms immediately.
- **Global-transient rejection (mandatory).** If ≥ `transientStripFraction` of the nonzero-pixel strips transition to hot within a single frame, the frame is an AE/AWB step or lighting change, not a wave: any candidate is cancelled, candidate starts are suppressed for `transientHoldoffMs`, and the EMA is **not** paused, so the background re-adapts through the step. Per Phase 2's lockability evidence this is required on platforms where camera auto-controls cannot be locked.
- **Simultaneous blobs.** Single-wave tracker (see Known limitations): concurrent motion is attributed to the one live candidate — an opposing blob can complete it early in the candidate's direction, or the merged geometry fails the participation minimum and nothing is emitted. Deterministic either way; direction + min-lap-time filtering and discard-last-lap are the mitigation.

Above the detector, the session layer applies the semantics from `product.md`: arming, direction filter, minimum lap time debounce, lap emission. Recording real sequences to JSON fixtures from a debug flag is part of the design.

### EMA-pause contract

`crossingInProgress` is true from candidate start until completion, expiry, abort, or transient rejection — additionally hard-capped at `maxPauseMs` per candidate, so a drone parked in the ROI after a crash cannot freeze the background model forever (after the cap, the background absorbs the parked drone over ~τ and the strips cool). Capture-timestamp regressions cannot extend the pause or the traversal window: a candidate's start time is clamped down to any regressed timestamp, so elapsed time never goes negative. Callers wire the flag to `DetectionPipeline.setPause`; the `attachDetectorToPipeline` helper does exactly this. Exactly one attached detector may drive `setPause` on a given pipeline at a time (the parameter is last-writer-wins); Phase 5's armed screen must reuse the existing attachment, never add a second one. The pause is a direct same-thread parameter and takes effect on the **next processed frame** (ADR 0009 — the old GPU readback-latency analysis is obsolete). The pause is a **hover/crash mechanism, not a fast-crossing one**: at τ ≈ 325 ms a 3–6-frame crossing suffers negligible background absorption regardless of the one-frame engage latency.

## Trigger-level auto-suggestion

Deterministic (`src/core/detection/trigger-suggest.ts`): observe normalized per-strip energies (zero-pixel strips skipped) over a quiet scene spanning at least `quietWindowMs` of capture time; the suggestion is the 95th percentile — nearest-rank over all strip-level observations — × `marginFactor`, clamped to **[0.02, 0.5]**. Available as a pure function over recorded samples and as an incremental collector for the live setup screen; the collector is reset whenever the scene or ROI changes.

## Backpressure

If reduction falls behind the delivered camera rate, frames drop **at the source**: the capture queue keeps only the newest frame, and undelivered frames are discarded before any processing cost is paid. Everything downstream must tolerate gaps — all detection windows, debounces, and timeouts are expressed in **milliseconds of capture time, never frame counts**. The dt-scaled EMA makes a dropped frame a tolerance-level perturbation of the background trajectory, not a semantic change.

## Orientation

The ROI is bound to the device orientation captured at setup (when the camera starts) — an **app-state binding, not an OS screen lock**. On an orientation change while the camera is running, the app warns prominently and invalidates detection until the setup orientation is restored; it never remaps the ROI across orientations. Invalidation is honest: the crossing detector is detached (not paused — the rotated frames make both the background model and strip geometry meaningless), so crossings during the mismatch are lost; an armed session stays armed and timing continues, and on restore the background model is reset, detection re-attaches quiet, and the armed screen shows the detection-was-interrupted notice. Arming and test mode are refused while mismatched. Stopping the camera releases the binding; the next camera start binds to the current orientation.

## Calibration UX

Setup screen renders: camera preview, draggable/resizable ROI rectangle, live per-strip energy bars with the trigger-level line, and sensitivity controls. Test mode (see product spec) confirms end-to-end detection before arming.

## Tunables

Snapshotted into each session (seeded from the course's previous session). The crossing detector's `triggerLevel` follows `DetectionTunables.triggerLevel` unless a caller overrides it explicitly in the detector config — there is one user-facing trigger level, shared by the energy bars and the detector.

| Parameter | Default | Notes |
|---|---|---|
| ROI rect | — | normalized to camera frame |
| Strip count | 12 | along travel axis |
| Trigger level (`triggerLevel`) | auto-suggested (see Trigger-level auto-suggestion) | normalized strip energy (count / strip pixel count); user-adjustable |
| EMA time constant (`emaTimeConstantMs`) | ~325 ms | background adaptation speed; per-frame `alphaEff = 1 − exp(−dt/τ)`. Equivalent to the former "alpha ≈ 0.05 per frame" at 60 fps |
| Diff threshold | 25 | 0–255 luma scale; a pixel is hot when its diff strictly exceeds this |
| Hysteresis ratio (`hysteresisRatio`) | 0.5 | hot strips cool below `hysteresisRatio × triggerLevel` |
| Entry zone (`entryZoneStrips`) | 2 | outermost strips on each side that can start a candidate |
| Backstep tolerance (`maxBackstepStrips`) | 1 | tolerated per-frame leading-edge regression, in strips |
| Min traversal (`minTraversalMs`) | 0 (disabled) | completions faster than this are rejected |
| Max traversal (`maxTraversalMs`) | 1500 ms | candidate expiry window |
| Min participating strips (`minParticipatingStrips`) | 3 | distinct hot strips a completion must have seen |
| Transient fraction (`transientStripFraction`) | 0.7 | fraction of nonzero-pixel strips going hot in one frame that rejects as a global transient |
| Transient holdoff (`transientHoldoffMs`) | 300 ms | candidate-start suppression after a global transient |
| Max pause (`maxPauseMs`) | 2000 ms | hard cap on the EMA pause per candidate |
| Quiet window (`quietWindowMs`) | 3000 ms | minimum observation span for the trigger suggestion |
| Margin factor (`marginFactor`) | 3 | trigger suggestion margin over the noise p95 |
| Min lap time | 3 s | lives on the course |
| Direction | — | lives on the course |

## Video-capture seam

The pipeline keeps a short ring buffer of recent downscaled ROI frames. v1 uses it for nothing user-facing, but per-crossing clip export must be addable later purely by consuming this buffer on `crossing` events.

## Fixture formats (replay corpus)

Recorded fixtures make tuning drone-free: raw clips replay through the pipeline in node, bit-exactly reproducing live behavior (dropped-frame gaps and timestamp jitter included). Three artifact kinds, each carrying an integer `formatVersion` (currently 1); a breaking layout or semantics change bumps the version, and decoders hard-reject versions they don't know.

- **Raw luma clip (`.cwclip`) — the canonical corpus artifact.** Binary container: 4-byte ASCII magic `CWCL`, u32 little-endian header length, UTF-8 JSON header `{ formatVersion, width, height, frameCount, captureTimesMs[], conditions? }`, then `frameCount` concatenated raw Y planes (width × height bytes each, row-major, no padding). Lossless by construction — no codec; replay is reading bytes. `captureTimesMs` records exactly what the live run saw (one entry per frame; monotonicity is not enforced by the container). `conditions` is a free-form string→string map for recording circumstances (venue, light, camera, truncation markers). Decoders validate magic, version, header shape, and that the total byte length matches the header exactly — truncation and trailing bytes are both hard errors.
- **Annotation sidecar (JSON, next to the clip) — the ground truth.** `{ formatVersion, tier, crossings: [{ frameIndex, direction: 'ltr' | 'rtl' }], conditions?, notes? }`. Annotations attach to clips and frame indices, never to derived data. `tier` is `must-pass` (gates Phase 4 acceptance in CI) or `known-limitation` (hard field fixtures commit without breaking CI).
- **Strip-energy JSON — a regenerable derivative, never ground truth.** `{ formatVersion, tunables, frames: [{ captureTimeMs, energies[] }] }`. The embedded tunables are provenance: whenever tunables or the reducer move, energy JSON re-derives from the clip (`regenerateEnergyJson`, plain node at unit-test speed). Strip pixel counts are not stored — they derive from the clip's dimensions plus `tunables.stripCount`.

**Corpus match tolerance (normative).** When the corpus harness scores emitted crossings against a sidecar's ground truth, an emitted event matches an annotated crossing iff it has the same direction AND |emitted `timestampMs` − the annotated frame's capture time| ≤ one frame interval, defined as the clip's **median** consecutive capture-timestamp delta (jitter-robust; a single dropped-frame gap cannot widen the tolerance). Matching is greedy best-delta with claimed events: each annotated crossing takes the closest unclaimed qualifying event, and each emitted event matches at most one annotated crossing. Unmatched annotations are misses; unmatched events are false positives.

Committed fixtures live under `fixtures/` (`clips/`, `annotations/`, `energies/`) with a total repo budget of ≤ ~5 MB — short/small clips in git; long clips leave the device via download/share and stay out of the repo. Committed files are pinned by fixture-freshness tests: rebuilding them from their in-repo definition must be byte-identical (`UPDATE_FIXTURES=1` rewrites them).

## Known limitations

- Accuracy is bounded by camera frame interval (~17–33 ms). Constant per-setup bias cancels out between laps of the same session.
- Two objects moving through the ROI simultaneously (pilot walking during flight) can confuse the wave detector; direction + min-lap-time filtering mitigates, discard-last-lap recovers.
- Large lighting changes (clouds, lights toggling) may need a moment of background re-adaptation; test mode reveals this.
