# Staging notes — implement docs/plans/04-crossing-detection.md

Autonomous /implement-plan run (user pre-consented), post-ADR-0009. Started 2026-07-13
at `2a37235` (Phase 3 committed).

## Pre-implementation

### Orchestrator decisions (declared before dispatch)

- **Corpus-gated items adapted, not skipped wholesale:** the tier-aware corpus harness
  (item 5) is BUILT and wired to `fixtures/` (currently one synthetic must-pass clip);
  corpus completion, the tuning loop (8), and the field session (10) remain field items.
- **CrossingEvent contract:** `{ timestampMs: number; direction: 'ltr' | 'rtl' }` —
  detector emits, session layer consumes (structurally typed on the consumer side so the
  two implementers can run in parallel).
- **EMA-pause wiring:** per the plan's ADR 0009 amendment, `crossingInProgress` drives
  `DetectionPipeline.setPause` directly (next-frame effect); max-pause timeout lives in
  the detector.
- **Test-mode debounce decision** (spec gap, plan item 7): test mode does NOT apply
  min-lap-time debounce — it exists to verify detection, and suppressing rapid hand-waves
  would hide exactly what the user is checking. Wrong-direction crossings stay silent in
  test mode (that IS part of what setup verifies). Written into product.md by the
  session-layer implementer.
- **Skipped (field):** tuning loop over a real corpus, field session at the gate,
  30+ event corpus completion.

## Phase logs

(appended by implementer subagents below)

## Wave A — crossing detector (items 1–4, 6)

Implemented: `crossing-events.ts`, `crossing-detector.ts` (+ `attachDetectorToPipeline`),
`trigger-suggest.ts`, `synthetic-sequences.ts`, spec written into `detection.md`
("Crossing detector", "EMA-pause contract", "Trigger-level auto-suggestion", tunables
table). The synthetic suite (`crossing-detector.test.ts`) is the executable spec;
`detector-pipeline.test.ts` covers pixels→pipeline→detector end-to-end including the
committed fixture clip (annotated frame 14, detected within ±1 frame).

### Decisions refined during implementation

- **Re-arm asymmetry:** after a *completed* or *backstep-aborted* candidate, new
  candidates wait until all strips are non-hot (the same wave's tail can't re-trigger);
  *expiry* re-arms immediately, and a candidate whose strips all go non-hot aborts on
  the spot (already quiet). This is the concrete reading of the plan's "resets to quiet
  (after all strips return non-hot or on expiry)".
- **minTraversalMs semantics:** completions faster than the minimum are *rejected*
  (default 0 = disabled), not deferred — the plan's wording was ambiguous; rejection is
  the only deterministic option once the far zone is reached.
- **Detector config is a separate object** (`CrossingDetectorConfig`), not folded into
  `DetectionTunables`: energy-JSON fixtures serialize `DetectionTunables` verbatim, so
  widening that type would move committed fixture bytes for zero benefit. Session
  snapshotting of detector tunables composes the two at the session layer.
- **Double-blob determinism (documented known limitation):** symmetric opposing blobs
  fail the participation minimum (no event); an opposing blob arriving during a live
  candidate completes it early in the *candidate's* direction. Both pinned by tests.
- **Transient holdoff suppresses candidate *starts* only** — a crossing already being
  tracked was already cancelled by the transient itself; holdoff does not require
  all-strips-quiet (the post-transient cooling handles that naturally since candidate
  starts are edge-triggered).
- **Strip-count agnosticism:** the detector reads N off each sample; an N change resets
  per-strip and candidate state but keeps the (time-based) transient holdoff.
- **Trigger collector is accumulate-until-reset**, not sliding-window: deterministic,
  and the caller (setup screen) owns when the quiet observation phase starts/ends.
  Observation memory grows while fed; callers stop feeding or reset.

### Assumptions

- Capture timestamps are treated as non-decreasing by the detector (same assumption the
  reducer makes; regressions degrade gracefully — negative elapsed just never expires).
- Ground truth for pixel-level fixtures anchors on the blob *center* reaching the ROI
  midpoint (Phase 3 definition) while the detector stamps the leading *edge* at the
  center boundary — one frame apart for the fixture geometry, inside the spec'd ±1
  frame. Synthetic energy-level ground truth matches the detector definition exactly
  (tests assert strict timestamp equality there).
