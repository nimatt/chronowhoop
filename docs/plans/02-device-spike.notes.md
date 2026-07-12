# Staging notes — implement docs/plans/02-device-spike.md

Working notes from the /implement-plan run of Phase 2 (Device-risk spike), 2026-07-12.
Assumptions, open questions, and disputed review findings land here for later
promotion into ADRs/specs or deletion.

## Pre-implementation

Plan: `docs/plans/02-device-spike.md` (roadmap: `docs/plans/00-roadmap.md`).
Repo state at start: clean working tree at `b6e2b66`, Phase 1 complete.

### Assumptions

- **This run builds the instrument, not the measurements.** Every probe, service,
  panel, and benchmark is implemented and unit-tested, but the plan's exit criteria
  (all `/diag` panels green on the Android device, numbers recorded, decisions made)
  require a physical device session only the user can run. The device-matrix report
  is created as a skeleton with the pre-declared thresholds filled in and measurement
  slots marked TBD; decisions (texture path, timestamp source, partitioning posture)
  are recorded after the user's device session.
- **No iOS device is assumed available.** Per ADR 0006, iOS halves of work items are
  built where they cost nothing extra (the probes run wherever they load) but nothing
  gates on them; the iOS OPFS partitioning posture defaults to "export/import is the
  migration path" as the plan directs.
- **New core modules:** `src/core/camera/` (CameraService + auto-control probe),
  `src/core/audio/` (AudioService), `src/core/gpu/` (texture-import spike, luminance
  pass, readback benchmark, device-loss observer), `src/core/wake-lock/`,
  `src/core/frame-loop/` (rVFC loop + timestamp plumbing). OPFS probe extensions stay
  in `src/core/storage/` per the lint seam. All injectable, matching the Phase 1
  `defaultX()` DI pattern.
- **`/diag` panels are user-gesture-driven where the platform requires it** (camera
  permission, audio priming, wake lock) and button-started for long benchmarks
  (5-minute sustain). The capability panel from Phase 1 stays automatic.
- **Diag UI is decomposed into per-probe panel components** (`src/ui/diag/`) so
  `Diag.svelte` stays a thin composition; per-frame numbers render via direct DOM/canvas
  updates, not Svelte `$state`, per the roadmap's per-frame rule.
- **Atomic-write probe (b) never-close and (c) kill-the-tab cases** use a persisted
  marker file so the panel can verify original-content integrity on the next load of
  `/diag` — a two-step flow with on-screen instructions.

### Open questions (resolved 2026-07-12)

- **Entry criteria status:** Android target device IS in hand; NO deploy to
  chronowhoop.com has happened yet (user, 2026-07-12). Implementation proceeds;
  on-device verification needs the first deploy (or LAN dev serving over HTTPS).
- **iOS device availability:** none for now, "might look later" (user, 2026-07-12).
  iOS halves hard-skipped; device-matrix report marks iOS columns as not measured;
  partitioning posture defaults to "export/import is the migration path".
- **Device-matrix report location** — assumed `docs/decisions/0008-device-matrix.md`
  (plan calls it "an ADR / decision record").

## Follow-ups (deferred by design)

- **ClockLike/defaultClock location (architect review, 2026-07-12).** The clock seam
  lives in `src/core/frame-loop/frame-loop.ts` and is imported by the GPU spike
  modules, creating gpu → frame-loop edges that exist for no frame-loop reason.
  Reviewer's own direction: move to a one-file `src/core/clock.ts` when Phase 3
  starts consuming the seam — deferred to Phase 3, not fixed now.

## Phase logs

(appended by implementer subagents below)

## Phase A — Wake-lock probe

- **Assumption:** "Reacquire only if held when visibility was lost" is implemented as
  user intent (`wantHeld`: set by `acquire()`, cleared only by explicit `release()`/
  `dispose()`), not as a state snapshot taken in the `visibilitychange`-hidden handler.
  Rationale: the sentinel's platform `release` event and the `visibilitychange` event
  are triggered by the same visibility transition with no ordering guarantee across
  browsers, so snapshotting `state === 'active'` at hide is racy. Consequence: a
  *failed* `acquire()` (e.g. NotAllowedError while backgrounded) is also retried on
  the next visible transition, which is the desired recovery for that rejection case.
  If Phase 5 wants strictly "was active at hide", add the snapshot then.
- **Assumption:** explicit `release()` removes the sentinel's `release` listener
  before calling `sentinel.release()`, so the platform-vs-explicit distinction in the
  transition log is by construction (the platform source can only ever come from the
  event) rather than by flag-checking inside a shared handler.
- **Open question:** whether Android Chrome fires the sentinel `release` event on
  screen-lock as well as on tab-hide, and its timing relative to `visibilitychange` —
  the /diag transition log (timestamps + releaseSource) is designed to answer this on
  device; record the answer in the device-matrix report.
- **Review follow-up (2026-07-12):** wake-lock transition timestamps default to
  `performance.now()` (was `Date.now`), matching frame-loop/device-loss so the
  timing-vs-`visibilitychange` question above is answerable by comparing /diag logs
  directly. The service also no longer keeps an internal `transitions` array —
  `onTransition` is the single log surface (the panel already rebuilds its own list).

