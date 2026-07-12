# Staging notes — implement docs/plans/03-gpu-pipeline-lab.md (v2, CPU pipeline)

Autonomous /implement-plan run (user pre-consented, 2026-07-12), post-ADR-0009.
Assumptions, open questions, and review outcomes land here.

## Pre-implementation

Plan: `docs/plans/03-gpu-pipeline-lab.md` v2 (rewritten post-ADR 0009).
Repo state at start: clean tree at `b53d2a0` (pivot commit).

### Orchestrator decisions (declared before dispatch)

- **Source decomposition:** capture sources emit `LumaFrame { data, width, height, captureTimeMs }`
  via a `LumaSource` interface; a `DetectionPipeline` composes any LumaSource with the shared
  reducer + ring buffer and emits `FrameSample`s. Sources stay thin; the reduction path is single
  and shared (the CPU analog of plan v1's "one canonical WGSL path").
- **Reducer:** detection-owned copy in `src/core/detection/` with dt-scaled EMA
  (`alphaEff = 1 − exp(−dt/τ)`, τ restated from "~0.05/frame @60 fps" ≈ 325 ms); the
  `src/core/cpu-pipeline/` spike modules stay frozen as /diag instruments (deliberate duplication;
  the spike is throwaway-class).
- **Clip format `.cwclip`:** u32-LE header length + UTF-8 JSON header
  (formatVersion, dims, per-frame captureTimesMs, conditions) + concatenated raw Y planes.
  Sidecars and strip-energy JSON per plan item 3. Committed fixtures live under `fixtures/`
  with a ≤ ~5 MB total repo budget.
- **Skipped (field items, tracked in ADR 0008):** ROI-cropped S22 re-measurement (item 13),
  pilot recording (14), corpus (15). On-device /lab verification pending next device session.

## Phase logs

(appended by implementer subagents below)

## Wave 1 — detection core

Items 1, 2, 4, 5, 6, 12: interfaces + SyntheticSource, FrameSample, reducer,
determinism/golden tests, ring buffer, policy spec text. All node unit tests;
detection.md updated in the same change.

- **Assumption:** `triggerLevel` is a **normalized** strip energy (hot count / strip
  pixel count, so 0–1); default 0.1 is a placeholder — detection.md says the real
  value is auto-suggested from observed background noise, which Phase 4/calibration
  owns.
- **Assumption:** LumaFrame ownership transfers on emit — sources allocate per frame
  and never reuse `data`, so the ring buffer stores references without copying.
  CameraSource must honor this (it copies out of the VideoFrame anyway).
- **Assumption:** paused frames still advance the reducer's last-capture timestamp:
  dt is always the per-frame delta, so unpausing adapts at the normal rate instead
  of integrating the whole pause span (which would partially absorb exactly what the
  pause protected).
- **Assumption:** dt clamps are `[1, 1000]` ms — dt ≤ 0 (non-monotonic timestamps)
  becomes a minimal 1 ms step; anything above 1 s (stall/suspension) adapts as 1 s.
- **Assumption:** the first frame seeds the EMA even when paused (there is no prior
  background to preserve); a dimension change re-seeds; a stripCount change only
  re-buckets and the EMA persists.
- **Assumption:** `DetectionPipeline` implements the app-facing `FrameSource`
  interface directly; ROI and triggerLevel are carried in its tunables snapshot but
  acted on elsewhere (ROI = the source's crop; triggerLevel = the state machine's).
- **Assumption:** each emitted FrameSample owns fresh `energies` /
  `stripPixelCounts` copies (the reducer reuses its internal arrays) — 2×N u32 per
  frame, negligible.
- **Assumption:** SyntheticSource quantizes blob motion to whole pixels
  (Math.round of the fractional center; constant integer painted width) so golden
  strip counts stay exact; ground-truth crossing = first frame whose blob center has
  reached the frame's horizontal midpoint `(width − 1)/2`.
- **Assumption:** spec Tunables table gained a "Diff threshold, 25" row —
  `DetectionTunables.threshold` existed in the skeleton but the table never listed
  it; adding it keeps table and type in sync.
- **Open question:** ring-buffer capacity is a frame count (120 ≈ 2 s at 60 fps but
  4 s at 30 fps). If the recorder needs a duration guarantee instead, a ms-based cap
  can replace it when the fixture recorder (item 7) lands.
- **Open question:** strips with zero pixels (stripCount > working width) emit
  count 0 with denominator 0; normalization is downstream's division, so the state
  machine should guard div-by-zero — flagging for Phase 4.

## Wave 2 — fixtures + replay

Items 1 (ClipSource), 3 (fixture formats), 7 (recorder core), 8 (regeneration
tool): clip-format, annotation, clip-source, energy-json, regenerate, recorder
in `src/core/detection/`, seed fixture under `fixtures/`, spec section
"Fixture formats (replay corpus)" added to detection.md (kept in detection.md
rather than a new fixtures.md — the formats are detection-domain artifacts and
the section is short).

- **Assumption:** `.cwclip` gained a 4-byte ASCII magic `CWCL` ahead of the
  u32-LE header length sketched in the orchestrator decisions — a wrong or
  truncated file now fails with "not a .cwclip" instead of a garbage header
  length.
- **Assumption:** decodeClip requires the byte length to match the header
  EXACTLY — trailing bytes are as much an error as truncation (a concatenated
  or half-written file never half-decodes).
- **Assumption:** the container does not enforce timestamp monotonicity —
  `captureTimesMs` records whatever the live run saw; replay fidelity beats
  container-level hygiene (the reducer's dt clamp already handles
  non-monotonic input).
- **Assumption:** energy JSON omits stripPixelCounts (plan froze the format
  without them); they derive from clip dims + `tunables.stripCount`. Phase 4
  tooling that needs normalization derives them from the clip.
- **Assumption:** `ContinuousRecorder` STOPS capturing at its frame cap
  (default 3600 ≈ 60 s @ 60 fps) and marks `conditions.truncated = 'true'`
  plus `truncatedDroppedFrames` — keeping the contiguous oldest prefix is the
  simplest honest behavior (a silently windowed tail would misrepresent the
  event's start).
- **Assumption:** stopping a recorder (or snapshotting a ring) with zero
  frames throws `ClipFormatError` — there is no honest empty clip; the
  recorder stays recording after a failed empty stop.
- **Assumption:** ClipSource emits fresh per-frame copies of the decoded
  planes (LumaFrame ownership rule), so one decoded clip supports repeated
  replays; determinism is proven live↔replay: a clip recorded from a
  synthetic run replays to a bit-identical FrameSample sequence.
- **Assumption:** fixture generation happens INSIDE the freshness test
  (`fixtures.test.ts`, `UPDATE_FIXTURES=1 bun run test` rewrites) — no
  one-shot script, per the Phase 1 convention. The test needed
  `/// <reference types="node" />` for `node:fs` because tsconfig.app.json's
  `types` list doesn't include node; the reference is scoped to that one test
  file rather than widening the app tsconfig.
- **Assumption:** the seed fixture is 64×36 × 30 frames (~68 KB clip, ~77 KB
  total with sidecar + energy JSON) instead of the suggested ~40 frames — 40
  would have crossed the 100 KB soft budget. Noise is a stateless hash (no
  RNG state), so any frame reproduces in isolation and generation order can't
  drift the bytes.
- **Assumption:** annotation and energy JSON serializers emit canonical bytes
  (fixed key order, 2-space indent, trailing newline) so regeneration is
  byte-stable; `serializeAnnotation` was added beyond the plan for the /lab
  annotation tooling and the freshness test.
- **Assumption:** parsers ignore unknown extra JSON keys within a known
  formatVersion (additive forward compatibility); canonical re-encoding drops
  them.
- **Open question:** energy-JSON byte-exactness relies on V8's deterministic
  float math + JSON number formatting (τ default is a computed double). All
  generation and CI run in node/V8, so this holds; if regeneration ever runs
  in another engine, re-check before comparing bytes.
- **Open question:** how the /lab UI feeds `ContinuousRecorder.add()` — the
  pipeline consumes LumaFrames internally and emits only FrameSamples, so
  Wave 3 either wraps the LumaSource with a tee or the pipeline grows a frame
  tap. Left to the /lab implementer.

## Wave 2 — CameraSource

Item 1's live-capture half: `src/core/detection/camera-source.ts` (+ test) — the
production WebCodecs path, a fresh implementation evolving the frozen
`cpu-pipeline/webcodecs-probe.ts` spike's patterns (structural injectable
track-processor, serial pump, close-in-finally). Detection imports nothing from
cpu-pipeline; the ~30-line subsample helpers are deliberately re-written here.

- **Assumption:** crop rects are rounded **outward to even** x/y/width/height for
  every format, not just NV12/I420 (which require it for 2×2 chroma alignment) —
  the ≤1 px enlargement per edge is harmless for packed formats and keeps one
  alignment path. Rects are clamped to the coded size and never smaller than 2×2;
  coded dims are assumed even for planar formats (true by construction for NV12).
- **Assumption:** a rect `copyTo` failure disables the rect path **permanently**
  for that source instance ("fall back once"): the failing frame is retried with a
  full-frame copy and the crop moves into the subsampling offsets. The fallback is
  NOT counted as an error (the frame still emits); it is visible only as
  `stats().usedRectCopy === false` — the S22 re-measurement must check that flag,
  since only the rect path realizes the ROI-cropped copy saving.
- **Assumption:** a null `VideoFrame.timestamp` frame is **skipped and counted as
  an error** (no performance.now() fallback) — capture-time fidelity is the point
  of this path, and inventing a processing-time stamp would silently corrupt lap
  boundaries.
- **Assumption:** the subsample step is clamped to the crop height
  (`step = max(1, min(floor(cropW/targetWidth), cropH))`) so a degenerate wide-flat
  ROI still emits ≥1 row instead of a zero-height frame.
- **Assumption:** CameraSource is **single-use**: `stop()` cancels the MSTP reader,
  so restart throws — the /lab route creates a new instance per capture session
  (cheap; the track itself is reusable).
- **Assumption:** rect copies are attempted for packed RGB/BGR formats too (the
  same fallback covers rejection); luma conversion always happens during
  subsampling for those formats per detection.md.
- **Assumption:** stats() carries no per-stage latency numbers — the shape was
  fixed as `{ frames, emitted, errors, lastError, format, codedWidth, codedHeight,
  cropRect, usedRectCopy }`; the /lab cost readout times the processing loop
  itself (or reuses the /diag probe) rather than reading timings from the source.
- **Open question:** backpressure relies on MSTP's internal queue dropping while
  the serial pump is busy; `frames` counts only frames actually read, so
  source-side drops are invisible here. If the /lab fps readout needs a
  delivered-vs-processed split, it must compare against the track's frame rate.

## Wave 3 — /lab UI

Items 9, 10, 11 plus item 7's delivery half: `src/ui/lab/` mirrors the diag
structure (panels composed in `src/ui/screens/Lab.svelte`, each inside the
shared `DiagPanel` boundary; `format.ts`/`strip-bars.ts`/`Verdict.svelte`
imported from `src/ui/diag`, not duplicated). Panels: Live pipeline (camera →
CameraSource → tee → DetectionPipeline, preview + ROI overlay + normalized
strip bars with trigger line + stats/cost readouts), Tunables, Recorder (ring
clip / continuous / energy JSON downloads), Annotation stepper (clip load,
frame stepping, crossing marks, sidecar round-trip, replay timeline),
Self-test (bundled fixture vs committed energy JSON).

- **Decision (closes the Wave 2 open question):** the /lab UI feeds
  `ContinuousRecorder.add()` via a tee, not a pipeline frame tap —
  `src/core/detection/tee.ts` (`TeeSource`, a LumaSource wrapper whose tap
  sees each frame before the pipeline). It lives in detection rather than
  `src/ui/lab/` because it is a framework-free LumaSource composition other
  recorders will want; the pipeline's API is unchanged.
- **Assumption:** the per-frame cost measure is the tee→sample turnaround
  (frame handed to the pipeline → FrameSample emitted): ring push + reduction
  + listener fan-out, gated at ½ frame interval (median AND p95) against the
  measured delivered rate. It deliberately EXCLUDES CameraSource's
  copyTo/subsample stage (`stats()` carries no per-stage timings by design);
  the S22 re-measurement (ADR 0008/0009) reads this gate together with the
  `usedRectCopy` flag, the delivered rate, and the /diag WebCodecs probe's
  copy-stage numbers.
- **Assumption:** the self-test compares SEMANTICALLY (per-frame integer
  energies + captureTimeMs, exact equality; stripCount as a precondition),
  not serialized bytes, and does not compare `tunables.emaTimeConstantMs` —
  the default τ is a computed double and byte/ULP comparison would couple the
  verdict to one engine's `Math.log`/float-formatting. Regeneration runs with
  DEFAULT tunables per the plan; if defaults drift from the committed
  fixture's provenance the stripCount precondition or the energy comparison
  fails, which is the intended drift alarm.
- **Asset loading:** the fixture clip is imported with `?url` (Vite emits it
  as a hashed asset; fetched at self-test time) and the expected energy JSON
  with `?raw` (inlined into the bundle). `vite.config.ts` precache glob
  gained `cwclip` so the self-test works offline in the installed PWA
  (allowed config edit; verified present in the built `sw.js` precache
  manifest).
- **Collateral edit:** `src/ui/app-gate.browser.test.ts` expected the stub
  text "GPU pipeline lab" on /lab; the new screen says "Detection pipeline
  lab" (post-ADR-0009 name), so that one assertion string was updated.
- **Assumption:** the wake lock is owned by the lab session and created PER
  CAPTURE SESSION inside the start gesture handler (never at render time —
  the WakeLockPanel lesson about leaking the visibilitychange listener),
  acquired on start and disposed on stop/unmount.
- **Assumption:** `cameraSource` and `pipeline` are retained after Stop
  (until the next Start) so the ring clip stays exportable and the frozen
  stats stay readable after a pass; CameraSource is single-use, so every
  Start builds a fresh source → tee → pipeline chain.
- **Assumption:** the recorder panel's energy-JSON collection (rolling
  last-1800 FrameSamples) resets on ANY tunables change including ROI drags —
  the serialized document embeds one tunables snapshot as provenance, and
  mixed stripCounts would not even validate.