- `transientStripFraction` compares newly-hot transitions per frame; with fewer than ~4
  strips the defaults degenerate (e.g. N=1 rejects everything) — irrelevant at the
  spec'd stripCount 12, noted for tunable-space safety.
- Detector default `triggerLevel` inherits `DEFAULT_DETECTION_TUNABLES.triggerLevel`
  (0.1 placeholder) until the auto-suggestion wires into setup (Phase 4 item 9 / lab).

### Deviations from the plan (logged retroactively, 2026-07-13 review)

- **Item 4:** the synthetic generator emits `FrameSample[]` directly, not
  strip-energy JSON — the detector consumes samples, so serializing to the
  energy-JSON format and parsing back would have added a round-trip for
  nothing. Energy JSON remains a clip-derived artifact only.
- **Item 5:** the planned energy-JSON replay leg collapsed into clip replay:
  under ADR 0009 the whole pipeline is pure TS at unit-test speed, so the
  corpus harness replays raw clips through the real pipeline instead of
  short-circuiting via derived energies. Energy JSON stays a regenerable
  provenance artifact (self-test, fixture pins), not a harness input.

## Wave B — session semantics (plan item 7)

Delivered: `src/core/domain/types.ts` (storage.md Course/Session/Lap verbatim,
no schemaVersion envelopes — Phase 6), `src/core/session/session-engine.ts`
(+ tests), product.md test-mode parenthetical.

### Decisions

- **Debounce boundary inclusive:** a crossing exactly `minLapTimeMs` after the
  previous accepted crossing completes a lap (`delta < minLapTimeMs` is
  ignored). Window measured from the last ACCEPTED crossing; ignored crossings
  do not reset it (a fluttering false trigger can never postpone real laps
  indefinitely).
- **discardLastLap targets the most recent lap regardless of status:** if it
  is already discarded (or there are no laps / no session) → no-op returning
  `false`; it never reaches past a discarded last lap to an earlier valid one.
  Returns `true` only on a valid→discarded flip. Allowed while armed or
  stopped (the session is retained after stop).
- **Test-mode debounce** (orchestrator decision): none — every
  correct-direction crossing emits `onTestCrossing`; wrong direction stays
  silent. Written into product.md's Test mode bullet.
- **arm() creates the Session** (id via injectable generator defaulting to
  `crypto.randomUUID()`, `startedAt` from the injected wall clock, `note`
  optional param defaulting to `''`) and deep-copies the detection tunables so
  live tuning after arming cannot mutate the snapshot.
- **stop() from test mode → idle** (test mode has no session to retain);
  from armed → stopped, dropping the in-progress lap. `startTest()` from armed
  drops the session reference (callers should `stop()` first if they want the
  `session` getter to keep serving it).

### Assumptions

- `Session.note` is captured at arm time (parameter), not edited through the
  engine — note editing is a Phase 6 storage/UI concern.
- `inProgressLap.elapsedMs(nowMs)` takes a capture-domain timestamp (same
  domain as crossing timestamps); the UI clock feeds it the latest frame's
  capture time or an equivalent monotonic source, not `Date.now()`.
- `onCrossing` events are assumed non-decreasing in `timestampMs` (they come
  from one capture stream); a regressed timestamp would just be debounced.

### Open questions (→ Phase 6 schema freeze)

- **detectionConfig snapshot shape:** typed as exactly `DetectionTunables` for
  now. Whether Phase 4's wave-detector tunables (hysteresis, traversal window,
  …) must also be snapshotted into sessions is deferred to Phase 6's schema
  freeze.
- **storage.md example drift:** the sessions example sketches
  `detectionConfig.emaAlpha`, but the implemented tunable is
  `emaTimeConstantMs` (plan 03 restated the EMA as a time constant). The
  example should be updated when Phase 6 freezes the schema.

## Wave C — corpus harness + lab test mode (items 5, 9)

Delivered: `src/core/detection/corpus-harness.ts` (+ `corpus.test.ts` CI gate),
`src/ui/lab/TestModePanel.svelte` (wired into `Lab.svelte`), one seam addition
to the lab session, browser-test coverage, testing.md corpus line.