## Phase A — Frame loop + timestamp stats

- **Assumption:** jitter definition — per timestamp source, over a sliding sample
  window: take deltas between *consecutive, frameIndex-contiguous* frames that both
  carry the source; report population stddev of the deltas (`jitterStddevMs`) AND the
  worst outlier `max |delta − median delta|` (`jitterMaxDeviationMs`), both in ms.
  `medianDeltaMs` is the per-source frame-interval estimate, so the plan's "jitter ≤
  ~½ frame interval" gate reads as `jitterStddevMs ≤ 0.5 × medianDeltaMs` (with the
  max-deviation figure recorded alongside as the outlier view). If the spike prefers
  a different definition (e.g. RFC 3550 interarrival jitter), only
  `src/core/frame-loop/frame-stats.ts` changes; the FrameSample feed is unaffected.
- **Assumption:** `mediaTime` is media-timeline *seconds* while `captureTime`,
  `expectedDisplayTime`, and callback-time `now` are DOMHighResTimeStamp *ms*; stats
  normalize mediaTime to ms so all per-source deltas are directly comparable to a
  frame interval. If a platform reports mediaTime in other units the mediaTime column
  on /diag will be visibly off by ×1000 and the conversion is one line.
- **Assumption:** `FrameSample.now` is the injectable clock's time at callback
  dispatch (default `performance.now()`), NOT the rVFC callback's own `now` argument
  — the fallback timestamp source must be measured with the same clock production
  code would use. If the callback argument turns out to be a better fallback, it is
  available to plumb through as an extra metadata-like field.
- **Assumption:** dropped-frame estimate = Σ max(0, presentedFrames gap − 1) over
  contiguous comparable pairs; `undefined` (not 0) when no pair carried
  `presentedFrames`, so /diag can distinguish "no drops observed" from "can't tell".
  Counter regressions clamp to 0 drops rather than going negative.
- **Assumption:** all `VideoFrameCallbackMetadata` fields are optional in the
  structural `VideoFrameMetadataLike` (even the required-per-spec ones), so a browser
  omitting a field shows up as availability data on /diag instead of a type error;
  per-source availability (fraction of window frames carrying the timestamp) is part
  of the stats result for exactly this reason.
- **Assumption:** default stats window is 240 frames (~4 s at 60 fps); `FrameLoop`
  restart resets `frameIndex` to 0 (a new measurement session), and the stats module
  never pairs samples across a frameIndex discontinuity, so a restarted loop feeding
  the same `FrameStatsWindow` cannot fabricate a giant delta.
- **Open question:** `mediaTime`/`expectedDisplayTime` semantics for live
  getUserMedia streams per platform (plan work item 3) — the stats module reports
  each candidate source's deltas/jitter/availability side by side; the on-device
  /diag numbers decide the source of truth, recorded in the device-matrix report.

## Phase A — CameraService + auto-control probe

- **Assumption:** ideal resolution constraint is 1280×720 (with `facingMode:
  'environment'` and `frameRate: 60` ideals). The detection ROI is downscaled
  later, so resolution is not critical; 720p keeps per-frame upload cheap and is
  granted almost everywhere. If Phase 3/4 needs more pixels, only
  `DEFAULT_CAMERA_CONSTRAINTS` changes.
- **Assumption (revised in review):** getUserMedia failures are classified from
  `error.name` only; `NotAllowedError`/`PermissionDeniedError` always map to
  kind `denied` (state `denied`). An earlier draft sub-split them by message
  sniffing ("dismissed" → `dismissed`, "denied by system" → `blocked-by-os`),
  but Chromium's message text is locale/version-fragile and the UI copy had to
  cover all the cases under `denied` anyway, so review collapsed the kinds: the
  panel's `denied` instructions cover prompt-denied, prompt-dismissed,
  site-settings-blocked, and OS-blocked, and the raw rejection message is shown
  alongside.
- **Open question:** a timing heuristic (near-instant `NotAllowedError` ⇒ no
  prompt was shown ⇒ persistently blocked) could sharpen denied-vs-blocked, as
  could `navigator.permissions.query({ name: 'camera' })`. Left out of core for
  now; reintroduce only if the /diag device session shows the merged `denied`
  guidance is not actionable enough on the Android target.
- **Assumption:** `CameraService.stop()` resets *every* state (including
  `denied`/`blocked`/`unavailable`) to `idle`, and a `stop()` during
  `requesting` cancels the request: the late-granted stream's tracks are stopped
  immediately and the state stays `idle`. A cancelled `start()` promise resolves
  with the service's current state at settlement time.
- **Assumption:** auto-control locks are applied via `advanced` constraint
  sets, one control per `applyConstraints` call, sequentially — so an
  `OverconstrainedError` on one control cannot fail or mask the others. A lock
  is only attempted when the capability advertises `'manual'`; otherwise the
  report says so (`advertisedModes` plus an unattempted lock).
- **Assumption:** restore policy per the plan — after probing, each control is
  set back to `'continuous'` only if that was its starting value (restore is
  attempted even when the lock did not stick, which is harmless); any other
  starting value is left at the post-lock state and reported via
  `valueAfterLock`/`valueAfterRestore`.