- **Assumption:** ROI interaction constants: min ROI edge 0.05 normalized,
  corner-handle hit radius 14 px (converted to per-axis normalized
  tolerance). Corner drags move that corner's two edges, clamped to [0, 1]
  and to min-size from the opposite edge — no handle crossover/inversion.
  The ROI lives only in session state; persistence is Phase 6.
- **Assumption:** the live per-frame readout (frames seen, rolling rate) is
  drawn ONTO the bars canvas rather than into DOM text nodes:
  `svelte/no-dom-manipulating` (correctly) forbids textContent writes to
  bound elements, and canvas is the UI bridge rule's sanctioned per-frame
  channel. Trigger-line drawing wraps the diag `drawStripBars` (normalized
  energies with a working-pixel count of `energies.length` make bar heights
  the normalized values) instead of forking it.
- **Assumption:** annotation sidecar downloads are named after the loaded
  clip (`<clip base>.json`, matching the `fixtures/annotations/` convention);
  recorder exports use local-time timestamped names
  (`clip-2026-07-13T09-41-27.cwclip`, `energy-….json`). Crossings sort by
  frameIndex on export; a loaded sidecar's `conditions` round-trip untouched.
- **Open question:** the delivered-vs-processed fps split (Wave 2 CameraSource
  note) is still not visible in /lab — the rolling rate is sample arrivals
  only. If the field re-measurement needs source-side drop counts, compare
  against the track's advertised frame rate (shown in the granted settings)
  or extend stats().