### Corpus harness decisions

- **Result shape:** `{ name, tier, matched, missed, falsePositives, pass,
  unexpectedPass }` per clip. `pass` for must-pass = all annotated crossings
  matched AND zero false positives; known-limitation clips always report
  `pass: true` (they never fail the run) and set `unexpectedPass` when they
  are fully clean — CI fails on that so progress is promoted into must-pass
  explicitly (the plan's ratchet).
- **Match definition:** same direction AND |emitted timestamp −
  `captureTimesMs[frameIndex]`| ≤ one frame interval, where the interval is
  the clip's **median** consecutive capture-timestamp delta (jitter-robust,
  and a single dropped-frame gap cannot widen the tolerance). Greedy
  best-delta matching with claimed events (each emitted event matches at most
  one annotated crossing). Verified against the committed fixture: with its
  0/0.7/1.4 ms jitter cycle the median delta (~17.4 ms) covers a ±1-frame
  detection wherever it lands.
- **Defaults only:** clips run under `DEFAULT_DETECTION_TUNABLES` +
  `DEFAULT_CROSSING_DETECTOR_CONFIG`; `runCorpus`'s optional config
  (`{ tunables?, detector? }`) exists for the Phase 4 item-8 tuning loop, not
  for per-annotation condition overrides (kept simple per orchestrator
  instruction).
- **Sidecar discovery is strict:** `corpus.test.ts` fails if any
  `fixtures/clips/*.cwclip` lacks an annotation sidecar — an untiered clip
  would otherwise escape the gate entirely. It also asserts the must-pass
  tier is non-empty, so the gate provably runs the (currently single)
  committed fixture.

### Lab test mode decisions