- **Assumption:** `probeAutoControls(track)` takes the track as its only
  argument (no `defaultX()` global fallback) — a live track can only come from
  CameraService's active stream, so the injection point *is* the track.
  `CameraTrackLike extends AutoControlTrackLike`, so
  `state.stream.getVideoTracks()[0]` feeds the probe directly.

## Phase A — OPFS atomic-write + persistence probes

- **Assumption:** `probeStoragePersistence` actually calls `navigator.storage.persist()`
  (not just `persisted()`), because persistent storage is what the product will want.
  Side effect: running the probe may leave the origin persisted. If the product later
  decides persistence should be user-gated, the probe should split into a read-only
  `persisted()` report and a gesture-driven `persist()` request.
- **Assumption:** the kill-tab probe retains its un-closed writable in a module-level
  reference inside `atomic-write-probe.ts` so GC cannot finalize the stream before the
  user kills the tab; the never-close probe deliberately drops its writable. Only the
  latest experiment's writable is retained: starting another probe (either scenario)
  dereferences — never aborts — the superseded writable, so orphaned experiments do not
  pin their OPFS locks for the page lifetime. If retention turns out to distort the
  never-close measurement (GC timing differs per device), the two scenarios already run
  separately so results stay distinguishable.
- **Assumption:** leftover-artifact detection matches names containing the probe file
  name plus any name ending `.crswap` (Chromium's swap suffix). Broad on purpose so
  unknown swap schemes on the Android device still surface; a concurrent unrelated
  write could theoretically be reported as an artifact, which is acceptable for a diag
  panel.
- **Assumption:** the display-mode helper lives at `src/core/display-mode.ts` (not in
  `src/core/storage/`) since it touches no OPFS API; it reports the first matching of
  standalone/fullscreen/minimal-ui/browser via injected `matchMedia`.
- **Assumption:** the pending-experiment marker is a root-level OPFS JSON file
  (`.chronowhoop-atomic-pending.json`) holding scenario, target file name, expected
  content, and start time; `checkPendingAtomicProbe()` consumes and deletes it (plus
  the target file and own swap artifacts) on the next `/diag` load. Only one pending
  experiment at a time — starting a second overwrites the marker.
- **Assumption:** `writable.abort` is typed optional on `OpfsWritableLike`; the abort
  probe reports a clean failure ("abort is not available") rather than throwing on a
  platform that lacks it — that absence is itself a device-matrix data point.
- **Open question:** the new `opfs.browser.test.ts` cases also run under the
  non-gating `browser-opfs-webkit` CI job, which could not be executed locally
  (missing Playwright host deps on this machine). If pinned WebKit's atomic-write or
  persistence behavior differs (e.g. `contentIntact` false, `estimate()` missing),
  that job goes red — which is real signal for the spike, but the assertions may then
  need per-engine relaxation. Resolved by the next CI run.
- **Open question:** on Chromium, `removeEntry` on a file whose never-close writable
  is still alive in the same page may fail due to the writable's lock; cleanup
  swallows the error and the file is reclaimed once the stream is GC'd or the tab
  dies. If devices show lingering probe files, `checkPendingAtomicProbe` could retry
  cleanup on the following load. On-device /diag runs will show whether this matters.

## Phase A — AudioService + speech probes

- **Assumption:** default speech rate is 1.2 (`DEFAULT_SPEECH_RATE`). product.md says
  only "slightly elevated rate"; 1.2 is a starting point to be judged by ear on the
  device. If wrong, it is a one-constant change consumed via `SpeakOptions.rate`.
- **Assumption:** default-voice preference order is English required, then
  local-service (+2) over platform-default (+1) — offline announcements matter more
  than the platform's pick, and both beat an arbitrary English voice. If a device's
  local en voice sounds bad, the /diag "test voice" run will show it; `speak()`
  accepts an explicit voice override so the policy can change without API impact.
- **Assumption:** `primeOnGesture()` treats a rejected `AudioContext.resume()` as a
  failed (retryable) prime, and reports primed even when `speechSynthesis` is absent
  (capability gating already blocks such browsers at startup).
- **Assumption:** the unlock utterance is empty text at volume 0, routed through the
  normal `speak()` path so it shows up in the /diag lifecycle event log rather than
  being invisible.
- **Assumption:** `beep()` uses a fixed-gain oscillator (0.15, default 80 ms at
  1 kHz) with no attack/release ramp; a click at the edges is acceptable for
  test-mode feedback. AudioParam ramp methods were left out of `AudioContextLike`
  to keep the seam minimal.
- **Assumption:** utterance retention (the iOS GC workaround) is deliberately NOT
  cleared by `cancel()` — only the utterance's own end/error event releases it, so a
  wedged engine is visible as a stuck `pendingUtteranceCount` on /diag.
- **Assumption:** the singleton is a lazy `getAudioService()` accessor rather than a
  module-level `new AudioService()`, so importing the module in node (unit tests)
  has no side effects and no global reads at import time.
- **Assumption:** probe defaults: 3 utterances for rapid back-to-back, 500 ms before
  `cancel()`, 5 s per-event timeout (`DEFAULT_PROBE_TIMEOUT_MS`) — a wedged engine
  yields `timedOut: true` steps instead of hanging the panel.
- **Assumption:** the background/foreground probe (`probeSpeakAfterReturn`) does no
  visibility tracking itself; the /diag panel owns the "background the app, come
  back, press the button" flow and calls it on demand, keeping core framework-free.
- **Open question:** whether Android Chrome fires `error` (with which code) or `end`
  on utterances killed by `cancel()` — the probe records whichever arrives; the
  device run answers it and feeds Phase 5's cancel-and-replace vs skip-stale choice.
- **Open question:** whether the picked default voice survives `voiceschanged`
  firing multiple times on-device (the service re-picks on every event; if devices
  fire it spuriously mid-session the picked voice could switch audibly). The /diag
  voice list plus event log will show this.
- **Review follow-up (2026-07-12):** `probeCancelThenSpeak` and
  `probeSpeakAfterReturn` now include `!timedOut` in `ok` (matching
  `probeRapidBackToBackSpeech`), with a distinct started-but-never-settled detail
  per probe ("… started but never finished within the timeout (mid-utterance wedge
  signature)"). The label is prefixed per probe ("post-cancel utterance …" /
  "speech started after returning but …") to match each probe's existing label
  style rather than sharing one string. All detail strings, including the
  previously untested started-then-errored branch, are now pinned verbatim in
  tests since they get transcribed into ADR 0008 on-device.