## Review fixes — docs + CI (2026-07-13)

- **Decision: the webgpu CI leg is retired fully**, executing plan v2 item 5
  ("The `test:webgpu` CI leg is retired") which the Phase 2-era tree still
  contradicted — the leg was still gating deploy. This resolves the
  Phase-2-notes-vs-plan-v2 conflict **in favor of the plan**: post ADR 0009
  the reduction is pure TS, determinism/goldens run as node unit tests in
  `check`, and a SwiftShader browser rig proves nothing product-facing.
  Deleted `src/core/webgpu-spike.webgpu.test.ts` and
  `src/core/gpu/gpu-spike.webgpu.test.ts` (browser-rig hello-worlds only; the
  gpu/cpu-pipeline spike modules keep their node unit tests and remain /diag
  instruments). Removed the `webgpu` vitest project + SwiftShader launch
  flags from `vitest.config.ts`, `test:webgpu` from `package.json`
  (`test:all` = `vitest run` now covers unit + browser + browser-webkit), and
  the `webgpu` job from `ci.yml` including its entry in deploy `needs`
  (deploy now needs check + browser-opfs-chromium). The
  `**/*.webgpu.test.ts` glob left the eslint seam allowlist for accuracy
  (the lint-seams self-test never referenced it; no test change needed).