- **Seam added:** `LabSession.setPipelinePause(paused)` (forwards to the live
  pipeline's `setPause`; no-op when stopped). Together with the existing
  `addSampleListener` fan-out this satisfies `PausableFrameSource`, so the
  panel reuses `attachDetectorToPipeline` verbatim via a tiny adapter whose
  `start()` subscribes instead of starting the already-running pipeline.
  Smallest honest seam — the pipeline object itself stays private.
- **Wiring per arm:** fresh `CrossingDetector` (triggerLevel snapshotted from
  the shared tunables, then live-tracked: a `$effect` forwards tunables
  triggerLevel changes via `detector.updateConfig`) → fresh `SessionEngine`
  in test mode over a minimal in-panel Course (`minLapTimeMs: 0` — irrelevant,
  test mode has no debounce). `onTestCrossing` beeps via
  `getAudioService().beep()` and prepends to a 50-entry crossing log
  (capture-time seconds + direction).
- **Direction change while armed** simply re-calls `engine.startTest` with a
  new course — test mode holds no state worth preserving.
- **Disarm** (manual, auto on `captureRunning` dropping — covers external
  track death — and unmount teardown) detaches the listeners AND forces
  `setPipelinePause(false)`: the detector may have left the EMA frozen
  mid-candidate.
- **crossingInProgress indicator:** a second sample listener (registered
  after the detector's, so it observes post-frame state) flips a reactive
  flag only on change — event-frequency, not per-frame, so the UI-bridge rule
  (per-frame listeners don't touch reactive state) is respected in spirit;
  noted as a deliberate exception.
- **Trigger suggestion:** "Suggest trigger" runs a `TriggerLevelCollector`
  over live samples until `quietWindowMs` (3 s) of capture time is observed
  (200 ms poll for progress display; aborts if capture stops), then shows the
  suggestion with an "Apply" button that routes it through
  `session.updateTunables({ triggerLevel })` — the same path as the slider,
  so the pipeline, the bars view, and an armed detector all follow.

### Browser-test scope (honesty over coverage)

Driving a real crossing through canvas `captureStream` is timing-dependent,
so the capture-mode test asserts what is deterministic: arm/disarm state
transitions, the armed indicator rendering, suggest-trigger producing a value
inside the spec'd [0.02, 0.5] clamp, Apply landing in the tunables slider,
and auto-stop when capture stops. The beep path and log rendering stay
covered by unit-level pieces (SessionEngine callback tests, detector tests);
no flaky "wait for a synthetic crossing" assertion was added.

### Assumptions

- `getAudioService()` is safe at panel init in both test browsers (it only
  touches `speechSynthesis`; the AudioContext is created lazily on
  prime/beep). Un-primed beeps degrade to silence by design (`beep()`
  swallows the suspended-context rejection).
- A clip with a single frame gets a 0 ms match tolerance (no deltas to take
  a median of) — such a clip cannot contain a detectable crossing anyway.
- The corpus gate runs at module scope in `corpus.test.ts` (sync fs reads +
  a sub-millisecond harness run per committed clip); acceptable until the
  corpus grows to the 30+ events, where it may want a `beforeAll`.

## Review fixes — core + specs (2026-07-13)

Fixer pass over the Phase 4 review findings owned by the core/specs fixer
(detector non-test files, session, domain, detection/storage/product specs).
All findings were validated against the code before applying; none were
disputed. Detector/harness TEST pinning of these fixes belongs to the
follow-up test fixer (only compile-level edits were made outside owned files).

1. **Timestamp-regression clamp (crossing-detector.ts, Low).** A capture
   timestamp regressing below `candidate.startTimeMs` made elapsed time
   negative, so the candidate never expired and `maxPauseMs` (the anti-freeze
   guarantee) was defeated. Fixed: on regression the candidate's
   `startTimeMs` is clamped down to the regressed `t` before the expiry and
   pause-cap checks. Documented in detection.md's EMA-pause contract
   ("timestamp regressions cannot extend the pause or the traversal window").
   Supersedes the Wave A assumption "regressions degrade gracefully —
   negative elapsed just never expires". Test pinning → follow-up fixer.
2. **triggerLevel precedence in the corpus harness (corpus-harness.ts,
   Medium).** `runCorpus` built `CrossingDetector(config.detector ?? {})`,
   ignoring `config.tunables.triggerLevel` — a tuning-loop caller adjusting
   the tunables' trigger level silently ran the detector at the 0.1 default.
   Fixed: the detector's `triggerLevel` now defaults to the effective
   tunables' `triggerLevel` (`config.tunables?.triggerLevel ??
   DEFAULT_DETECTION_TUNABLES.triggerLevel`), overridden only by an explicit
   `config.detector.triggerLevel`. Precedence rule stated in detection.md
   next to the Tunables table.
3. **Type unification (Low).** `crossing-events.ts` is the single home of
   `CrossingEvent` + `CrossingDirection`. `session-engine.ts`'s structural
   `GateCrossing` alias is REMOVED — the engine type-imports `CrossingEvent`
   directly. `domain/types.ts` `Course.direction` now uses
   `CrossingDirection`. `annotation.ts` type-imports and re-exports
   `CrossingDirection` (export name preserved for its Phase 3 consumers)
   instead of re-declaring the union.
4. **Session.detectionConfig is the composed snapshot (DECISION — resolves
   Wave B's open question ahead of Phase 5 field validation).** New type in
   `domain/types.ts`:
   `SessionDetectionConfig { tunables: DetectionTunables; detector: CrossingDetectorConfig }`.
   `SessionEngine.arm(course, detectionConfig: SessionDetectionConfig, note?)`
   deep-snapshots via `structuredClone` (replacing the hand-rolled roi copy);
   `startTest(course)` DROPS its ignored detectionConfig parameter entirely.
   storage.md's session example updated to the composed shape (also resolving
   the `emaAlpha` → `emaTimeConstantMs` drift and the missing `threshold`);
   Phase 6's schema freeze validates this exact shape. Session + domain tests
   updated; `TestModePanel.svelte` got the minimal compile fix (dropped
   argument) only — UI wiring of the composed snapshot is the UI fixer's.
5. **Dead `frameIntervalMs` return field removed** from
   `generateSyntheticSequence`'s `SyntheticSequence` (the OPTION of the same
   name stays). No test referenced the returned field; no compile fixes
   needed.
6. **`QUIET_NOISE_PERCENTILE` unexported** (verified unconsumed outside
   trigger-suggest.ts). Kept as-is after judging worth: `suggestTriggerLevel`
   (pure replay form used by fixtures/tests), the `elapsedMs` closure on
   `InProgressLap`, and the `WallClock` Date-or-number union.
7. **Normative corpus match/tolerance definition added to detection.md**
   ("Corpus match tolerance" under Fixture formats): same direction AND
   |emitted − annotated frame's capture time| ≤ the clip's median consecutive
   capture-delta; greedy best-delta matching with claimed events.
   docs/testing.md's stale "pending the authoritative fixture-tolerance
   definition" clause now points at it.
8. **detection.md wording:** "younger than `maxTraversalMs`" → "no older
   than" (code completes exactly-at: expiry is `elapsed > maxTraversalMs`).
9. **detection.md even-N timestamp parenthetical made direction-neutral:**
   "the first frame the leading edge is past the center boundary in its
   travel direction".
10. **product.md debounce anchor pinned:** "(debounce — measured from the
    last accepted crossing; ignored crossings don't extend the window)".
11. **detection.md EMA-pause contract:** exactly one attached detector may
    drive `setPause` per pipeline (last-writer-wins); Phase 5's armed screen
    must reuse, not duplicate, the attachment.
12. **Wave A deviations logged retroactively** (see "Deviations from the
    plan" under Wave A): FrameSample[] generator output; energy-JSON replay
    leg collapsed into clip replay under ADR 0009.

### Disputed findings

None — all twelve findings were confirmed against the code as written.

## Review fixes — test pinning (2026-07-13)

Follow-up fixer pass over the Phase 4 mutation-audit findings (10 surviving
mutations in the detector/harness) plus test pinning of the parallel core
fixer's regression clamp and the composed hover contract. Test files only:
`corpus-harness.test.ts` (NEW, 15 tests — scoring semantics over synthetic
in-memory CorpusEntries, independent of the committed fixtures),
`crossing-detector.test.ts` (+24 boundary pins), `detector-pipeline.test.ts`
(+1 end-to-end hover). No `synthetic-sequences.ts` change was needed — every
pin is expressible with hand-built `FrameSample`s or the existing generator
options. Suite: 546 → 586 tests, typecheck/lint/test green.

All expected values are hand-computed in test comments (no read-back from the
implementation). The two synthetic clips in `corpus-harness.test.ts` use
60×24 px frames (12 strips of exactly 5 columns) with 10 ms pacing so the
event timestamp (90 ms / 80 ms), the median tolerance (10 ms), and the
normalized levels (1.0 / 0.2) are all exact by construction.

### Post-fix mutation table

Every previously-surviving mutation was re-applied (literal source mutation,
targeted vitest run, byte-verified restore — files are untracked, so restores
were checked against an in-memory byte snapshot, then a green full run):

| Mutation | Killed by |
|---|---|
| harness: match tolerance ×10 | corpus-harness: "two frames off is a miss AND … false positive" |
| harness: direction check removed | corpus-harness: "flipped-direction annotation never matches" |
| harness: `pass` ignores falsePositives | corpus-harness: "unannotated emitted event … fails a must-pass clip" |
| harness: `unexpectedPass` hardwired false | corpus-harness: "fully-clean known-limitation reports unexpectedPass" |
| harness: median → max delta | corpus-harness: "one large timestamp gap cannot widen it" |
| harness: tunables triggerLevel default removed | corpus-harness: "config.tunables.triggerLevel reaches the detector" |
| harness: triggerLevel precedence flipped | corpus-harness: "explicit config.detector.triggerLevel overrides" |
| detector: `maxBackstepStrips` 1→2 | detector: "dip of two strips aborts AND awaits quiet" |
| detector: hot trigger `>=`→`>` | detector: "strip at exactly triggerLevel goes hot" |
| detector: `hysteresisRatio` 0.5→0.6 | detector: "exactly 0.5×trigger stays hot" + "flutter down to 0.055" |
| detector: exit `<`→`<=` | detector: "exactly hysteresisRatio × triggerLevel stays hot" |
| detector: `transientStripFraction` 0.7→0.8 | detector: "9 of 12 rejects; 8 does not" |
| detector: transient `>=`→`>` | detector: "exactly fraction × strips rejects (0.5 × 12 = 6)" |
| detector: transient denominator all strips | detector: "zero-pixel strips excluded from the denominator" |
| detector: expiry sets awaitingQuiet | detector: "expiry re-arms immediately … while a strip is still hot" |
| detector: `transientHoldoffMs` 300→100 | detector: "entry transition at t=399 ms starts a candidate: false" |
| detector: pause cap `<=`→`<` | detector: "holds at exactly maxPauseMs elapsed" |
| detector: expiry `>`→`>=` | detector: "completion arriving exactly at maxTraversalMs still emits" |
| detector: `minParticipatingStrips` 3→4 | detector: "exactly minParticipatingStrips (3) … emits" |
| detector: entry zone `<`→`<=` | detector: "transition at strip 2 starts a candidate: false" |
| detector: regression clamp removed (TS#2 pin) | detector: both timestamp-regression clamp tests |
| attach: pipeline never paused (docs#6 pin) | detector-pipeline: end-to-end hover pause/absorb test |
| generator: ground truth ignores drops | detector: "first DELIVERED frame at/past the center boundary" |

### Boundary inclusivity — spec vs implementation

Two boundaries the spec does not decide were pinned to the implemented
behavior and are flagged here rather than silently invented:

- **Transient holdoff at exactly `transientHoldoffMs`:** detection.md says
  starts are "suppressed for transientHoldoffMs"; the code re-allows exactly
  AT the boundary (`t >= holdoffUntil`). Pinned as implemented.
- **Pause at exactly `maxPauseMs` elapsed:** "hard-capped at maxPauseMs"
  doesn't say whether the flag is still up at elapsed == cap; the code keeps
  it up (`<=`). Pinned as implemented.
- (`maxTraversalMs` exactly-at IS spec-decided — "no older than" — and pinned
  as completing.)

One equivalent-mutant note: at the default `transientStripFraction` 0.7 with
12 strips the threshold (8.4) is non-integral, so `>=`→`>` is unkillable at
defaults; the operator is pinned with an exact-boundary config (0.5 × 12 = 6).

## Review fixes — lab UI (2026-07-13)

Fixer pass over the Phase 4 review findings owned by the lab-UI fixer
(`src/ui/lab/**`). Both findings confirmed against the code; none disputed.

1. **Trigger slider min vs detector validator (Medium).** TunablesPanel's
   trigger slider allowed 0; `CrossingDetector` validates `triggerLevel > 0`,
   so slider-at-0 threw in TestModePanel's arm click handler (no error UI)
   and dragging to 0 while armed threw uncaught inside the live-tracking
   `$effect`. Fixed at both layers: slider `min` raised to 0.01 (= step,
   comment pointing at the validator), and TestModePanel clamps every value
   it feeds the detector (`Math.max(0.01, level)` via
   `detectorTriggerLevel()`) at construction AND in the live-tracking effect
   — defends against any future non-slider tunables writer. Audited the
   other sliders against core validators: stripCount (slider min 2 vs
   reducer's ≥ 1 integer), threshold (0–255, no validator; 0 is legal under
   strictly-greater semantics), emaTimeConstantMs (min 50; reducer has no
   validator and `1 − exp(−dt/τ)` is safe for all slider values) — no other
   mismatch.
2. **Trigger-suggestion collection not aborted on settings change (Low).**
   detection.md says the quiet-window observation resets when the scene/ROI
   changes; the in-flight collector kept accumulating across tunables
   updates. Fixed: an `$effect` compares `session.tunables` identity against
   a snapshot taken at collection start (the lab session replaces the object
   wholesale on every update, ROI included, so identity captures all paths)
   and aborts the collection, surfacing "suggestion aborted — settings
   changed". Applying a suggestion cannot self-abort (collection has already
   stopped when the Apply button exists).
3. **Browser-test pinning:** new Chromium capture-rig test in
   `lab.browser.test.ts` asserts the trigger slider min is > 0, arms test
   mode at that minimum without crashing (armed indicator renders), and
   drags away/back to the minimum while armed with the panel surviving.
   Deterministic — no synthetic-crossing waits.

Verification: `typecheck`, `lint`, `test` (546), `test:browser` (17),
`build` all green in one pass after the fixes.

### Disputed findings (lab UI)

None.