- **Review follow-up (2026-07-12), resolved:** `probeSpeakAfterReturn`'s
  started-then-errored case previously fell through to the "speech did not start
  after backgrounding …" detail — factually wrong when start had fired. It now
  reports "speech started after returning but errored mid-utterance" (pinned
  verbatim in a test); the did-not-start wording is reserved for the genuine
  no-start case.
- **Review follow-up (2026-07-12):** the SpeechPanel event log is keyed by a
  monotonically assigned `logIndex` stamped when appending, not by
  utteranceId+type+timestamp — a flaky engine double-firing a terminal event with
  an identical clock reading previously crashed the panel with
  `each_key_duplicate`, losing the log this page exists to capture.

## Phase B — Device-matrix report skeleton

- Created `docs/decisions/0008-device-matrix.md` with status "in progress —
  measurements pending, 2026-07-12"; it flips to accepted after the on-device
  session fills the TBD slots.
- **Judgment call:** the Decisions summary table sits at the top (right after
  Context) rather than the bottom, so the pending-decision list is the first
  thing the device session sees; the iOS partitioning row is the only decision
  already filled (export/import migration path, per plan default with no
  device).
- **Judgment call:** the four threshold bullets are copied from the plan
  verbatim as a normative blockquote, with an explicit statement that they were
  declared before measurement. If the plan's thresholds are ever edited, this
  ADR intentionally does NOT auto-follow — the quoted text is the frozen
  contract the measurements are judged against.
- **Judgment call:** the frame-timestamp table columns (availability, median
  delta, jitter stddev, max deviation) follow the Phase A jitter definition
  recorded above (stddev of frameIndex-contiguous deltas + max |delta − median|),
  and the jitter gate reads as stddev ≤ ½ × median delta, matching
  `frame-stats.ts` rather than inventing a second definition.
- **Judgment call:** the camera section records the requested constraints
  (environment, 1280×720 ideal, 60 fps ideal) from `DEFAULT_CAMERA_CONSTRAINTS`
  so granted-vs-requested is meaningful even if defaults change later.
- **Judgment call:** the "install before first data" banner is recorded as
  not adopted (not merely TBD) — the plan says default to export/import and
  move on; the iOS section notes it is revisited only with device evidence.

## Phase B — GPU texture-import + readback benchmark + device-loss