- Stale docs aligned to ADR 0009 in the same pass: `docs/testing.md`
  (status → Phase 3; GPU-golden → "Determinism & golden (node)"; on-device
  self-test → /lab CPU self-test vs committed fixture, semantic equality;
  video-E2E → ClipSource replay, no decode/GPU; browser-contract today-list
  gains the /lab component tests), root `CLAUDE.md` (WebCodecs capture is
  the hard requirement; capture-pipeline-reduces/CPU-decides rule; non-goals
  swap "CPU detection fallback" for "alternative capture routes beyond
  WebCodecs"), roadmap Phase 3 row + exit-criteria summary (v2 semantics),
  and the `strip-reduce.ts` header (adoption happened; production reducer is
  `src/core/detection/reducer.ts`).

## Review fixes — lab UI + camera (2026-07-13)

- **Stream-death auto-teardown (TS#2):** `CameraService` now attaches an
  `ended` listener to the first video track on entering `active` and, when it
  fires outside `stop()`, transitions to `{ status: 'unavailable', error:
  { kind: 'track-ended' } }` (new `CameraErrorKind`). **State-shape decision:**
  no new status discriminant — external death is an unavailability, and
  reusing `'unavailable'` means every existing status-branching consumer
  copes; the `kind` carries the distinction. `'idle'` stays reserved for
  deliberate `stop()`, which is what makes external death distinguishable
  from manual teardown downstream. The listener detaches on `stop()` and
  after firing; tracks without `addEventListener` (older structural fakes)
  keep working with no death detection. The lab session's camera subscriber
  now triggers on error-carrying states only (not `'idle'`), sets
  `captureError = 'capture stopped: …'`, and calls a new `teardownCapture()`
  (pipeline + wake lock, **without** `camera.stop()`) so the failure state
  stays visible; `stopCapture()` = `teardownCapture()` + `camera.stop()`.
  The /diag CameraPanel gained the `track-ended` recovery instruction (its
  `Record<CameraErrorKind, string>` is exhaustive, so typecheck enforces it).
- **Recorder mismatch surfacing + Discard (TS#1 UI half):** RecorderPanel
  shows a live dropped-frame warning while recording (1 Hz poll of
  `droppedMismatchedFrames`), a post-stop notice with the dropped count, and
  a **Discard recording** button. **Decision:** Discard replaces the
  `ContinuousRecorder` instance instead of calling `stop()` and dropping the
  bytes — a fresh instance is the one recovery that works in every state
  (`stop()` throws on zero frames and stays recording by design). No core
  API was added. Ring-snapshot encode errors were already surfaced via
  `actionError` (verified, unchanged).
- **ROI → resetBackground (architect#2):** `setRoi` calls
  `pipeline.resetBackground()` after routing the ROI to source + tunables;
  during a drag this reseeds per pointermove, which is correct (every
  intermediate crop has a stale background) and costs one frame of EMA seed.
- **download.ts (TS#6):** object-URL revocation moved to `setTimeout(0)`
  (Safari aborts downloads whose blob URL is revoked in the click task).
- **Stale wake-lock transition (TS#7):** transitions are gated by a
  generation counter captured per `createWakeLockService` call — a disposed
  session's late async `released` can no longer clobber the next session's
  state, while same-session dispose transitions still land.
- **Real-capture browser test (test-rigor#3, done — not deferred):**
  `createLabSession` gained a `mediaDevices` injection option (plumbed as an
  optional `Lab.svelte` prop; the route passes nothing). Two Chromium tests
  in `lab.browser.test.ts` drive the real UI against a
  `canvas.captureStream(30)` animated scene: (1) start → assert
  emitted > 0 from the live stats readout (proves track → MSTP →
  CameraSource → tee → pipeline), export a ring clip via the real button
  with `URL.createObjectURL` spied and anchor click stubbed, `decodeClip`
  round-trip asserted, stop; (2) dispatch `ended` on the track (spec-correct
  simulation — `track.stop()` deliberately fires no `ended`) → capture tears
  down, `track-ended` and `capture stopped` surface. Gated with
  `describe.runIf(typeof defaultMediaStreamTrackProcessor() === 'function')`
  so the webkit project skips it (MSTP is Chromium-only). Both run in ~1 s
  locally; webkit could not be launched on this host (missing system libs,
  pre-existing) — the gate mirrors the app's own support check.

## Review fixes — detection core (2026-07-13)

All 13 assigned findings applied; none disputed. Judgment calls:

- **Recorder (high):** `ContinuousRecorder.add()` drops-and-counts frames
  whose dims differ from the FIRST recorded frame (`droppedMismatchedFrames`
  getter; surfaced in stop() conditions when > 0), so dims are uniform by
  construction and stop() can no longer wedge the recorder. Scope judgment:
  only dims are guarded — a short data plane or non-finite captureTimeMs
  would still throw from encodeClip, but those violate the LumaFrame contract
  at the source and are bugs to surface, not state to absorb. The zero-frames
  stop() still throws and stays recording (unchanged by design).
  `snapshotRingClip` now encodes the longest suffix of frames matching the
  LAST frame's dims — after an ROI drag the ring holds mixed dims for its
  whole ~2 s span, and the newest uniform run is the current-ROI footage a
  snapshot means.
- **Recorder cap:** `DEFAULT_CONTINUOUS_RECORDER_MAX_FRAMES` 3600 → 1800
  (~30 s @ 60 fps). With frames bounded by the new TARGET_PIXELS budget
  (≤ 36 864 B each), worst-case retention drops from ~133 MB to ~66 MB —
  60 s of pinned buffers was more than a phone should hold for one clip, and
  30 s still covers any single gate event. (The Wave 2 note saying "default
  3600 ≈ 60 s" describes the pre-review value.)
- **Subsample budget:** the step now satisfies BOTH the width target and a
  pixel budget — smallest integer step with
  floor(cropW/step)·floor(cropH/step) ≤ TARGET_PIXELS (256×144 = 36 864) —
  fixing the narrow-tall-ROI blowup (300×700 stayed full-res at ~6× the
  budget). TARGET_PIXELS is an exported constant, not a CameraSourceOptions
  knob: no consumer needs to vary it and targetWidth stays the single tuning
  surface. The srcHeight clamp (degenerate flat ROI) still wins over the
  budget; unreachable for real camera widths.
- **CameraSource pump:** a read() rejection now ENDS capture (counted once in
  stats().errors + lastError) — an errored ReadableStream rejects every
  subsequent read() immediately, so the old retry loop was a microtask
  busy-loop. Per-frame processing errors still count and continue.
  `CameraSourceOptions.onError` removed with the review's blessing: pull-style
  stats() is the only error channel; no production consumer existed.
- **Pipeline:** `#processFrame` is guarded on `running`, so stop() is a hard
  barrier — an in-flight source frame can no longer push the ring or emit a
  sample after stop. `resetBackground()` added (forwards to reducer.reset())
  for the ROI-moved-with-same-crop-size case; this REVERSES the simplicity
  suggestion to drop reducer.reset() — it now has a production consumer (the
  lab/setup UI resets on ROI change). snapshotBackground()'s comment now
  claims only its test-seam role.
- **API trims:** `ClipSource.fromBytes` deleted (tests construct via
  `new ClipSource(decodeClip(bytes).frames)`; no other consumer);
  `TeeSource` class collapsed to `teeSource(inner, tap)` — the function is
  the ONLY export from tee.ts (setTap mutability had no consumer); the lab
  session was repointed by the /lab fixer. SyntheticSource's
  captureTimeAt/frameAt are private (no external consumers).
- **Fixture (test-rigor):** the committed fixture was uniform-60 fps and
  therefore blind to dt-scaling regressions (a constant-alpha mutant
  reproduced it byte-identically). New definition: frameCount 31 with frame
  20 dropped (30 delivered — self-test frameCount and the crossing's clip
  index 14 both unchanged), per-frame jitter `(f % 3) * 0.7` ms, blob
  intensity 200 → 240 so the post-gap trail (columns 54–56 at frame 23,
  adapted with alphaEff ≈ 0.096 then ≈ 0.052 across the gap) lands just
  ABOVE the diff threshold where a constant 0.05 alpha stays below.
  Verified empirically: mutating the reducer to `alphaEff = 0.05` fails the
  energy-JSON byte comparison; mutation reverted exactly (byte-identical
  restore, full suite green). A new test pins the timeline's non-uniformity
  (dt spread + a ≥ 1.8× gap) so the coverage can't silently regress to
  uniform pacing. Annotation sidecar changed only in its conditions text;
  crossing stays frameIndex 14.
- **τ portability:** noted at the energy-JSON fixture comparison that the
  embedded `emaTimeConstantMs` is a Math.log-derived double whose ULP/JSON
  formatting is engine-family sensitive — regenerate and compare under the
  same runtime family (node/V8, as CI does). Kept the derivation in types.ts
  rather than pinning a numeric literal.
- **Stats module:** latency/drift math moved to
  `src/core/stats/latency-stats.ts` (it was never GPU-specific);
  `src/core/gpu/readback-stats.ts` is now a one-line re-export shim so
  gpu/cpu-pipeline/diag importers are untouched; the /lab fixer repoints its
  imports.