- **Assumption:** all timings in `src/core/gpu/` are JS-visible only. The
  import-probe cost is the duration of the `importExternalTexture`/
  `copyExternalImageToTexture` call (GPU-side decode/copy/conversion is queued
  and not captured — noted in the report's `timingNote`); benchmark latency is
  submit → `mapAsync`-value-CPU-visible, which is exactly the quantity the
  go/no-go threshold ("sustained readback latency ≤ one frame interval") is
  about, but it is not a GPU profiler. If per-stage GPU timing is ever needed,
  that's `timestamp-query`, out of spike scope.
- **Assumption:** the luminance reduction is a single 256-invocation workgroup
  striding over the ROI (two-stage via workgroup memory, invocation 0 folds and
  writes mean). Correct and simple; not representative of the real pipeline's
  throughput. The benchmark measures the import→pass→readback *chain* latency,
  not shader arithmetic cost, so a slow-but-correct reduction is acceptable; if
  the pass itself ever dominates on-device latency, revisit.
- **Assumption:** drift detection compares the median of the first N latency
  samples against the median of the last N (disjoint windows required, so a
  verdict needs ≥ 2N samples), N = 600 (~10 s at 60 fps) with upward-drift
  threshold +20 % of the early median by default. The plan says "no upward
  drift" without defining it; both knobs are options on the harness if the
  device session wants a different definition.
- **Assumption:** readback overruns (all 3 staging buffers still pending when a
  frame arrives) silently skip that frame's readback and increment a counter —
  the frame loop is never blocked, per the plan. An overrun therefore also
  means that frame's luminance never reaches the CPU; the real pipeline will
  need a policy here (Phase 3+), the spike only counts them.
- **Assumption:** rgba8unorm (not -srgb) is the copy-path destination, so both
  shader variants read nonlinear (gamma-encoded) RGB and luminance is computed
  over nonlinear values with Rec. 709 coefficients. Consistent across both
  paths and fine for motion-energy-style detection; if linear-light luminance
  ever matters, switch the copy target to rgba8unorm-srgb and re-check the
  external path's colorspace.
- **Assumption:** `DeviceLossObserver` keeps a transitions *log* (array) even
  though one GPUDevice can only be lost once — Phase 3's recreation path will
  observe successive devices, and the /diag panel wants one accumulated log.
  Loss timestamps use the injectable clock (`performance.now()` default), same
  clock family as FrameLoop samples.
- **Measured (SwiftShader headless Chromium, this machine):** ANY WebGPU use of
  a constructed `VideoFrame` — `importExternalTexture` or
  `copyExternalImageToTexture`, whether the frame came from an OffscreenCanvas
  or from raw RGBA bytes — drops the whole WebGPU instance ("Instance dropped
  in popErrorScope" / "A valid external Instance reference no longer exists"),
  and `requestAdapter()` flakily returns null afterwards. Canvas and
  ImageBitmap copy sources are stable. `gpu-spike.webgpu.test.ts` is ordered
  around this: deterministic tests use canvas sources; VideoFrame paths run
  last with a pre-acquired device and assert only that a clean result is
  recorded.
- **Open question:** does the VideoFrame instance-drop reproduce on real
  hardware adapters, or is it SwiftShader/true-headless-specific? Phase 3 wants
  constructed VideoFrames for running the real import pass in CI and replay —
  if CI stays on SwiftShader, the CI import path may have to be
  ImageBitmap/canvas (`copyExternalImageToTexture` accepts them; the probe
  already reports per-source results) or CI needs a GPU-backed runner. The
  Android /diag run (probe panel) answers the real-device half.
- **Open question:** `importExternalTexture` per-frame cost from a *live* video
  element can only be measured on-device (`/diag` passes the CameraService
  video element into `probeTextureImport` and the external-path harness); the
  headless test can only exercise the VideoFrame variant. Expect Chromium to
  return a cached external texture when called twice in the same frame for the
  same element — probe frames are separated by macrotask yields to keep the
  per-frame cost honest, but a 0-µs-ish median on-device may still mean "cache
  hit", worth remembering when reading the numbers.

## Review follow-ups — GPU spike core (2026-07-12)

All seven review findings against `src/core/gpu/**` were judged valid and
applied; none disputed. Judgment calls made while applying:

- **Drift threshold is no longer a harness option** (unused-configurability
  finding): the Phase B note "both knobs are options on the harness" is
  superseded — only `driftWindowSize` remains an option; the +20 % threshold
  lives in `readback-stats.ts` (`DEFAULT_DRIFT_THRESHOLD_FRACTION`), still a
  one-line change if the device session wants a different definition.
- **Harness accounting is node-tested through a fake GPUDevice**
  (`readback-harness.test.ts`) rather than by making LuminancePass/StagingRing
  injectable — the device argument already is the injection seam, so the
  drained/encode-error/overrun/release paths are covered without adding the
  same kind of knobs another finding had just removed. The drained bug (encode
  errors counting toward `completed + errors >= submitted` while a mapAsync
  was still pending) is fixed by counting only readback errors toward drained.
- **Import-probe "OK" now means dispatch-validated**: each probe iteration
  binds the imported texture into a small-ROI luminance dispatch and submits
  it inside the validation error scope (untimed, so the measured import cost
  is unchanged). `queue.onSubmittedWorkDone` is deliberately not awaited —
  validation scope + submit is the proportionate viability check for spike
  code.
- **Cache-hit caveat travels with the number**: `IMPORT_TIMING_NOTE` now
  carries the same-frame external-texture-cache warning (previously only in
  these notes), so the on-device transcriber sees it next to the medians.
  Driving probe iterations from rVFC was considered and declined: the probe
  has no video-frame-callback access, and the readback harness already
  measures the true per-new-frame path on real FrameLoop ticks.

## Phase C — /diag UI panels

- **Assumption:** the shared diag session (CameraService instance, preview video
  element ref, acquired GPUDevice, latest measured fps) is a per-mount object
  created in `Diag.svelte` and passed to panels as a prop, typed by
  `src/ui/diag/diag-session.ts`. The recommended `.svelte.ts` rune module was
  tried first but the repo's eslint config parses `.svelte.ts` with the svelte
  parser *without* TypeScript syntax support (the existing `pwa.svelte.ts`
  passes only because it contains no TS-only syntax), and configs were out of
  scope for this change — so the `$state`-backed factory lives in Diag.svelte's
  script instead. Functionally identical; if the eslint config later gains
  `**/*.svelte.{js,ts}` TS parsing, the factory can move to the rune module.
- **Open question — resolved in review:** should `eslint.config.js` add
  `**/*.svelte.{js,ts}` to the block that sets
  `parserOptions.parser: tseslint.parser`? Yes — the review made the config
  change deliberately (added `**/*.svelte.ts` and `**/*.svelte.js` to that
  block, matching eslint-plugin-svelte's documented setup), moved the
  `$state`-backed factory to `src/ui/diag/diag-session.svelte.ts` (the
  `DiagSession` interface stays in `diag-session.ts`, unchanged, so panel
  imports and props are untouched), and added a lint-seams self-test asserting
  a typed `.svelte.ts` rune module parses and stays covered by the OPFS seam.
- **Assumption:** teardown ownership — the session's `destroy()` (run on Diag
  unmount) stops the camera and destroys the GPU device; each measuring panel
  additionally stops its own FrameLoop/harness/poll timer on unmount *and*
  auto-stops when its inputs disappear (camera stopped → preview element
  unmounts → `session.video` becomes null → frame-loop and readback runs stop;
  same for the device). WakeLockPanel disposes its service, SpeechPanel
  unsubscribes and clears its poll, GpuPanel clears its loss-log poll.
  Re-acquiring the GPU device destroys the previous one.
- **Assumption:** fps verdict applies the plan thresholds (≥60 pass, ≥30
  degraded-with-ADR-0003-note, else fail) with a 2 % measurement tolerance
  (58.8 / 29.4) so a 60 fps-granted stream measuring 59.9 fps doesn't flap
  between pass and degraded. The recorded *number* is the raw measured fps;
  only the chip is tolerant. If the spike wants strict thresholds it is one
  function in `FrameLoopPanel.svelte`.
- **Assumption:** readback latency verdict compares the run's median (both
  overall and rolling rows get a chip) against the frame interval derived from
  the frame-loop panel's most recent measured fps, falling back to 1000/60 when
  the frame loop hasn't run; the table header says "assumed 60 fps" in the
  fallback case so a transcribed number can't silently carry the wrong gate.
- **Assumption:** the constructed-VideoFrame source for the texture-import
  probe is `new VideoFrame(video, { timestamp: performance.now() * 1000 })`
  straight from the live preview element (no canvas hop) — closest to what
  Phase 3 replay would do and exercises the same decoder surface. The probe
  closes each frame itself.
- **Assumption:** per-frame display rule — the only live per-frame number is
  the frame-loop panel's "frames seen" counter, written via
  `element.textContent` from the FrameLoop subscriber (with an eslint
  `svelte/no-dom-manipulating` disable justified inline; the span's text is
  owned solely by that subscriber). Everything else ($state stats, snapshots,
  logs) updates at 1 Hz poll or on discrete events.
- **Assumption:** the speech background/foreground probe is a two-button flow
  (Arm → user backgrounds ≥5 s → Run on return). The Run press is itself a user
  gesture, which weakens the "no new gesture" condition of the probe; the panel
  says so in its instructions. A `visibilitychange`-armed auto-run would remove
  the gesture but risks firing while the tab is still settling — deferred to
  the device session to decide if it's needed. The panel does track and display
  whether a hidden phase was actually observed while armed.
- **Assumption:** error containment is two-layered: every probe/action handler
  catches and renders into a per-panel `$state` error line, and each panel is
  additionally wrapped in a `<svelte:boundary>` (via `DiagPanel.svelte`) so a
  render-time crash shows "Panel crashed: …" in place instead of blanking
  /diag. Event-handler throws are NOT caught by boundaries — that's what the
  per-handler catches are for.
- **Assumption:** the GPU panel polls the DeviceLossObserver snapshot at 1 Hz
  rather than registering a second `device.lost` listener; a loss therefore
  appears in the log within a second, which is fine for a manual experiment.
- **Assumption:** the browser smoke test asserts panel headings + idle states
  and that `getUserMedia` was never called; the pending-atomic check runs
  against the browser project's real OPFS and reports "none". Gesture-driven
  flows (camera, GPU acquire, probes, sustain) are deliberately not driven in
  CI — the on-device session is the real verification per the plan.

### Review follow-ups — gpu/speech/wake-lock panels (2026-07-12)

All three findings accepted; none disputed. Judgment calls:

- **Panel-owned resources now start inside `$effect` bodies, not component
  init** (leak-past-boundary finding): SpeechPanel's onEvent subscription /
  1 Hz poll / visibilitychange listener and WakeLockPanel's service creation
  (its visibilitychange listener was the same leak class) moved into the
  effect that cleans them up, so a first-render crash caught by the
  `<svelte:boundary>` can no longer leak them. WakeLockPanel wraps creation in
  `untrack` because the initial transition fires synchronously and reads
  `transitions` — tracked, every later transition would recreate the service.
  GpuPanel needed no effect: its poll timer is gone entirely (next bullet).
- **`DeviceLossObserver` collapsed to `observeDeviceLoss(device, onLoss,
  clock?)`** (simplicity finding): the class's log/snapshot/`lost` getter
  wrapped a fire-once promise, and its accumulated-log justification never
  held because GpuPanel created a fresh observer per re-acquire. The
  accumulation now lives where it is true — GpuPanel keeps one `$state` log
  across re-acquires, labelled with a device generation counter (the replaced
  device's `destroyed` loss also lands in the log), and the LOST/ACTIVE chip
  tracks only the current generation. Push replaces the 1 Hz snapshot poll,
  so losses render immediately. The rejected-promise branch was dropped:
  `device.lost` never rejects per the WebGPU spec. This supersedes the
  Phase B "keeps a transitions log" bullet and the Phase C "polls the
  DeviceLossObserver snapshot at 1 Hz" bullet above.
- **WakeLockPanel timestamps render as raw ms** (`fmtMs(at, 0)`, matching the
  GPU loss log) — adaptation to the wake-lock core change that moved the
  default clock from `Date.now` to `performance.now()`; the panel keeps using
  only the `onTransition` callback (the removed `.transitions` getter is not
  reintroduced).

### Review follow-ups — measurement panels (2026-07-12)

All five findings accepted; none disputed. Judgment calls:

- **Runs auto-stop on identity change, not just null** (device re-acquire
  finding): FrameLoopPanel, ReadbackPanel, and TextureImportPanel capture the
  video/device they started with; the auto-stop effect fires when
  `session.video`/`session.device` differs from the captured one, so an
  old→new swap (GPU re-acquire never passes through null) stops the run
  instead of letting the harness keep submitting to the destroyed device.
  FrameLoopPanel got the same video-identity guard even though the finding
  named only the GPU panels — same hazard class, one-line cost. The
  texture-import probe can't be cancelled mid-flight, so it instead discards
  the settled result (and shows "results discarded, run again") when the
  session's device or video changed underneath it.
- **Verdict logic extracted to `src/core/diag/verdicts.ts`** (untested go/no-go
  finding): chosen over `src/ui/diag/` because these are the phase's decision
  thresholds (core decision logic, src/core stays svelte-free) and it keeps
  frame-loop/gpu modules free of verdict concerns. Exports `DiagVerdict`
  (`'pass' | 'warn' | 'fail' | 'na'` — Verdict.svelte's `VerdictKind` is now a
  type alias of it, so chip kinds can't drift), `fpsVerdict`, `jitterVerdict`,
  `latencyVerdict`, `frameIntervalForFps`, `ASSUMED_FPS`. Boundary semantics
  pinned by unit tests: all gates are **inclusive** (58.8/29.4 fps pass their
  tolerant thresholds per ADR 0008's declared 2 % tolerance; jitter exactly
  ½ × median passes — the threshold is "~½" and the stat already overstates by
  ~√2; latency exactly at the interval passes). The latency gate now takes
  median AND p95 (`max` of both ≤ interval) per ADR 0008 — a 12 ms median /
  25 ms p95 run previously showed green. This supersedes the "fps verdict …
  one function in FrameLoopPanel.svelte" bullet above.
- **ReadbackPanel grew a ROI toggle** ("Full frame" vs "Small ROI (64×64)")
  feeding the harness's `roi` option, matching ADR 0008's two readback slots
  (full-frame vs small-ROI to attribute crude-pass cost vs readback-path
  cost). The small ROI is **centered** in the frame (computed from
  `videoWidth`/`videoHeight` at start; the shader clamps regardless) — same
  latency as origin, but it samples where a gate would sit. The displayed
  stats carry a "ROI" row labelling which ROI produced them (small runs show
  the resolved origin, e.g. `64×64 @ (608, 328)`), so both runs can be
  transcribed without ambiguity.
- **`rollingTicksPerSecond` renders as a "rolling tick rate" row** in the
  readback stats, so the end-of-run snapshot (taken at stop) carries the
  concurrent frame rate the ADR asks to transcribe next to the latency
  numbers.
- **`meanDeltaMs` dropped from `TimestampSourceStats`** (nit accepted): no
  panel, ADR table, or verdict consumes it — median is the interval estimate
  and stddev already embeds the mean internally. Tests asserting delta-pairing
  semantics through the mean now assert through the median.

## Review follow-ups — residual findings (2026-07-12)

All nine residual findings judged valid and applied; none disputed. Judgment
calls:

- **Half-rate is tick decimation, not preview hiding** (readback attribution
  finding): `ReadbackHarness` gained a `tickDecimation` option (default 1;
  the panel's new "rate" control offers Full / Half = every 2nd tick).
  Semantics chosen: decimated ticks are **invisible** to the harness — they
  count as neither ticks, overruns, nor no-frame skips, and never pull a
  frame from the source — so every snapshot counter and
  `rollingTicksPerSecond` covers processed ticks only (~camera rate / N; the
  snapshot carries `tickDecimation` and the panel labels the rate row when
  decimated). ADR 0008's caveat now points at the actual control and
  explicitly warns against hiding the preview (rVFC is the tick source;
  hiding the element can stop delivery rather than isolate scheduling —
  Chromium keeps `visibility: hidden` composited but rVFC behavior is not
  guaranteed, so the suggestion was dropped rather than reformulated).
- **Stale `measuredFps` cleared at the seam** (stale-gate finding): the diag
  session's `video` setter resets `measuredFps` to null whenever the element
  identity changes (stop → null, restart → new element — CameraPanel
  recreates the preview element per active state, so identity change is the
  reliable signal). Chosen over clearing in FrameLoopPanel's guard because
  that panel's effect only observes while its own run is active. The
  `DiagSession` interface is unchanged. Additionally the readback gate header
  now shows fps provenance ("assumed 60 fps" via the `ASSUMED_FPS` constant /
  "measured N fps"), and the panel warns when the gate's fps and the run's
  effective tick rate (rolling rate × decimation) diverge by >20 % — the
  thermal-drop case a pre-run fps measurement cannot see.
- **Auto-stops are now visible** (silent-abort finding): the identity-guard
  branch in ReadbackPanel sets "Stopped automatically: the GPU device or
  camera changed mid-run." (FrameLoopPanel mirrors with its camera-only
  message); cleared on the next start. Manual Stop and sustain completion do
  not set it.
- **Small-ROI sustain slot pre-declared** (declared-before-measurement
  finding): the ADR sustain rows' small-ROI cells changed from "—" to
  conditional TBDs, with an additive dated rule outside the quoted threshold
  block: run only on a full-frame sustain miss; the normative gate is judged
  on the small-ROI run when the short-run delta shows the crude pass
  dominates, else the full-frame result stands.
- **Import probe warms up untimed** (first-iteration `createTexture`
  finding): `measureImportPath` runs one extra iteration at index 0 whose
  cost is not recorded (identical code path, validation still checked), so
  the copy path's first-use destination-texture creation can't inflate a
  small sample's p95/max. `framesMeasured` still equals the requested frame
  count — the existing webgpu-test assertion pins that.
- **ADR "Works?" defined** in the texture-import section intro, matching the
  probe's strengthened `ok` (import + minimal bind/dispatch/submit without
  validation error).
- **Dead `StagingRing.depth` getter deleted** (no consumer).
- **`ASSUMED_FPS` now feeds the panel label** via template interpolation, so
  the constant and the copy can't drift.
- **`centeredRoi(width, height, size)` moved to `luminance-pass.ts`** next to
  `Roi` (was ReadbackPanel-private arithmetic) and unit-tested in
  `luminance-pass.test.ts`: centering, odd-remainder flooring, and
  origin-clamping for zero/unknown or too-small dimensions.

## Phase 2b — CPU-pipeline probe (2026-07-12, post-session addition)

Added after the S22 finding (required device; no stock WebGPU adapter, core or
compat — see ADR 0008 "WebGPU availability"). New: `src/core/cpu-pipeline/`
(StripReducer + CpuPipelineProbe) and the `/diag` "CPU pipeline" panel.

- **Assumption:** luminance uses the same Rec. 709 coefficients as the GPU
  spike's luminance pass, so CPU and GPU numbers stay comparable while both
  instruments exist.
- **Assumption:** hot-pixel test is strictly greater-than the threshold
  (diff == threshold is not hot), pinned by a unit test — whichever way Phase 4
  wants it, the boundary is now explicit.
- **Assumption:** declared CPU budget is ½ frame interval (median AND p95 of
  the full downscale+readback+reduce cost) — the reduction shares the main
  thread with the state machine, UI, and speech, unlike the GPU path whose
  budget was a full interval of largely-parallel work.
- **Assumption:** `willReadFrequently` is a run option, not a constant —
  Chromium backs the canvas with CPU (cheap getImageData, CPU drawImage) or
  GPU (GPU drawImage, sync readback) depending on the hint, and which wins on
  the S22 is exactly what the probe must measure.
- **Assumption:** the probe reuses `computeLatencyStats`/`computeDrift` from
  `src/core/gpu/readback-stats.ts` rather than duplicating them; if the CPU
  pivot is adopted and the gpu spike modules are retired, the stats file moves
  out of `gpu/` then (same deferred-move logic as the ClockLike follow-up).
- **Open question:** if the canvas path misses the budget, `VideoFrame.copyTo`
  (WebCodecs) is the next candidate readback (async, canvas-free) before
  falling back to WebGL2 fragment passes — not built into the probe yet.

### WebCodecs route (2026-07-12, after the canvas-route FAIL)

Canvas route measured on the S22: 16.3 processed/s (CPU-backed) and 30/s
(GPU-backed) against a granted 60 fps — rate gate FAIL, readback route is the
bottleneck. Added `src/core/cpu-pipeline/webcodecs-probe.ts` + the
"CPU pipeline (WebCodecs)" panel.

- **Assumption:** planar formats (NV12/I420 — the expected Android camera
  formats) read the Y plane directly as luminance; packed RGBA/BGRA fall back
  to per-pixel Rec. 709 conversion during subsampling; any other format is a
  counted error, not a crash.
- **Assumption:** subsampling is nearest-neighbor stride-stepping (step =
  floor(width/256)), not box filtering — cheaper, and motion energy over
  ~35k samples doesn't need anti-aliasing; revisit only if field noise says
  otherwise.
- **Assumption:** `StripReducer` gained `processLuminance` (shared EMA core,
  separate loop) rather than converting Y back into RGBA to reuse `process`.
- **Assumption:** the probe records per-frame `VideoFrame.timestamp` deltas and
  the panel applies the existing jitter gate to them — if they pass, WebCodecs
  frame timestamps become a timestamp-source candidate (they are capture
  timestamps by construction, unlike rVFC's presentation-side metadata).
- **Open question:** MediaStreamTrackProcessor's internal buffer drops frames
  silently under backpressure; the probe's processed-rate vs granted-fps
  comparison is the drop detector. If Phase 3 adopts this route, dropped-frame
  accounting needs the frame-timestamp gaps, not presentedFrames.
